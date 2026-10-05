import fs from 'node:fs';
import path from 'node:path';
import { config, MODEL_CACHE_DIR } from '../config.js';
import { httpError } from '../http.js';

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function contentTypeOf(file) {
  if (file.toLowerCase().endsWith('.onnx_data')) return 'application/octet-stream';
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * 上游偶发会重置连接或限流，这里重试几次再放弃，避免一次抖动就让整段识别失败。
 */
async function fetchUpstream(url) {
  const attempts = 3;
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok || (res.status !== 429 && res.status < 500)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
  }
  throw lastErr;
}

/**
 * 代理浏览器本地识别所需的模型文件。
 *
 * 浏览器直连下载源（默认 hf-mirror）会被网络策略拦下，fetch 直接失败；
 * 服务端能正常访问，于是由服务端代取并落盘缓存，浏览器只访问同源地址。
 * 缓存后再次加载同一模型无需联网。
 */
export async function proxyModelFile(req, res, ctx) {
  const segments = String(ctx.params.rest || '')
    .split('/')
    .filter(Boolean);

  if (!segments.length || segments.some((s) => s === '..' || s === '.')) {
    throw httpError(400, 'BAD_MODEL_PATH', '非法的模型文件路径');
  }

  const cacheFile = path.join(MODEL_CACHE_DIR, ...segments);
  if (!cacheFile.startsWith(MODEL_CACHE_DIR + path.sep)) {
    throw httpError(400, 'BAD_MODEL_PATH', '非法的模型文件路径');
  }

  const headers = {
    'Content-Type': contentTypeOf(segments[segments.length - 1]),
    'Cache-Control': 'public, max-age=31536000'
  };

  if (fs.existsSync(cacheFile)) {
    const cached = fs.readFileSync(cacheFile);
    res.writeHead(200, { ...headers, 'Content-Length': cached.length });
    res.end(cached);
    return;
  }

  const upstream = `${config.asr.host.replace(/\/+$/, '')}/${segments.map(encodeURIComponent).join('/')}`;
  let upstreamRes;
  try {
    upstreamRes = await fetchUpstream(upstream);
  } catch (err) {
    throw httpError(
      502,
      'MODEL_UPSTREAM_FAILED',
      `无法连接模型下载源 ${config.asr.host}，请检查服务器网络后重试：${err.message}`
    );
  }
  if (!upstreamRes.ok) {
    throw httpError(
      upstreamRes.status === 404 ? 404 : 502,
      'MODEL_UPSTREAM_ERROR',
      `模型下载源返回 HTTP ${upstreamRes.status}`
    );
  }

  const body = Buffer.from(await upstreamRes.arrayBuffer());
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, body);

  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  res.end(body);
}