/**
 * 浏览器本地语音识别（Whisper）。
 *
 * 为什么放浏览器：不需要任何云端凭据就能做真实识别，服务端因此可以继续保持零依赖。
 * 运行库与模型都按需从 CDN 拉取，首次使用需联网下载约 70MB，之后由浏览器缓存，可离线复用。
 * 识别结果只带词与时间戳，分句规则仍由服务端统一执行。
 */

import { resample } from './wav.js';

const LIB_VERSION = '3.7.6';
const LIB_DIST = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${LIB_VERSION}/dist/`;
const LIB_ENTRY = `${LIB_DIST}transformers.min.js`;

const FALLBACK_OPTIONS = {
  model: 'Xenova/whisper-tiny.en',
  encoderDtype: 'fp32',
  proxyBase: '/api/model'
};

let libPromise = null;
let pipelinePromise = null;
let pipelineKey = '';

export function isSupported() {
  return typeof WebAssembly === 'object' && typeof fetch === 'function';
}

function loadLib() {
  if (!libPromise) {
    libPromise = import(LIB_ENTRY).catch((err) => {
      libPromise = null;
      throw new Error(`无法加载本地识别运行库，请检查网络能否访问 CDN：${err.message}`);
    });
  }
  return libPromise;
}

/** 把 transformers.js 的逐文件进度聚合成一个总百分比。 */
function makeProgressHandler(onLabel) {
  const files = new Map();
  return (event) => {
    if (!event || !event.file) return;
    if (event.status === 'progress' && Number.isFinite(event.total) && event.total > 0) {
      files.set(event.file, { loaded: Number(event.loaded) || 0, total: event.total });
      let loaded = 0;
      let total = 0;
      for (const item of files.values()) {
        loaded += item.loaded;
        total += item.total;
      }
      onLabel(`下载识别模型 ${Math.round((loaded / total) * 100)}%`);
      return;
    }
    if (event.status === 'ready') onLabel('识别模型已就绪');
  };
}

async function getPipeline(options, onLabel) {
  const key = `${options.model}|${options.proxyBase}|${options.encoderDtype}`;
  if (pipelinePromise && pipelineKey === key) return pipelinePromise;

  pipelineKey = key;
  pipelinePromise = (async () => {
    const { pipeline, env } = await loadLib();

    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    // 模型文件经同源代理下载：浏览器直连 hf-mirror 会被网络策略拦下（fetch 直接失败），
    // 由服务端代取并落盘缓存后，浏览器只需访问 localhost。
    const proxyBase = String(options.proxyBase || FALLBACK_OPTIONS.proxyBase).replace(/^\/+|\/+$/g, '');
    env.remoteHost = location.origin + '/';
    env.remotePathTemplate = `${proxyBase}/{model}/resolve/{revision}/`;
    try {
      if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
        env.backends.onnx.wasm.wasmPaths = LIB_DIST;
      }
    } catch {
      /* 形状不符时保留运行库默认的 CDN 路径 */
    }

    return pipeline('automatic-speech-recognition', options.model, {
      dtype: { encoder_model: options.encoderDtype, decoder_model_merged: 'q8' },
      device: 'wasm',
      progress_callback: makeProgressHandler(onLabel)
    });
  })();

  try {
    return await pipelinePromise;
  } catch (err) {
    pipelinePromise = null;
    pipelineKey = '';
    throw new Error(`识别模型加载失败，首次使用需联网下载约 70MB：${err.message}`);
  }
}

function monoMix(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  if (channels === 1) return audioBuffer.getChannelData(0);
  const length = audioBuffer.length;
  const out = new Float32Array(length);
  for (let c = 0; c < channels; c += 1) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) out[i] += data[i];
  }
  for (let i = 0; i < length; i += 1) out[i] /= channels;
  return out;
}

/** 转成 Whisper 需要的 16kHz 单声道 Float32。优先用 OfflineAudioContext，自带高质量重采样与混音。 */
export async function toWhisperInput(audioBuffer, targetRate = 16000) {
  if (typeof OfflineAudioContext !== 'undefined') {
    try {
      const frames = Math.max(1, Math.ceil((audioBuffer.length / audioBuffer.sampleRate) * targetRate));
      const offline = new OfflineAudioContext(1, frames, targetRate);
      const source = offline.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(offline.destination);
      source.start();
      const rendered = await offline.startRendering();
      return rendered.getChannelData(0);
    } catch {
      /* 回退到线性重采样 */
    }
  }
  return resample(monoMix(audioBuffer), audioBuffer.sampleRate, targetRate);
}

/** 只保留带有效时间戳的词；置信度模型不提供，交给服务端用默认值。 */
function normalize(output) {
  const raw = Array.isArray(output) ? output[0] : output;
  const chunks = Array.isArray(raw && raw.chunks) ? raw.chunks : [];
  const words = [];

  for (const chunk of chunks) {
    const text = String(chunk.text || '').trim();
    if (!text) continue;
    const start = chunk.timestamp ? chunk.timestamp[0] : null;
    const end = chunk.timestamp ? chunk.timestamp[1] : null;
    if (!Number.isFinite(start)) continue;
    words.push({
      word: text,
      start,
      end: Number.isFinite(end) && end > start ? end : start + 0.02,
      confidence: 0.9
    });
  }

  return {
    provider: 'browser-whisper',
    language: 'en',
    confidence: 0.9,
    text: String((raw && raw.text) || '').trim(),
    words
  };
}

export async function transcribe(pcm, options = {}, onLabel = () => {}) {
  if (!isSupported()) {
    throw new Error('当前浏览器不支持 WebAssembly，无法使用本地识别，请改用 Chrome 或 Edge');
  }

  const settings = { ...FALLBACK_OPTIONS, ...options };
  const pipe = await getPipeline(settings, onLabel);
  onLabel('识别中…');

  const output = await pipe(pcm, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: 'word'
  });

  return normalize(output);
}