import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile() {
  const file = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const MODEL_CACHE_DIR = path.join(DATA_DIR, 'models');

export const config = {
  port: num(process.env.PORT, 5173),
  provider: (process.env.SPEECH_PROVIDER || 'mock').toLowerCase(),
  azure: {
    key: process.env.AZURE_SPEECH_KEY || '',
    region: process.env.AZURE_SPEECH_REGION || '',
    language: process.env.AZURE_SPEECH_LANGUAGE || 'en-US'
  },
  // 浏览器本地识别（Whisper）。模型文件由服务端代理下载（见 routes/models.js），
  // 因为浏览器直连下载源常被网络策略拦下；host 是服务端使用的上游地址。
  asr: {
    model: process.env.WHISPER_MODEL || 'Xenova/whisper-tiny.en',
    host: process.env.WHISPER_MODEL_HOST || 'https://hf-mirror.com',
    encoderDtype: process.env.WHISPER_ENCODER_DTYPE || 'fp32'
  },
  limits: {
    maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 50) * 1024 * 1024,
    minSeconds: num(process.env.MIN_AUDIO_SECONDS, 30),
    maxSeconds: num(process.env.MAX_AUDIO_SECONDS, 600)
  }
};

export function ensureDirs() {
  for (const dir of [UPLOAD_DIR, DATA_DIR, MODEL_CACHE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}