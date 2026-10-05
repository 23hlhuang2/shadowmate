import { httpError } from './http.js';

/**
 * 通过文件头魔数识别音频格式，而不是信任客户端声明的 MIME。
 * PRD 表 5：仅接受 MP3 / WAV / M4A。
 */
const SIGNATURES = [
  {
    format: 'mp3',
    ext: '.mp3',
    mimeType: 'audio/mpeg',
    test: (b) =>
      (b.length > 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) ||
      (b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)
  },
  {
    format: 'wav',
    ext: '.wav',
    mimeType: 'audio/wav',
    test: (b) =>
      b.length > 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WAVE'
  },
  {
    format: 'm4a',
    ext: '.m4a',
    mimeType: 'audio/mp4',
    test: (b) => b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp'
  }
];

export function detectFormat(buffer) {
  if (!buffer || buffer.length < 4) return null;
  return SIGNATURES.find((sig) => sig.test(buffer)) || null;
}

/** WAV 的时长可以直接从头文件算出来，用于服务端交叉校验。 */
function wavDuration(buffer) {
  if (buffer.length < 44) return null;
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    // fmt 块布局：audioFormat@+8, channels@+10, sampleRate@+12, byteRate@+16
    if (id === 'fmt ' && size >= 16 && offset + 20 <= buffer.length) {
      byteRate = buffer.readUInt32LE(offset + 16);
    }
    if (id === 'data') {
      const available = buffer.length - (offset + 8);
      dataSize = Math.min(size, available);
      break;
    }
    offset += 8 + size + (size % 2);
  }

  if (!byteRate || !dataSize) return null;
  return dataSize / byteRate;
}

export function probeDuration(buffer, format) {
  if (format === 'wav') return wavDuration(buffer);
  return null;
}

export function validateUpload({ buffer, format, clientDurationSec, limits }) {
  if (!buffer || buffer.length === 0) {
    throw httpError(400, 'EMPTY_FILE', '未检测到有效音轨，请重新选择文件');
  }
  if (buffer.length > limits.maxUploadBytes) {
    const mb = Math.round(limits.maxUploadBytes / 1048576);
    throw httpError(413, 'FILE_TOO_LARGE', `文件超过 ${mb}MB，请先裁剪后再上传`);
  }
  if (!format) {
    throw httpError(415, 'UNSUPPORTED_FORMAT', '仅支持 MP3 / WAV / M4A 格式的音频');
  }

  const serverDuration = probeDuration(buffer, format.format);
  const durationSec = serverDuration ?? clientDurationSec ?? null;

  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw httpError(422, 'DURATION_UNKNOWN', '无法解析音频时长，请更换文件或使用 WAV 格式');
  }
  if (durationSec < limits.minSeconds) {
    throw httpError(422, 'AUDIO_TOO_SHORT', `音频时长需不少于 ${limits.minSeconds} 秒`);
  }
  if (durationSec > limits.maxSeconds) {
    throw httpError(422, 'AUDIO_TOO_LONG', `音频时长需在 ${Math.round(limits.maxSeconds / 60)} 分钟以内`);
  }

  return { durationSec, durationSource: serverDuration != null ? 'server' : 'client' };
}