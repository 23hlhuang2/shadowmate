import * as api from './api.js';
import { WavRecorder } from './recorder.js';
import { decode, peaksForRange, renderWave, setPlayed } from './waveform.js';
import { toWhisperInput, transcribe } from './transcribe.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PLAY_ICON = '<path d="M8 5v14l11-7z"/>';
const PAUSE_ICON = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
const RING_CIRCUMFERENCE = 2 * Math.PI * 62;
const METER_BARS = 28;
const WAVE_BUCKETS = 160;

let limits = { maxUploadMb: 50, minAudioSeconds: 30, maxAudioSeconds: 600 };

const state = {
  audio: null,
  units: [],
  results: {},
  current: 0,
  audioBuffer: null,
  recorder: null,
  recording: false,
  meterRaf: 0,
  timerRaf: 0,
  recStartedAt: 0,
  recUrl: null,
  lastRecording: null,
  uploadController: null,
  speed: 1,
  submitting: false,
  recognizer: 'browser-whisper',
  asr: { model: 'Xenova/whisper-tiny.en', proxyBase: '/api/model', encoderDtype: 'fp32' }
};

/* ---------------------------------------------------------------- 通用 UI */

let toastTimer = 0;
function toast(message, kind) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('is-error', kind === 'error');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, kind === 'error' ? 4600 : 2800);
}

const VIEWS = ['viewUpload', 'viewSegment', 'viewWorkspace'];
function showView(id) {
  for (const view of VIEWS) $(view).hidden = view !== id;
}

function formatBytes(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function formatSeconds(sec) {
  return sec.toFixed(1) + 's';
}

function bandClass(value) {
  if (value >= 85) return 'is-good';
  if (value >= 70) return 'is-warn';
  return 'is-bad';
}

function scoreBand(score) {
  if (score >= 85) return 'good';
  if (score >= 70) return 'warn';
  return 'bad';
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/* ------------------------------------------------------------ 上传与校验 */

function showUploadError(message) {
  const el = $('uploadAlert');
  el.textContent = message;
  el.hidden = false;
  $('dz').classList.add('is-invalid');
}

function clearUploadError() {
  $('uploadAlert').hidden = true;
  $('dz').classList.remove('is-invalid');
}

function wavDurationFromHeader(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 44) return null;
  if (view.getUint32(0, false) !== 0x52494646) return null;
  if (view.getUint32(8, false) !== 0x57415645) return null;

  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && size >= 16 && offset + 20 <= buffer.byteLength) {
      byteRate = view.getUint32(offset + 16, true);
    }
    if (id === 'data') {
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || !dataSize) return null;
  return dataSize / byteRate;
}

async function probeDuration(file) {
  if (extensionOf(file.name) === 'wav') {
    const head = await file.slice(0, 65536).arrayBuffer();
    const duration = wavDurationFromHeader(head);
    if (duration) return duration;
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    const finish = (fn, arg) => {
      URL.revokeObjectURL(url);
      fn(arg);
    };
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) finish(resolve, audio.duration);
      else finish(reject, new Error('无法解析音频时长，请更换文件或改用 WAV 格式'));
    };
    audio.onerror = () => finish(reject, new Error('无法解析音频时长，请更换文件或改用 WAV 格式'));
    audio.src = url;
  });
}

async function handleFile(file) {
  clearUploadError();
  const ext = extensionOf(file.name);

  if (!['mp3', 'wav', 'm4a'].includes(ext)) {
    showUploadError('仅支持 MP3 / WAV / M4A 格式的音频，请重新选择文件');
    return;
  }
  if (file.size > limits.maxUploadMb * 1048576) {
    showUploadError(`文件超过 ${limits.maxUploadMb}MB，请先裁剪后再上传`);
    return;
  }

  let duration;
  try {
    duration = await probeDuration(file);
  } catch (err) {
    showUploadError(err.message);
    return;
  }
  if (duration < limits.minAudioSeconds) {
    showUploadError(`音频时长需不少于 ${limits.minAudioSeconds} 秒，当前约 ${duration.toFixed(1)} 秒`);
    return;
  }
  if (duration > limits.maxAudioSeconds) {
    showUploadError(`音频时长需在 ${Math.round(limits.maxAudioSeconds / 60)} 分钟以内，当前约 ${duration.toFixed(0)} 秒`);
    return;
  }

  renderFileCard(file, ext, duration);
  await upload(file, duration);
}

