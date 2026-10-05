import { config } from '../config.js';
import { httpError, readBody, readJson, sendJson } from '../http.js';
import { detectFormat, validateUpload } from '../audioFormat.js';
import {
  createAudioRecord,
  readAudioBuffer,
  requireAudio,
  saveAudioBuffer,
  toPublicAudio
} from '../store.js';
import { flattenPhrases, segmentWords } from '../segmenter.js';
import { getProvider } from '../providers/index.js';

const MAX_UNITS = 200;
const MAX_TRANSCRIPT_WORDS = 20000;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

export async function createAudio(req, res, ctx) {
  const name = (ctx.url.searchParams.get('name') || '未命名音频').slice(0, 200);
  const rawDuration = Number(ctx.url.searchParams.get('duration'));
  const clientDurationSec = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null;

  const buffer = await readBody(req, config.limits.maxUploadBytes + 1);
  const detected = detectFormat(buffer);

  const { durationSec, durationSource } = validateUpload({
    buffer,
    format: detected,
    clientDurationSec,
    limits: config.limits
  });

  const record = createAudioRecord({
    name,
    size: buffer.length,
    format: detected.format,
    mimeType: detected.mimeType,
    ext: detected.ext,
    durationSec: Math.round(durationSec * 1000) / 1000
  });
  saveAudioBuffer(record, buffer);

  sendJson(res, 201, { ...toPublicAudio(record), durationSource });
}

export async function getAudio(req, res, ctx) {
  const record = requireAudio(ctx.params.id);
  sendJson(res, 200, toPublicAudio(record));
}

/** 回放原始音频。支持 Range 请求，浏览器才能拖动波形跳转播放位置。 */
export function getAudioFile(req, res, ctx) {
  const record = requireAudio(ctx.params.id);
  const buffer = readAudioBuffer(record);
  const total = buffer.length;
  const type = record.mimeType || 'application/octet-stream';

  const match = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim());
  if (match) {
    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : total - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;

    if (start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    });
    res.end(buffer.subarray(start, end + 1));
    return;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  });
  res.end(buffer);
}

export async function segmentAudio(req, res, ctx) {
  const record = requireAudio(ctx.params.id);
  const buffer = readAudioBuffer(record);
  const provider = getProvider();

  const result = await provider.transcribe({ audio: record, buffer });
  const words = result.words || flattenPhrases(result.phrases);

  if (!words.length) {
    throw httpError(422, 'NO_SPEECH', '未识别到有效语音内容，请更换音频文件后重试');
  }

  const units = segmentWords(words);
  if (!units.length) {
    throw httpError(422, 'NO_UNITS', '分句结果为空，请更换音频文件后重试');
  }
  if (units.length > MAX_UNITS) {
    throw httpError(422, 'TOO_MANY_UNITS', `分句数量超过 ${MAX_UNITS} 句，请裁剪音频后重新上传`);
  }

  record.language = result.language;
  record.confidence = result.confidence;
  record.transcriber = result.provider || config.provider;
  record.units = units;
  record.results = {};

  sendJson(res, 200, toPublicAudio(record));
}

/**
 * 接收浏览器本地 Whisper 的识别结果并分句。
 * 分句规则留在服务端，保证「本地识别」与「云端识别」得到完全一致的分句行为。
 */
export async function submitTranscript(req, res, ctx) {
  const record = requireAudio(ctx.params.id);
  const body = await readJson(req, MAX_TRANSCRIPT_BYTES);

  const incoming = Array.isArray(body.words) && body.words.length ? body.words : flattenPhrases(body.phrases);
  const words = incoming
    .map((word) => ({
      word: String(word.word ?? word.text ?? '').trim(),
      start: Number(word.start),
      end: Number(word.end),
      confidence: Number.isFinite(Number(word.confidence)) ? Number(word.confidence) : 0.9
    }))
    .filter((word) => word.word && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start)
    .sort((a, b) => a.start - b.start);

  if (!words.length) {
    throw httpError(422, 'NO_SPEECH', '未识别到有效语音内容，请更换音频文件后重试');
  }
  if (words.length > MAX_TRANSCRIPT_WORDS) {
    throw httpError(422, 'TOO_MANY_WORDS', '识别结果过长，请裁剪音频后重新上传');
  }

  const units = segmentWords(words);
  if (!units.length) {
    throw httpError(422, 'NO_UNITS', '分句结果为空，请更换音频文件后重试');
  }
  if (units.length > MAX_UNITS) {
    throw httpError(422, 'TOO_MANY_UNITS', `分句数量超过 ${MAX_UNITS} 句，请裁剪音频后重新上传`);
  }

  record.language = typeof body.language === 'string' && body.language ? body.language : 'en';
  record.confidence = Number.isFinite(Number(body.confidence)) ? Number(body.confidence) : null;
  record.transcriber = typeof body.provider === 'string' && body.provider ? body.provider.slice(0, 40) : 'browser-whisper';
  record.units = units;
  record.results = {};

  sendJson(res, 200, toPublicAudio(record));
}