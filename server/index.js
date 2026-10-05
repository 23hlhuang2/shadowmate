import http from 'node:http';
import { config, ensureDirs } from './config.js';
import { createRouter, sendError, sendJson, serveStatic } from './http.js';
import { providerInfo } from './providers/index.js';
import { createAudio, getAudio, getAudioFile, segmentAudio, submitTranscript } from './routes/audios.js';
import { assessUnit } from './routes/assess.js';
import { proxyModelFile } from './routes/models.js';

ensureDirs();

const router = createRouter();

router.get('/api/health', (req, res) => {
  sendJson(res, 200, {
    ok: true,
    provider: providerInfo(),
    asr: {
      model: config.asr.model,
      encoderDtype: config.asr.encoderDtype,
      proxyBase: '/api/model'
    },
    limits: {
      maxUploadMb: Math.round(config.limits.maxUploadBytes / 1048576),
      minAudioSeconds: config.limits.minSeconds,
      maxAudioSeconds: config.limits.maxSeconds
    }
  });
});
router.post('/api/audios', createAudio);
router.get('/api/audios/:id', getAudio);
router.get('/api/audios/:id/file', getAudioFile);
router.post('/api/audios/:id/segment', segmentAudio);
router.post('/api/audios/:id/transcript', submitTranscript);
router.post('/api/audios/:id/units/:index/assess', assessUnit);
router.get('/api/model/*', proxyModelFile);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      const matched = router.match(req.method, url.pathname);
      if (!matched) {
        sendError(res, 404, 'NOT_FOUND', `接口不存在：${req.method} ${url.pathname}`);
        return;
      }
      await matched.handler(req, res, { params: matched.params, url });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET');
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[shadowmate]', err);
    sendError(res, status, err.code || 'INTERNAL_ERROR', err.message || '服务器内部错误', err.extra);
  }
});

server.listen(config.port, () => {
  const info = providerInfo();
  console.log('');
  console.log('  影随 ShadowMate 已启动');
  console.log(`  地址      http://localhost:${config.port}`);
  console.log(`  语音提供方 ${info.name}${info.realSpeech ? '' : '（模拟数据，仅供开发与演示）'}`);
  if (!info.ready) {
    console.log('  注意      SPEECH_PROVIDER=azure 但缺少凭据，识别与评测会返回 503');
  }
  console.log('');
});