function renderFileCard(file, ext, duration) {
  $('fileIco').textContent = ext;
  $('fileName').textContent = file.name;
  $('fileMeta').textContent = `${formatBytes(file.size)} · 时长 ${formatSeconds(duration)}`;
  $('fileCard').hidden = false;
  setProgress(0, '准备上传', false);
}

function setProgress(ratio, status, done) {
  $('upFill').style.width = Math.round(ratio * 100) + '%';
  $('upFill').classList.toggle('is-done', Boolean(done));
  $('upStatus').textContent = status;
  $('upPct').textContent = Math.round(ratio * 100) + '%';
}

async function upload(file, duration) {
  state.uploadController = new AbortController();
  const signal = state.uploadController.signal;
  $('cancelUploadBtn').disabled = false;
  $('chooseBtn').disabled = true;
  $('sampleBtn').disabled = true;

  try {
    const record = await api.uploadAudio(
      file,
      duration,
      (ratio) => setProgress(ratio * 0.9, `上传中 ${Math.round(ratio * 100)}%`, false),
      signal
    );
    setProgress(1, '上传完成，准备分句', true);
    $('cancelUploadBtn').disabled = true;
    $('newAudioBtn').hidden = false;
    await sleep(320);
    state.audio = record;
    state.units = record.units || [];
    state.results = record.results || {};
    state.current = 0;
    await runSegmentation();
  } catch (err) {
    if (err.code === 'ABORTED') {
      setProgress(0, '已取消上传', false);
      $('fileCard').hidden = true;
      toast('已取消上传');
    } else {
      setProgress(0, '上传失败', false);
      showUploadError(err.message);
    }
  } finally {
    state.uploadController = null;
    $('chooseBtn').disabled = false;
    $('sampleBtn').disabled = false;
    $('cancelUploadBtn').disabled = false;
  }
}

/* ---------------------------------------------------------------- 自动分句 */

function setStep(step, status, timeText) {
  const li = $('segSteps').querySelector(`li[data-step="${step}"]`);
  if (!li) return;
  li.classList.toggle('active', status === 'active');
  li.classList.toggle('done', status === 'done');
  const time = li.querySelector('.st-time');
  if (time && timeText) time.textContent = timeText;
}

function resetSteps() {
  setStep(1, 'done', '已完成');
  setStep(2, 'idle', '等待');
  setStep(3, 'idle', '等待');
  setStep(4, 'idle', '等待');
}

function showSegmentError(message) {
  const el = $('segError');
  el.textContent = message;
  el.hidden = false;
  $('segErrorActions').hidden = false;
  $('segTitle').textContent = '分句没有成功';
  $('segSubtitle').textContent = '可以重试一次，或换一段音频重新开始。';
}

async function runSegmentation() {
  showView('viewSegment');
  $('segError').hidden = true;
  $('segErrorActions').hidden = true;
  $('segTitle').textContent = '正在分析音频';
  $('segSubtitle').textContent =
    state.recognizer === 'azure'
      ? '正在用 Azure 语音服务识别音频内容并切分句子，请稍候。'
      : '正在用浏览器本地 Whisper 识别音频内容。首次使用需下载约 70MB 模型，之后会缓存并可离线复用。';
  resetSteps();

  let failedStep = 2;

  try {
    let data;

    if (state.recognizer === 'azure') {
      setStep(2, 'active', '云端识别中');
      data = await api.segmentAudio(state.audio.id);
      setStep(2, 'done', '识别完成');
    } else {
      setStep(2, 'active', '准备识别模型');
      const audioBuffer = await ensureAudioBuffer();
      const pcm = await toWhisperInput(audioBuffer);
      const transcript = await transcribe(pcm, state.asr, (label) => setStep(2, 'active', label));

      if (!transcript.words.length) {
        throw new Error('没有识别到语音内容，请确认音频里有清晰的英文人声');
      }

      setStep(2, 'done', `识别 ${transcript.words.length} 词`);
      failedStep = 3;
      setStep(3, 'active', '切分中');
      data = await api.submitTranscript(state.audio.id, transcript);
    }

    state.audio = data;
    state.units = data.units || [];
    state.results = data.results || {};

    setStep(3, 'done', `共 ${state.units.length} 句`);
    setStep(4, 'active', '对齐中');
    await sleep(240);
    setStep(4, 'done', '完成');

    await sleep(280);
    enterWorkspace();
  } catch (err) {
    setStep(failedStep, 'idle', '失败');
    showSegmentError(err.message);
  }
}

