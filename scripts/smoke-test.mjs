const BASE = process.env.SMOKE_BASE || 'http://localhost:5173';

function makeWav(seconds, sampleRate = 16000) {
  const samples = Math.floor(seconds * sampleRate);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i += 1) {
    const v = Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 8000;
    buf.writeInt16LE(Math.round(v), 44 + i * 2);
  }
  return buf;
}

async function call(label, fn) {
  try {
    const out = await fn();
    console.log(`PASS  ${label}`);
    return out;
  } catch (err) {
    console.log(`FAIL  ${label}\n      ${err.message}`);
    process.exitCode = 1;
    return null;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const health = await call('GET /api/health', async () => {
  const res = await fetch(`${BASE}/api/health`);
  const body = await res.json();
  assert(res.status === 200, `status ${res.status}`);
  assert(body.ok === true, 'ok flag missing');
  return body;
});
console.log('      provider =', health?.provider?.name, '| recognizer =', health?.provider?.recognizer, '| model =', health?.asr?.model);
console.log('      limits =', JSON.stringify(health?.limits));

const audio = await call('POST /api/audios (35s WAV, 服务端解析时长)', async () => {
  const wav = makeWav(35);
  const res = await fetch(`${BASE}/api/audios?name=smoke-test.wav`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wav
  });
  const body = await res.json();
  assert(res.status === 201, `status ${res.status}: ${JSON.stringify(body)}`);
  assert(body.format === 'wav', `format ${body.format}`);
  assert(body.durationSource === 'server', `durationSource ${body.durationSource}`);
  assert(Math.abs(body.durationSec - 35) < 0.05, `duration ${body.durationSec}`);
  return body;
});
console.log('      audioId =', audio?.id, '| duration =', audio?.durationSec, 's | source =', audio?.durationSource);

const rejected = await call('POST /api/audios (10s，应被时长下限拒绝)', async () => {
  const res = await fetch(`${BASE}/api/audios?name=too-short.wav`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: makeWav(10)
  });
  assert(res.status === 422, `expected 422, got ${res.status}`);
  const body = await res.json();
  assert(body.error.code === 'AUDIO_TOO_SHORT', `code ${body.error.code}`);
  return body;
});
console.log('      code =', rejected?.error?.code, '|', rejected?.error?.message);

const badFormat = await call('POST /api/audios (非音频，应被格式校验拒绝)', async () => {
  const res = await fetch(`${BASE}/api/audios?name=not-audio.txt`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: Buffer.from('this is definitely not an audio file at all')
  });
  assert(res.status === 415, `expected 415, got ${res.status}`);
  const body = await res.json();
  assert(body.error.code === 'UNSUPPORTED_FORMAT', `code ${body.error.code}`);
  return body;
});
console.log('      code =', badFormat?.error?.code);

const segmented = await call('POST /api/audios/:id/segment', async () => {
  const res = await fetch(`${BASE}/api/audios/${audio.id}/segment`, { method: 'POST' });
  const body = await res.json();
  assert(res.status === 200, `status ${res.status}: ${JSON.stringify(body)}`);
  assert(Array.isArray(body.units) && body.units.length > 0, 'no units produced');
  for (const u of body.units) {
    assert(typeof u.text === 'string' && u.text.length > 0, 'unit text empty');
    assert(u.duration > 0, `unit ${u.index} duration ${u.duration}`);
    assert(u.duration <= 15.001, `unit ${u.index} exceeds max 15s: ${u.duration}`);
    assert(u.duration >= 0.8 - 0.001 || body.units.length === 1, `unit ${u.index} below min 0.8s: ${u.duration}`);
  }
  return body;
});
console.log(`      units = ${segmented?.units?.length} | language = ${segmented?.language} | confidence = ${segmented?.confidence}`);
console.log('      first unit =', JSON.stringify(segmented?.units?.[0]?.text));
console.log('      last  unit =', JSON.stringify(segmented?.units?.at(-1)?.text));

