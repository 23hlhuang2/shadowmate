import { encodeWav, mergeChunks, resample } from './wav.js';

const TARGET_SAMPLE_RATE = 16000;

const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) this.port.postMessage(input[0].slice(0));
    return true;
  }
}
registerProcessor('shadowmate-capture', CaptureProcessor);
`;

/**
 * 录音器：输出 16kHz / 16bit / 单声道 PCM WAV。
 * 优先使用 AudioWorklet，不可用时回退到 ScriptProcessor。
 */
export class WavRecorder {
  constructor() {
    this.stream = null;
    this.context = null;
    this.analyser = null;
    this.node = null;
    this.mute = null;
    this.chunks = [];
    this.sourceRate = 48000;
    this.workletUrl = null;
    this.active = false;
  }

  static get supported() {
    return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async start() {
    if (!WavRecorder.supported) {
      throw new Error('当前浏览器不支持录音，请使用 Chrome / Edge / Safari 最新版本');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const Ctor = window.AudioContext || window.webkitAudioContext;
    this.context = new Ctor();
    if (this.context.state === 'suspended') await this.context.resume();
    this.sourceRate = this.context.sampleRate;

    const source = this.context.createMediaStreamSource(this.stream);

    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);

    this.chunks = [];
    this.mute = this.context.createGain();
    this.mute.gain.value = 0;
    this.mute.connect(this.context.destination);

    const useWorklet = this.context.audioWorklet && typeof window.AudioWorkletNode === 'function';
    if (useWorklet) {
      try {
        this.workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
        await this.context.audioWorklet.addModule(this.workletUrl);
        this.node = new AudioWorkletNode(this.context, 'shadowmate-capture');
        this.node.port.onmessage = (event) => this.chunks.push(event.data);
        source.connect(this.node);
        this.node.connect(this.mute);
      } catch {
        this.node = null;
      }
    }

    if (!this.node) {
      const processor = this.context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        this.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(this.mute);
      this.node = processor;
    }

    this.active = true;
  }

  /** 当前音量（0..1），用于电平条。 */
  level() {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / data.length) * 3.2);
  }

  async stop() {
    this.active = false;

    if (this.node) {
      try {
        this.node.port && (this.node.port.onmessage = null);
        this.node.disconnect();
      } catch {
        /* 忽略 */
      }
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    if (this.mute) {
      try {
        this.mute.disconnect();
      } catch {
        /* 忽略 */
      }
    }
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
    if (this.context && this.context.state !== 'closed') {
      try {
        await this.context.close();
      } catch {
        /* 忽略 */
      }
    }

    const merged = mergeChunks(this.chunks);
    this.chunks = [];
    const pcm16k = resample(merged, this.sourceRate, TARGET_SAMPLE_RATE);
    const blob = encodeWav(pcm16k, TARGET_SAMPLE_RATE);

    return { blob, durationSec: pcm16k.length / TARGET_SAMPLE_RATE };
  }

  cancel() {
    this.chunks = [];
    this.stop().catch(() => {});
  }
}