/* ---------------------------------------------------------------- 工作区 */

function enterWorkspace() {
  $('newAudioBtn').hidden = false;
  showView('viewWorkspace');
  renderList();
  updateProgress();
  const firstUnfinished = state.units.findIndex((unit, index) => !state.results[index]);
  selectUnit(firstUnfinished === -1 ? 0 : firstUnfinished);
  warmUpWaveform();
}

async function warmUpWaveform() {
  try {
    await ensureAudioBuffer();
    const unit = currentUnit();
    if (unit) renderUnitWaveform(unit);
  } catch {
    toast('波形图解析失败，但播放与跟读不受影响');
  }
}

async function ensureAudioBuffer() {
  if (state.audioBuffer || !state.audio) return state.audioBuffer;
  const res = await fetch(api.audioFileUrl(state.audio.id));
  if (!res.ok) throw new Error('无法加载原始音频');
  const raw = await res.arrayBuffer();
  state.audioBuffer = await decode(raw);
  return state.audioBuffer;
}

function renderList() {
  const list = $('sentList');
  const fragment = document.createDocumentFragment();
  state.units.forEach((unit, index) => {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sent-row';
    row.dataset.index = String(index);

    const idx = document.createElement('span');
    idx.className = 'sent-idx';
    idx.textContent = String(index + 1).padStart(2, '0');

    const text = document.createElement('span');
    text.className = 'sent-text';
    text.textContent = unit.text;

    const dur = document.createElement('span');
    dur.className = 'sent-dur';
    dur.textContent = formatSeconds(unit.duration);

    const score = document.createElement('span');
    score.className = 'sent-score is-empty';
    score.textContent = '—';

    row.append(idx, text, dur, score);
    row.addEventListener('click', () => selectUnit(index));
    li.appendChild(row);
    fragment.appendChild(li);
  });
  list.replaceChildren(fragment);
  $('listCount').textContent = `${state.units.length} 句`;
}

function updateListScore(index, feedback) {
  const row = $('sentList').querySelector(`.sent-row[data-index="${index}"]`);
  if (!row) return;
  const score = row.querySelector('.sent-score');
  score.textContent = String(feedback.overall);
  score.className = `sent-score ${bandClass(feedback.overall)}`;
}

function updateProgress() {
  const total = state.units.length;
  const done = Object.keys(state.results).length;
  $('listFill').style.width = total ? (done / total) * 100 + '%' : '0%';
  $('listVal').textContent = `${done} / ${total}`;
}

function selectUnit(index) {
  if (!state.units.length) return;
  const safeIndex = Math.max(0, Math.min(index, state.units.length - 1));
  state.current = safeIndex;
  const unit = state.units[safeIndex];

  $('sentList')
    .querySelectorAll('.sent-row')
    .forEach((row) => row.classList.toggle('is-active', Number(row.dataset.index) === safeIndex));

  $('pIdx').textContent = '#' + String(safeIndex + 1).padStart(2, '0');
  $('pText').textContent = unit.text;
  $('paneCount').textContent = `#${String(safeIndex + 1).padStart(2, '0')} / ${state.units.length}`;

  discardRecording();
  clearRecording();
  pauseOriginal();

  const audio = $('audioEl');
  const src = api.audioFileUrl(state.audio.id);
  if (audio.getAttribute('src') !== src) {
    audio.src = src;
    audio.load();
  }
  audio.playbackRate = state.speed;
  try {
    audio.currentTime = unit.start;
  } catch {
    /* 元数据尚未就绪，播放时会再次对齐 */
  }

  $('playTime').textContent = `0.0s / ${formatSeconds(unit.duration)}`;
  $('playhead').style.left = '0%';
  $('playhead').classList.add('is-on');

  renderUnitWaveform(unit);

  // 已练过的句子保留成绩：切回来时原样恢复评分与反馈，直到重录并提交才刷新。
  const saved = state.results[safeIndex];
  if (saved) {
    renderFeedback(saved, { animate: false, scroll: false });
  } else {
    $('fbPanel').hidden = true;
    $('fbEmpty').hidden = false;
    $('fbEmpty').textContent = '完成一次跟读并点击「提交评测」，这里会显示四维评分、逐词反馈与改进建议。';
  }
}