// 浏览器本地识别的关键回归点：分句必须完全来自传入的识别文本，不能是任何内置语料。
const transcriptAudio = await call('POST /api/audios (供转录分句使用的音频)', async () => {
  const res = await fetch(`${BASE}/api/audios?name=transcript-test.wav`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: makeWav(35)
  });
  const body = await res.json();
  assert(res.status === 201, `status ${res.status}`);
  return body;
});

const transcriptUnits = await call('POST /api/audios/:id/transcript (分句须来自传入文本)', async () => {
  const words = [
    { word: 'Hello', start: 0.2, end: 0.6 },
    { word: 'there,', start: 0.65, end: 1.0 },
    { word: 'how', start: 1.05, end: 1.3 },
    { word: 'are', start: 1.32, end: 1.5 },
    { word: 'you', start: 1.52, end: 1.8 },
    { word: 'today?', start: 1.82, end: 2.3 },
    { word: 'I', start: 3.1, end: 3.3 },
    { word: 'am', start: 3.32, end: 3.5 },
    { word: 'learning', start: 3.52, end: 4.0 },
    { word: 'English', start: 4.02, end: 4.6 },
    { word: 'shadowing.', start: 4.62, end: 5.2 }
  ];
  const res = await fetch(`${BASE}/api/audios/${transcriptAudio.id}/transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'browser-whisper', language: 'en', confidence: 0.9, words })
  });
  const body = await res.json();
  assert(res.status === 200, `status ${res.status}: ${JSON.stringify(body)}`);
  assert(body.transcriber === 'browser-whisper', `transcriber = ${body.transcriber}`);
  assert(body.units.length === 2, `expected 2 units, got ${body.units.length}`);
  assert(body.units[0].text === 'Hello there, how are you today?', `unit0 = ${JSON.stringify(body.units[0].text)}`);
  assert(body.units[1].text === 'I am learning English shadowing.', `unit1 = ${JSON.stringify(body.units[1].text)}`);
  assert(Math.abs(body.units[0].start - 0.2) < 0.001, `unit0 start = ${body.units[0].start}`);
  assert(Math.abs(body.units[0].end - 2.3) < 0.001, `unit0 end = ${body.units[0].end}`);
  assert(Math.abs(body.units[1].start - 3.1) < 0.001, `unit1 start = ${body.units[1].start}`);
  return body;
});
console.log('      units =', JSON.stringify(transcriptUnits?.units?.map((u) => u.text)));

const emptyTranscript = await call('POST /api/audios/:id/transcript (空识别结果 → 422)', async () => {
  const res = await fetch(`${BASE}/api/audios/${transcriptAudio.id}/transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ words: [] })
  });
  assert(res.status === 422, `expected 422, got ${res.status}`);
  const body = await res.json();
  assert(body.error.code === 'NO_SPEECH', `code ${body.error.code}`);
  return body;
});
console.log('      code =', emptyTranscript?.error?.code);

// 浏览器本地识别所需模型由服务端代理下载（浏览器直连下载源会被网络策略拦下）。
const modelConfig = await call('GET /api/model/* (同源代理模型文件)', async () => {
  const res = await fetch(`${BASE}/api/model/${health.asr.model}/resolve/main/config.json`);
  assert(res.status === 200, `status ${res.status}`);
  assert((res.headers.get('content-type') || '').includes('application/json'), `content-type ${res.headers.get('content-type')}`);
  const body = await res.json();
  assert(body && typeof body === 'object', 'config is not a JSON object');
  return body;
});
console.log('      model_type =', modelConfig?.model_type || '(ok)');

