import { httpError, readBody, sendJson } from '../http.js';
import { requireAudio } from '../store.js';
import { buildFeedback } from '../suggestions.js';
import { getProvider } from '../providers/index.js';

const MAX_RECORDING_BYTES = 32 * 1024 * 1024;
const MIN_RECORDING_SECONDS = 0.5;

function isWav(buffer) {
  return (
    buffer.length > 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

export async function assessUnit(req, res, ctx) {
  const record = requireAudio(ctx.params.id);

  if (!record.units || !record.units.length) {
    throw httpError(409, 'NOT_SEGMENTED', '请先完成自动分句，再进行跟读练习');
  }

  const unitIndex = Number(ctx.params.index);
  const unit = record.units[unitIndex];
  if (!unit) {
    throw httpError(404, 'UNIT_NOT_FOUND', '练习单元不存在');
  }

  const reportedDuration = Number(ctx.url.searchParams.get('duration'));
  if (Number.isFinite(reportedDuration) && reportedDuration > 0 && reportedDuration < MIN_RECORDING_SECONDS) {
    throw httpError(422, 'RECORDING_TOO_SHORT', '录音太短，请完整读出整句');
  }

  const audioBuffer = await readBody(req, MAX_RECORDING_BYTES);
  if (audioBuffer.length < 1000) {
    throw httpError(422, 'RECORDING_TOO_SHORT', '录音太短，请完整读出整句');
  }
  if (!isWav(audioBuffer)) {
    throw httpError(415, 'RECORDING_NOT_WAV', '录音格式需为 16kHz 单声道 PCM WAV');
  }

  const provider = getProvider();
  const raw = await provider.assess({
    audioBuffer,
    referenceText: unit.text,
    unitIndex,
    language: record.language
  });

  const feedback = buildFeedback(raw);
  record.results[unitIndex] = { ...feedback, createdAt: new Date().toISOString() };

  sendJson(res, 200, record.results[unitIndex]);
}