function renderUnitWaveform(unit) {
  const bars = $('playBars');
  if (!state.audioBuffer) {
    renderWave(bars, new Float32Array(WAVE_BUCKETS), 6);
    return;
  }
  const peaks = peaksForRange(state.audioBuffer, unit.start, unit.end, WAVE_BUCKETS);
  renderWave(bars, peaks, 6);
  syncPlayhead();
}

/* ---------------------------------------------------------------- 播放器 */

function pauseOriginal() {
  const audio = $('audioEl');
  if (!audio.paused) audio.pause();
  updatePlayIcon();
}

function updatePlayIcon() {
  const playing = !$('audioEl').paused;
  $('playIcon').innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
}

function currentUnit() {
  return state.units[state.current];
}

async function togglePlay() {
  const audio = $('audioEl');
  const unit = currentUnit();
  if (!unit) return;

  if (!audio.paused) {
    audio.pause();
    updatePlayIcon();
    return;
  }
  await stopRecording();
  if (audio.currentTime < unit.start || audio.currentTime >= unit.end - 0.02) {
    audio.currentTime = unit.start;
  }
  audio.playbackRate = state.speed;
  audio.play().catch(() => toast('播放失败，请再点一次', 'error'));
  updatePlayIcon();
}

function syncPlayhead() {
  const audio = $('audioEl');
  const unit = currentUnit();
  if (!unit) return;
  const span = Math.max(0.01, unit.end - unit.start);
  const ratio = Math.max(0, Math.min(1, (audio.currentTime - unit.start) / span));
  $('playhead').style.left = ratio * 100 + '%';
  $('playhead').classList.add('is-on');
  setPlayed($('playBars'), ratio);
  $('playTime').textContent = `${formatSeconds(Math.max(0, audio.currentTime - unit.start))} / ${formatSeconds(unit.duration)}`;
}

function onTimeUpdate() {
  const audio = $('audioEl');
  const unit = currentUnit();
  if (!unit) return;
  if (audio.currentTime >= unit.end) {
    // 播到本句结尾就停下，不循环；再次点击播放会从句首重放。
    audio.pause();
    if (audio.currentTime !== unit.end) audio.currentTime = unit.end;
    syncPlayhead();
    updatePlayIcon();
    return;
  }
  syncPlayhead();
}

function seekFromEvent(event) {
  const unit = currentUnit();
  if (!unit) return;
  const rect = $('playTrack').getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  $('audioEl').currentTime = unit.start + ratio * (unit.end - unit.start);
  syncPlayhead();
}

function setSpeed(value) {
  state.speed = value;
  $('audioEl').playbackRate = value;
  $('speedGroup')
    .querySelectorAll('button')
    .forEach((btn) => btn.classList.toggle('is-on', Number(btn.dataset.speed) === value));
}

/* ---------------------------------------------------------------- 录音 */

function buildMeter() {
  const meter = $('recMeter');
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < METER_BARS; i += 1) fragment.appendChild(document.createElement('i'));
  meter.replaceChildren(fragment);
}

function meterFrame() {
  const bars = $('recMeter').children;
  const level = state.recorder ? state.recorder.level() : 0;
  const active = Math.round(level * bars.length);
  for (let i = 0; i < bars.length; i += 1) {
    const inRange = i < active;
    bars[i].style.height = (inRange ? 22 + (i / bars.length) * 74 : 14) + '%';
    bars[i].style.background = inRange ? 'var(--danger)' : 'var(--rule)';
  }
  state.meterRaf = requestAnimationFrame(meterFrame);
}

function timerFrame() {
  const elapsed = (performance.now() - state.recStartedAt) / 1000;
  $('recTimer').textContent = formatSeconds(elapsed);
  state.timerRaf = requestAnimationFrame(timerFrame);
}

async function startRecording() {
  if (state.recording) return;
  pauseOriginal();
  clearRecording();

  if (!state.recorder) state.recorder = new WavRecorder();
  try {
    await state.recorder.start();
  } catch (err) {
    toast(err.message || '无法启动录音', 'error');
    return;
  }

  state.recording = true;
  state.recStartedAt = performance.now();
  $('recBtn').textContent = '停止录音';
  $('recTimer').classList.add('is-live');
  $('recHint').textContent = '正在录音，读完整句后点「停止录音」';
  $('recResult').hidden = true;
  state.meterRaf = requestAnimationFrame(meterFrame);
  state.timerRaf = requestAnimationFrame(timerFrame);
}

