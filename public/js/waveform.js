/** 波形：从真实音频解码后计算峰值包络并渲染，不是假数据。 */

let sharedContext = null;

export function audioContext() {
  if (!sharedContext) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    sharedContext = new Ctor();
  }
  if (sharedContext.state === 'suspended') sharedContext.resume().catch(() => {});
  return sharedContext;
}

export async function decode(arrayBuffer) {
  return audioContext().decodeAudioData(arrayBuffer.slice(0));
}

/** 计算 [startSec, endSec) 区间内的峰值包络，归一化到 0..1。 */
export function peaksForRange(audioBuffer, startSec, endSec, buckets = 140) {
  const sampleRate = audioBuffer.sampleRate;
  const channelCount = audioBuffer.numberOfChannels;
  const channels = [];
  for (let c = 0; c < channelCount; c += 1) channels.push(audioBuffer.getChannelData(c));

  const from = Math.max(0, Math.floor(startSec * sampleRate));
  const to = Math.min(audioBuffer.length, Math.ceil(endSec * sampleRate));
  const span = Math.max(1, to - from);
  const step = span / buckets;

  const peaks = new Float32Array(buckets);
  let max = 0;

  for (let b = 0; b < buckets; b += 1) {
    const begin = from + Math.floor(b * step);
    const end = Math.min(to, from + Math.floor((b + 1) * step));
    let peak = 0;
    for (let i = begin; i < end; i += 1) {
      for (let c = 0; c < channelCount; c += 1) {
        const v = Math.abs(channels[c][i]);
        if (v > peak) peak = v;
      }
    }
    peaks[b] = peak;
    if (peak > max) max = peak;
  }

  if (max > 0) {
    for (let b = 0; b < buckets; b += 1) peaks[b] = peaks[b] / max;
  }
  return peaks;
}

export function renderWave(container, peaks, minPercent = 8) {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < peaks.length; i += 1) {
    const bar = document.createElement('i');
    bar.style.height = Math.max(minPercent, Math.round(peaks[i] * 100)) + '%';
    fragment.appendChild(bar);
  }
  container.replaceChildren(fragment);
}

export function setPlayed(container, ratio) {
  const bars = container.children;
  const passed = Math.round(bars.length * Math.max(0, Math.min(1, ratio)));
  for (let i = 0; i < bars.length; i += 1) {
    bars[i].classList.toggle('is-passed', i < passed);
  }
}

export function markSelected(container, fromRatio, toRatio) {
  const bars = container.children;
  const from = Math.floor(bars.length * fromRatio);
  const to = Math.ceil(bars.length * toRatio);
  for (let i = 0; i < bars.length; i += 1) {
    bars[i].classList.toggle('is-sel', i >= from && i < to);
  }
}