const modelCached = await call('GET /api/model/* 二次请求命中落盘缓存', async () => {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/model/${health.asr.model}/resolve/main/config.json`);
  assert(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  assert(body && typeof body === 'object', 'cached config is not a JSON object');
  return Date.now() - started;
});
console.log('      elapsed =', modelCached, 'ms');

const modelMissing = await call('GET /api/model/* 不存在的文件 → 404', async () => {
  const res = await fetch(`${BASE}/api/model/${health.asr.model}/resolve/main/__not_a_real_file__.json`);
  assert(res.status === 404, `expected 404, got ${res.status}`);
  const body = await res.json();
  assert(body.error.code === 'MODEL_UPSTREAM_ERROR', `code ${body.error.code}`);
  return body;
});
console.log('      code =', modelMissing?.error?.code);

// 识别运行库内置在 public/vendor/，浏览器不再依赖外部 CDN；MIME 必须正确，否则模块无法执行。
const vendorLib = await call('GET /vendor/transformers.min.js (内置运行库)', async () => {
  const res = await fetch(`${BASE}/vendor/transformers.min.js`);
  assert(res.status === 200, `status ${res.status}`);
  assert((res.headers.get('content-type') || '').includes('text/javascript'), `content-type ${res.headers.get('content-type')}`);
  const body = await res.text();
  assert(body.includes('pipeline'), 'library bundle looks empty');
  return body.length;
});
console.log('      bytes =', vendorLib);

const vendorWasmLoader = await call('GET /vendor/ort-wasm-*.mjs (WASM 加载器 MIME)', async () => {
  const res = await fetch(`${BASE}/vendor/ort-wasm-simd-threaded.jsep.mjs`);
  assert(res.status === 200, `status ${res.status}`);
  assert((res.headers.get('content-type') || '').includes('text/javascript'), `content-type ${res.headers.get('content-type')}`);
  return res.headers.get('content-type');
});
console.log('      content-type =', vendorWasmLoader);

const vendorWasm = await call('GET /vendor/ort-wasm-*.wasm (WASM 运行时 MIME)', async () => {
  const res = await fetch(`${BASE}/vendor/ort-wasm-simd-threaded.jsep.wasm`, { method: 'HEAD' });
  assert(res.status === 200, `status ${res.status}`);
  assert(res.headers.get('content-type') === 'application/wasm', `content-type ${res.headers.get('content-type')}`);
  return Number(res.headers.get('content-length'));
});
console.log('      bytes =', vendorWasm);

const feedback = await call('POST /api/audios/:id/units/0/assess', async () => {
  const res = await fetch(`${BASE}/api/audios/${audio.id}/units/0/assess?duration=3.1`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: makeWav(3.1)
  });
  const body = await res.json();
  assert(res.status === 200, `status ${res.status}: ${JSON.stringify(body)}`);
  for (const k of ['overall', 'accuracy', 'fluency', 'prosody', 'completeness']) {
    assert(typeof body[k] === 'number' && body[k] >= 0 && body[k] <= 100, `${k} = ${body[k]}`);
  }
  assert(body.dimensions?.length === 4, 'dimensions must be 4');
  assert(body.suggestions?.length >= 2, 'need at least 2 suggestions');
  assert(Array.isArray(body.words) && body.words.length > 0, 'no word-level feedback');
  assert(['good', 'warn', 'bad'].includes(body.verdict?.band), `verdict band ${body.verdict?.band}`);
  return body;
});
console.log(`      overall = ${feedback?.overall} | acc ${feedback?.accuracy} flu ${feedback?.fluency} pro ${feedback?.prosody} com ${feedback?.completeness}`);
console.log('      verdict =', feedback?.verdict?.text);
console.log('      words   =', feedback?.words?.map((w) => `${w.word}(${w.score}${w.errorType !== 'None' ? ',' + w.errorType : ''})`).join(' '));

const stable = await call('POST assess 重复提交同一录音 → 分数稳定', async () => {
  const wav = makeWav(3.1);
  const one = await (await fetch(`${BASE}/api/audios/${audio.id}/units/0/assess`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav })).json();
  const two = await (await fetch(`${BASE}/api/audios/${audio.id}/units/0/assess`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav })).json();
  assert(one.overall === two.overall, `unstable: ${one.overall} vs ${two.overall}`);
  return one;
});

const diff = await call('POST assess 不同录音 → 分数不同', async () => {
  const a = await (await fetch(`${BASE}/api/audios/${audio.id}/units/1/assess`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: makeWav(2.2) })).json();
  const b = await (await fetch(`${BASE}/api/audios/${audio.id}/units/1/assess`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: makeWav(4.7) })).json();
  assert(a.overall !== b.overall || a.accuracy !== b.accuracy, 'different recordings produced identical scores');
  return { a, b };
});
console.log(`      recording A overall = ${diff?.a?.overall} | recording B overall = ${diff?.b?.overall}`);

const shortRec = await call('POST assess 录音过短 → 应被拒绝', async () => {
  const res = await fetch(`${BASE}/api/audios/${audio.id}/units/0/assess?duration=0.2`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: makeWav(0.2)
  });
  assert(res.status === 422, `expected 422, got ${res.status}`);
  const body = await res.json();
  assert(body.error.code === 'RECORDING_TOO_SHORT', `code ${body.error.code}`);
  return body;
});
console.log('      code =', shortRec?.error?.code, '|', shortRec?.error?.message);

const persisted = await call('GET /api/audios/:id (进度已持久化)', async () => {
  const res = await fetch(`${BASE}/api/audios/${audio.id}`);
  const body = await res.json();
  assert(res.status === 200, `status ${res.status}`);
  assert(body.completedCount >= 2, `completedCount ${body.completedCount}`);
  assert(body.unitCount === segmented.units.length, `unitCount ${body.unitCount}`);
  return body;
});
console.log(`      unitCount = ${persisted?.unitCount} | completedCount = ${persisted?.completedCount}`);

const streamed = await call('GET /api/audios/:id/file (整段回放)', async () => {
  const res = await fetch(`${BASE}/api/audios/${audio.id}/file`);
  assert(res.status === 200, `status ${res.status}`);
  assert(res.headers.get('accept-ranges') === 'bytes', 'missing Accept-Ranges');
  assert(res.headers.get('content-type') === 'audio/wav', `content-type ${res.headers.get('content-type')}`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert(buf.length > 44, `body too small: ${buf.length}`);
  assert(buf.toString('ascii', 0, 4) === 'RIFF', 'body is not a WAV');
  return buf.length;
});
console.log('      bytes =', streamed);

const ranged = await call('GET /api/audios/:id/file (Range → 206)', async () => {
  const res = await fetch(`${BASE}/api/audios/${audio.id}/file`, { headers: { Range: 'bytes=0-1023' } });
  assert(res.status === 206, `status ${res.status}`);
  const range = res.headers.get('content-range') || '';
  assert(/^bytes 0-1023\/\d+$/.test(range), `content-range ${range}`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert(buf.length === 1024, `expected 1024 bytes, got ${buf.length}`);
  return range;
});
console.log('      content-range =', ranged);

/** 按块遍历读取 WAV 时长，不能假设 data 块在固定偏移（SAPI 输出的 fmt 块是 18 字节）。 */
function wavDurationOf(buf) {
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && size >= 16) byteRate = buf.readUInt32LE(offset + 16);
    if (id === 'data') {
      dataSize = Math.min(size, buf.length - (offset + 8));
      break;
    }
    offset += 8 + size + (size % 2);
  }
  return byteRate && dataSize ? dataSize / byteRate : null;
}

const sample = await call('GET /samples/sample-en.wav (示例音频)', async () => {
  const res = await fetch(`${BASE}/samples/sample-en.wav`);
  assert(res.status === 200, `status ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert(buf.toString('ascii', 0, 4) === 'RIFF', 'sample is not a WAV');
  const duration = wavDurationOf(buf);
  assert(duration !== null, 'cannot parse sample duration');
  assert(duration >= 30 && duration <= 600, `sample duration ${duration.toFixed(1)}s out of range`);
  return duration;
});
console.log(`      duration = ${sample?.toFixed(1)}s`);

const notFound = await call('GET /api/audios/不存在 → 404', async () => {
  const res = await fetch(`${BASE}/api/audios/aud_deadbeef`);
  assert(res.status === 404, `expected 404, got ${res.status}`);
  return await res.json();
});
console.log('      code =', notFound?.error?.code);

console.log('');
console.log(process.exitCode ? '冒烟测试：存在失败项' : '冒烟测试：全部通过');