function resetMeter() {
  $('recMeter')
    .querySelectorAll('i')
    .forEach((bar) => {
      bar.style.height = '14%';
      bar.style.background = 'var(--rule)';
    });
}

function teardownRecordingUi() {
  state.recording = false;
  cancelAnimationFrame(state.meterRaf);
  cancelAnimationFrame(state.timerRaf);
  $('recBtn').textContent = '开始录音';
  $('recTimer').classList.remove('is-live');
  resetMeter();
}

/** 切换句子时丢弃正在进行的录音，不生成结果。 */
function discardRecording() {
  if (!state.recording) return;
  teardownRecordingUi();
  $('recTimer').textContent = '0.0s';
  if (state.recorder) state.recorder.cancel();
}

async function stopRecording() {
  if (!state.recording || !state.recorder) return;
  teardownRecordingUi();

  let result;
  try {
    result = await state.recorder.stop();
  } catch (err) {
    toast(err.message || '录音处理失败，请重试', 'error');
    return;
  }

  if (result.durationSec < 0.5) {
    $('recHint').textContent = '录音太短，请完整读出整句后再提交';
    $('recTimer').textContent = '0.0s';
    toast('录音太短，请完整读出整句', 'error');
    return;
  }

  if (state.recUrl) URL.revokeObjectURL(state.recUrl);
  state.recUrl = URL.createObjectURL(result.blob);
  state.lastRecording = result;

  $('recAudioEl').src = state.recUrl;
  $('recDur').textContent = formatSeconds(result.durationSec);
  $('recResult').hidden = false;
  $('recHint').textContent = '录音完成，可以试听或直接提交评测';
  $('submitHint').textContent = '';
  $('submitBtn').disabled = false;
}

function clearRecording() {
  state.lastRecording = null;
  if (state.recUrl) {
    URL.revokeObjectURL(state.recUrl);
    state.recUrl = null;
  }
  $('recAudioEl').removeAttribute('src');
  $('recResult').hidden = true;
  $('recTimer').textContent = '0.0s';
  $('recHint').textContent = '点击按钮，跟读上面的句子';
  $('submitHint').textContent = '';
}

/* ---------------------------------------------------------------- 评测与反馈 */

