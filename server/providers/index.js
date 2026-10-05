import { config } from '../config.js';
import * as mock from './mock.js';
import * as azure from './azure.js';

const REGISTRY = { mock, azure };

export function getProvider() {
  const provider = REGISTRY[config.provider];
  if (!provider) {
    throw new Error(`未知的语音服务提供方：${config.provider}（可选：${Object.keys(REGISTRY).join(' / ')}）`);
  }
  return provider;
}

export function providerInfo() {
  const azureReady = Boolean(config.azure.key && config.azure.region);
  const azureSelected = config.provider === 'azure';
  return {
    name: config.provider,
    realSpeech: azureSelected,
    language: azureSelected ? config.azure.language : 'en-US',
    azureConfigured: azureReady,
    ready: !azureSelected || azureReady,
    // 识别实际由谁完成：Azure 已配置时用云端，否则交给浏览器本地 Whisper。
    recognizer: azureSelected && azureReady ? 'azure' : 'browser-whisper',
    assessor: azureSelected && azureReady ? 'azure' : 'mock'
  };
}