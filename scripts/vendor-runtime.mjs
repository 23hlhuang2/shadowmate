/**
 * 下载浏览器本地识别所需的内置运行库到 public/vendor/。
 *
 * 这些文件随项目一起提交，让应用不依赖任何外部 CDN —— 使用者在无法访问 CDN 的网络里也能正常识别。
 * 升级运行库版本时改下面的 VERSION，然后执行：node scripts/vendor-runtime.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '3.7.6';
const FILES = ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'vendor');
const BASE = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${VERSION}/dist`;

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const file of FILES) {
  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) throw new Error(`下载 ${file} 失败：HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(OUT_DIR, file), body);
  console.log(`已写入 ${file}（${body.length.toLocaleString()} 字节）`);
}

console.log(`\n运行库 ${VERSION} 已就绪：public/vendor/`);