async function submitAssessment() {
  if (state.submitting) return;
  if (!state.lastRecording) {
    toast('请先录制一段跟读音频', 'error');
    return;
  }

  state.submitting = true;
  const btn = $('submitBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '评测中…';
  $('submitHint').textContent = '正在分析发音，请稍候';

  try {
    const feedback = await api.assessUnit(
      state.audio.id,
      state.current,
      state.lastRecording.blob,
      state.lastRecording.durationSec
    );
    state.results[state.current] = feedback;
    renderFeedback(feedback);
    updateListScore(state.current, feedback);
    updateProgress();
    $('submitHint').textContent = '评测完成';
  } catch (err) {
    $('submitHint').textContent = '';
    toast(err.message, 'error');
  } finally {
    state.submitting = false;
    btn.disabled = false;
    btn.textContent = original;
  }
}

/**
 * 渲染四维评分与反馈。
 * animate/scroll 默认开启（新提交评测时用）；切句恢复历史成绩时传 false，
 * 避免每次切换都重播数字动画、把页面滚走。
 */
function renderFeedback(feedback, { animate = true, scroll = true } = {}) {
  $('fbEmpty').hidden = true;
  $('fbPanel').hidden = false;

  const ratio = Math.max(0, Math.min(1, feedback.overall / 100));
  $('ringFg').setAttribute('stroke-dasharray', `${(ratio * RING_CIRCUMFERENCE).toFixed(1)} 999`);
  $('ringFg').style.stroke =
    feedback.overall >= 85 ? 'var(--success)' : feedback.overall >= 70 ? 'var(--warning)' : 'var(--danger)';
  if (animate) countUp($('fbScore'), feedback.overall);
  else $('fbScore').textContent = String(feedback.overall);

  const verdict = $('fbVerdict');
  verdict.textContent = feedback.verdict.text;
  // 这里不能挂 is-good/is-warn/is-bad：它们是 dim__fill 的背景色全局类，会给整段文字上底色。
  verdict.style.color =
    feedback.overall >= 85 ? '#237804' : feedback.overall >= 70 ? '#9a6b00' : '#a8071a';

  const dims = $('fbDims');
  const dimFragment = document.createDocumentFragment();
  for (const dim of feedback.dimensions || []) {
    const wrap = document.createElement('div');
    wrap.className = 'dim';
    const top = document.createElement('div');
    top.className = 'dim__top';
    const label = document.createElement('span');
    label.textContent = dim.label;
    const value = document.createElement('b');
    value.textContent = String(dim.value);
    top.append(label, value);
    const track = document.createElement('div');
    track.className = 'dim__track';
    const fill = document.createElement('div');
    fill.className = `dim__fill ${bandClass(dim.value)}`;
    fill.style.width = Math.max(0, Math.min(100, dim.value)) + '%';
    track.appendChild(fill);
    wrap.append(top, track);
    dimFragment.appendChild(wrap);
  }
  dims.replaceChildren(dimFragment);

  const words = $('fbWords');
  const wordFragment = document.createDocumentFragment();
  for (const word of feedback.words || []) {
    const chip = document.createElement('span');
    // 服务端返回的 band 是 good/warn/bad，样式类需要 is- 前缀。
    chip.className = 'is-' + (word.band || scoreBand(word.score));
    chip.textContent = word.word;
    chip.title = `${word.score} 分 · ${word.errorType || 'None'}`;
    wordFragment.appendChild(chip);
  }
  words.replaceChildren(wordFragment);

  const suggests = $('fbSuggest');
  const suggestFragment = document.createDocumentFragment();
  for (const item of feedback.suggestions || []) {
    const li = document.createElement('li');
    const tag = document.createElement('b');
    tag.textContent = item.dimension;
    const text = document.createElement('span');
    text.textContent = item.text;
    li.append(tag, text);
    suggestFragment.appendChild(li);
  }
  suggests.replaceChildren(suggestFragment);

  const isLast = state.current >= state.units.length - 1;
  $('fbNextBtn').textContent = isLast ? '已完成全部句子' : '进入下一句';
  $('fbNextBtn').disabled = false;

  if (scroll) $('fb').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function countUp(el, target) {
  const start = performance.now();
  const duration = 620;
  const step = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = String(Math.round(target * eased));
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function goNext() {
  if (state.current >= state.units.length - 1) {
    toast('全部句子都练完了，可以换一段新音频');
    return;
  }
  selectUnit(state.current + 1);
}

function retryCurrent() {
  $('fbPanel').hidden = true;
  $('fbEmpty').hidden = false;
  $('fbEmpty').textContent = '再来一次：点击「开始录音」重新跟读本句，提交后会覆盖这次成绩。';
  clearRecording();
  toast('已清空本次录音，可以重练本句');
}

/* ---------------------------------------------------------------- 重置 */

function resetAll() {
  discardRecording();
  pauseOriginal();
  clearRecording();
  if (state.recorder) {
    state.recorder.cancel();
    state.recorder = null;
  }
  if (state.uploadController) state.uploadController.abort();

  state.audio = null;
  state.units = [];
  state.results = {};
  state.current = 0;
  state.audioBuffer = null;
  state.speed = 1;

  $('audioEl').removeAttribute('src');
  $('audioEl').load();
  $('sentList').replaceChildren();
  $('playBars').replaceChildren();
  $('fbPanel').hidden = true;
  $('fbEmpty').hidden = false;
  $('fbEmpty').textContent =
    '完成一次跟读并点击「提交评测」，这里会显示四维评分、逐词反馈与改进建议。';
  $('fileCard').hidden = true;
  $('fileInput').value = '';
  clearUploadError();
  $('newAudioBtn').hidden = true;
  $('listCount').textContent = '—';
  $('paneCount').textContent = '—';
  $('pIdx').textContent = '#01';
  $('pText').textContent = '—';
  $('listFill').style.width = '0%';
  $('listVal').textContent = '0 / 0';
  setSpeed(1);
  resetSteps();
  showView('viewUpload');
}

/* ---------------------------------------------------------------- 事件绑定 */

function bindUpload() {
  const dz = $('dz');
  const input = $('fileInput');

  dz.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    input.click();
  });
  dz.addEventListener('keydown', (event) => {
    if (event.target !== dz) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });

  for (const type of ['dragenter', 'dragover']) {
    dz.addEventListener(type, (event) => {
      event.preventDefault();
      dz.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dz.addEventListener(type, (event) => {
      event.preventDefault();
      dz.classList.remove('is-over');
    });
  }
  dz.addEventListener('drop', (event) => {
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  $('chooseBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    input.click();
  });
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (file) handleFile(file);
  });

  $('sampleBtn').addEventListener('click', async (event) => {
    event.stopPropagation();
    const btn = event.currentTarget;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '加载中…';
    try {
      const res = await fetch('./samples/sample-en.wav');
      if (!res.ok) throw new Error('示例音频不可用，请直接上传本地文件');
      const blob = await res.blob();
      await handleFile(new File([blob], 'sample-en.wav', { type: 'audio/wav' }));
    } catch (err) {
      showUploadError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  $('cancelUploadBtn').addEventListener('click', () => {
    if (state.uploadController) state.uploadController.abort();
    else {
      $('fileCard').hidden = true;
      clearUploadError();
    }
  });

  $('segRetryBtn').addEventListener('click', () => runSegmentation());
  $('segBackBtn').addEventListener('click', () => resetAll());
  $('newAudioBtn').addEventListener('click', () => resetAll());

  // 拖到窗口其它位置时不要触发浏览器直接打开文件（会丢掉当前练习进度）。
  for (const type of ['dragover', 'drop']) {
    document.addEventListener(type, (event) => event.preventDefault());
  }
}

function bindWorkspace() {
  $('playBtn').addEventListener('click', togglePlay);
  $('audioEl').addEventListener('timeupdate', onTimeUpdate);
  $('audioEl').addEventListener('play', updatePlayIcon);
  $('audioEl').addEventListener('pause', updatePlayIcon);
  $('audioEl').addEventListener('ended', () => {
    syncPlayhead();
    updatePlayIcon();
  });

  $('playTrack').addEventListener('click', seekFromEvent);
  $('speedGroup').addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (btn) setSpeed(Number(btn.dataset.speed));
  });

  $('recBtn').addEventListener('click', () => {
    if (state.recording) stopRecording();
    else startRecording();
  });
  $('replayBtn').addEventListener('click', () => {
    const audio = $('recAudioEl');
    audio.currentTime = 0;
    audio.play().catch(() => toast('无法播放录音', 'error'));
  });
  $('submitBtn').addEventListener('click', submitAssessment);

  $('fbRetryBtn').addEventListener('click', retryCurrent);
  $('fbNextBtn').addEventListener('click', goNext);

  document.addEventListener('keydown', (event) => {
    if ($('viewWorkspace').hidden) return;
    const tag = (event.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'button') return;
    if (event.code === 'Space') {
      event.preventDefault();
      togglePlay();
    }
  });
}

async function init() {
  buildMeter();
  bindUpload();
  bindWorkspace();
  setSpeed(1);
  resetSteps();

  try {
    const health = await api.health();
    limits = health.limits || limits;
    state.asr = health.asr || state.asr;

    const badge = $('providerBadge');
    const info = health.provider || {};
    state.recognizer = info.recognizer || 'browser-whisper';

    if (state.recognizer === 'azure') {
      badge.classList.add('is-live');
      $('providerText').textContent = 'Azure 识别与评测';
      badge.title = `语言 ${info.language || 'en-US'}；识别与发音评测均由 Azure 语音服务完成`;
    } else if (info.name === 'azure') {
      badge.classList.add('is-warn');
      $('providerText').textContent = 'Azure 未配置';
      badge.title = '缺少 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION，请补齐后重启服务';
    } else {
      badge.classList.add('is-warn');
      $('providerText').textContent = '本地识别 + 模拟评测';
      badge.title = `识别：浏览器本地 Whisper（${state.asr.model}）；评测：本地模拟，仅用于演示`;
    }
  } catch {
    $('providerText').textContent = '服务未连接';
  }

  $('dzHint').textContent = `支持 MP3 / WAV / M4A，单个文件 ≤ ${limits.maxUploadMb}MB，时长 ${limits.minAudioSeconds} 秒 – ${Math.round(
    limits.maxAudioSeconds / 60
  )} 分钟`;
}

init();