import { config } from '../config.js';
import { httpError } from '../http.js';

/**
 * Azure AI 语音服务提供方。
 *
 * 识别：Fast Transcription REST API，返回词级时间戳与置信度，用于自动分句。
 * 评测：发音评估 REST API（脚本化评估），返回准确度 / 流利度 / 完整性 / 语调四项子分数与逐词结果。
 *
 * 注意：发音评估接口要求音频为 16kHz、16bit、单声道 PCM WAV。前端录音模块
 * （public/js/recorder.js）正是按这个规格录制并上传的，因此无需额外转码。
 */

const TRANSCRIBE_API_VERSION = '2024-11-15';

function credentials() {
  const { key, region, language } = config.azure;
  if (!key || !region) {
    throw httpError(
      503,
      'AZURE_NOT_CONFIGURED',
      '未配置 Azure 语音服务凭据，请在 .env 中填写 AZURE_SPEECH_KEY 与 AZURE_SPEECH_REGION，或将 SPEECH_PROVIDER 设回 mock'
    );
  }
  return { key, region, language };
}

async function describeFailure(res) {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

export async function transcribe({ audio, buffer }) {
  const { key, region, language } = credentials();
  const url =
    `https://${region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe` +
    `?api-version=${TRANSCRIBE_API_VERSION}`;

  const form = new FormData();
  form.append('audio', new Blob([buffer], { type: audio.mimeType || 'audio/mpeg' }), audio.storedName);
  form.append(
    'definition',
    JSON.stringify({
      locales: [language],
      profanityFilterMode: 'None',
      channels: [0]
    })
  );

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key },
    body: form
  });

  if (!res.ok) {
    throw httpError(502, 'AZURE_TRANSCRIBE_FAILED', `语音识别失败（HTTP ${res.status}）`, {
      detail: await describeFailure(res)
    });
  }

  const data = await res.json();
  const phrases = (data.phrases || []).map((phrase) => ({
    text: phrase.text || '',
    words: (phrase.words || []).map((word) => ({
      word: word.text || '',
      start: (word.offsetMilliseconds ?? 0) / 1000,
      end: ((word.offsetMilliseconds ?? 0) + (word.durationMilliseconds ?? 0)) / 1000,
      confidence: word.confidence ?? 0.9
    }))
  }));

  const confidences = phrases.flatMap((p) => p.words.map((w) => w.confidence));
  const confidence = confidences.length
    ? confidences.reduce((sum, v) => sum + v, 0) / confidences.length
    : 0.9;

  return {
    provider: 'azure',
    language,
    durationSec: (data.durationMilliseconds ?? audio.durationSec * 1000) / 1000,
    confidence: Math.round(confidence * 1000) / 1000,
    phrases
  };
}

export async function assess({ audioBuffer, referenceText }) {
  const { key, region, language } = credentials();

  const assessmentConfig = {
    ReferenceText: referenceText,
    GradingSystem: 'HundredMark',
    Granularity: 'Word',
    Dimension: 'Comprehensive',
    EnableMiscue: false
  };
  const assessmentHeader = Buffer.from(JSON.stringify(assessmentConfig), 'utf8').toString('base64');

  const url =
    `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
    `?language=${encodeURIComponent(language)}&format=detailed`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
      'Pronunciation-Assessment': assessmentHeader,
      Accept: 'application/json'
    },
    body: audioBuffer
  });

  if (!res.ok) {
    throw httpError(502, 'AZURE_ASSESS_FAILED', `发音评测失败（HTTP ${res.status}）`, {
      detail: await describeFailure(res)
    });
  }

  const data = await res.json();

  if (data.RecognitionStatus && data.RecognitionStatus !== 'Success') {
    throw httpError(422, 'AZURE_NO_SPEECH', '没有检测到你的声音，请重新录音', {
      recognitionStatus: data.RecognitionStatus
    });
  }

  const best = data.NBest && data.NBest[0];
  if (!best || !best.PronunciationAssessment) {
    throw httpError(422, 'AZURE_NO_ASSESSMENT', '本次未返回评测结果，请重新录音后再试');
  }

  const pa = best.PronunciationAssessment;
  const words = (best.Words || []).map((word) => ({
    word: word.Word || '',
    score: Math.round(word.PronunciationAssessment?.AccuracyScore ?? 0),
    errorType: word.PronunciationAssessment?.ErrorType || 'None'
  }));

  return {
    provider: 'azure',
    referenceText,
    overall: Math.round(pa.PronScore ?? pa.AccuracyScore ?? 0),
    accuracy: Math.round(pa.AccuracyScore ?? 0),
    fluency: Math.round(pa.FluencyScore ?? 0),
    prosody: Math.round(pa.ProsodyScore ?? pa.AccuracyScore ?? 0),
    completeness: Math.round(pa.CompletenessScore ?? 0),
    words,
    confidence: 0.95,
    recognizedText: best.Display || best.Lexical || ''
  };
}