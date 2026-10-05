import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from './config.js';

/** 内存态存储。音频文件落盘到 uploads/，元数据与练习结果保存在进程内存中。 */
const audios = new Map();

export function audioFilePath(record) {
  return path.join(UPLOAD_DIR, record.storedName);
}

export function saveAudioBuffer(record, buffer) {
  fs.writeFileSync(audioFilePath(record), buffer);
}

export function readAudioBuffer(record) {
  return fs.readFileSync(audioFilePath(record));
}

export function newId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

export function createAudioRecord({ name, size, format, mimeType, ext, durationSec }) {
  const id = newId('aud_');
  const storedName = id + ext;
  const record = {
    id,
    name,
    size,
    format,
    mimeType,
    storedName,
    durationSec,
    createdAt: new Date().toISOString(),
    language: null,
    confidence: null,
    transcriber: null,
    units: null,
    results: {}
  };
  audios.set(id, record);
  return record;
}

export function getAudio(id) {
  return audios.get(id) || null;
}

export function requireAudio(id) {
  const record = audios.get(id);
  if (!record) {
    const err = new Error('未找到该音频，请重新上传');
    err.status = 404;
    err.code = 'AUDIO_NOT_FOUND';
    throw err;
  }
  return record;
}

export function toPublicAudio(record) {
  return {
    id: record.id,
    name: record.name,
    size: record.size,
    format: record.format,
    durationSec: record.durationSec,
    createdAt: record.createdAt,
    language: record.language,
    confidence: record.confidence,
    transcriber: record.transcriber,
    unitCount: record.units ? record.units.length : 0,
    completedCount: Object.keys(record.results).length,
    units: record.units,
    results: record.results
  };
}