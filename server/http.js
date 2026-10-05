import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR } from './config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4'
};

export function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

export function sendError(res, status, code, message, extra) {
  sendJson(res, status, { error: { code, message, ...(extra || {}) } });
}

export function httpError(status, code, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (extra) err.extra = extra;
  return err;
}

export async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (maxBytes && size > maxBytes) {
      throw httpError(413, 'PAYLOAD_TOO_LARGE', '请求体超过大小限制');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, maxBytes = 1 << 20) {
  const buf = await readBody(req, maxBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw httpError(400, 'BAD_JSON', '请求体不是合法 JSON');
  }
}

function matchPattern(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean);
  const a = pathname.split('/').filter(Boolean);
  const params = {};
  for (let i = 0; i < p.length; i += 1) {
    // 结尾的 * 匹配剩余全部路径段（用于模型代理这类不定长路径）。
    if (p[i] === '*') {
      params.rest = a.slice(i).map((segment) => decodeURIComponent(segment)).join('/');
      return params;
    }
    if (i >= a.length) return null;
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return p.length === a.length ? params : null;
}

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => routes.push({ method, pattern, handler });
  return {
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const params = matchPattern(route.pattern, pathname);
        if (params) return { handler: route.handler, params };
      }
      return null;
    }
  };
}

export function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);

  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) {
    sendError(res, 403, 'FORBIDDEN', '非法路径');
    return;
  }

  let target = resolved;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, 'index.html');
  }
  if (!fs.existsSync(target)) {
    sendError(res, 404, 'NOT_FOUND', '资源不存在');
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const body = fs.readFileSync(target);
  // 无构建步骤、文件名不带哈希，脚本与样式必须每次校验，否则改完刷新看不到效果。
  const noStore = ext === '.html' || ext === '.js' || ext === '.css';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': noStore ? 'no-store' : 'public, max-age=300'
  });
  res.end(body);
}