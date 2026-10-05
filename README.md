# 影随 ShadowMate

英语口语影子跟读（Shadowing）练习应用：上传一段英文音频，自动识别并分句，逐句播放跟读，提交后给出多维发音评测与改进建议。

**零运行时依赖**：后端只用 Node.js 原生模块，前端是原生 ES Module，没有构建步骤、没有 npm 依赖。

## 功能

- **音频上传**：拖拽或选择文件，支持 MP3 / WAV / M4A，服务端校验格式与时长
- **自动分句**：语音识别 + 按停顿切句，生成逐句练习单元
- **影子跟读**：单句播放（播完即停，不循环）、0.75× / 1.0× / 1.25× 变速、录音与波形可视化
- **发音评测**：准确度 / 流利度 / 语调 / 完整性四维评分、逐词反馈与改进建议
- **成绩保留**：已练句子的成绩在切换句子后仍保留，直到重录提交才刷新

## 环境要求

- Node.js **>= 18**（需要内置 `fetch` 与 ESM 支持）
- 现代浏览器（Chrome / Edge / Firefox / Safari），需支持 WebAssembly

## 快速开始

```bash
git clone <你的仓库地址>
cd shadowmate
npm start
```

打开 http://localhost:5173

需要改端口或启用 Azure 时，先复制配置（所有项都有默认值，不配置也能直接跑）：

```bash
cp .env.example .env        # Windows: copy .env.example .env
```

开发时可用热重载：`npm run dev`

## 使用流程

1. 上传音频，或点「使用示例音频」
2. 等待识别与自动分句
3. 逐句：播放原声 → 跟读录音 → 提交评测
4. 查看四维评分、逐词反馈与改进建议

## 识别与评测如何工作

默认 `SPEECH_PROVIDER=mock`：

- **识别**：浏览器本地 Whisper（transformers.js + WebAssembly），是**真实识别**，不需要任何凭据
- **评测**：本地模拟打分，仅供开发与演示

首次识别时，服务端会从上游下载模型（tiny 版约 64MB）并缓存到 `data/models/`，浏览器只访问本机地址，之后可离线复用。若上游不可达，改 `.env` 里的 `WHISPER_MODEL_HOST`。

配置 `SPEECH_PROVIDER=azure` 并填入凭据后，识别与评测都走 Azure AI 语音服务，质量最好。

## 配置项（.env）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `5173` | 服务端口 |
| `SPEECH_PROVIDER` | `mock` | `mock`（本地识别 + 模拟评测）或 `azure` |
| `AZURE_SPEECH_KEY` | 空 | 仅 azure 模式需要 |
| `AZURE_SPEECH_REGION` | `eastasia` | 仅 azure 模式需要 |
| `AZURE_SPEECH_LANGUAGE` | `en-US` | 识别与评测目标语言 |
| `WHISPER_MODEL` | `Xenova/whisper-tiny.en` | 本地识别模型；可换 `whisper-base.en` 提升准确率 |
| `WHISPER_MODEL_HOST` | `https://hf-mirror.com` | 服务端下载模型的上游；海外可改 `https://huggingface.co` |
| `WHISPER_ENCODER_DTYPE` | `fp32` | 编码器精度；`q8` 更小更快 |
| `MAX_UPLOAD_MB` | `50` | 上传大小上限 |
| `MIN_AUDIO_SECONDS` | `30` | 音频最短时长 |
| `MAX_AUDIO_SECONDS` | `600` | 音频最长时长 |

## 关于 public/vendor

识别运行库与 ONNX WASM 运行时**已内置在项目里**（`public/vendor/`），由本机服务端提供，因此浏览器**不依赖任何外部 CDN** —— 在内网或无法访问 CDN 的环境下也能正常识别。

升级运行库版本：修改 `scripts/vendor-runtime.mjs` 里的 `VERSION` 后执行

```bash
node scripts/vendor-runtime.mjs
```

## 测试

先启动服务（默认 5173 端口），再执行：

```bash
node scripts/smoke-test.mjs
```

覆盖上传校验、分句、评测、模型代理与内置运行库等接口。服务不在默认端口时：

```bash
SMOKE_BASE=http://localhost:5199 node scripts/smoke-test.mjs
```

Windows PowerShell：

```powershell
$env:SMOKE_BASE='http://localhost:5199'; node scripts/smoke-test.mjs
```

## 项目结构

```
server/              零依赖 HTTP 服务端
  index.js           入口与路由注册
  http.js            路由、静态文件与 MIME
  config.js          配置与环境变量
  audioFormat.js     音频格式校验与时长解析
  segmenter.js       分句规则
  suggestions.js     评分与建议引擎
  store.js           音频与练习结果存储
  routes/            audios / assess / models 接口
  providers/         mock 与 azure 语音提供方
public/              前端（原生 ES Module，无构建）
  index.html
  styles.css
  js/                app / api / recorder / waveform / wav / transcribe
  samples/           示例音频
  vendor/            内置识别运行库与 WASM（不依赖外部 CDN）
scripts/
  smoke-test.mjs     接口冒烟测试
  vendor-runtime.mjs 更新内置运行库
data/                模型缓存（运行时生成，不入库）
uploads/             上传的音频（运行时生成，不入库）
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与服务信息 |
| POST | `/api/audios` | 上传音频 |
| GET | `/api/audios/:id` | 查询音频与分句结果 |
| GET | `/api/audios/:id/file` | 播放原始音频（支持 Range） |
| POST | `/api/audios/:id/segment` | 云端识别并分句（azure 模式） |
| POST | `/api/audios/:id/transcript` | 提交浏览器识别结果并分句 |
| POST | `/api/audios/:id/units/:index/assess` | 对某句跟读打分 |
| GET | `/api/model/*` | 模型文件代理（落盘缓存） |

## 数据与隐私

音频文件保存在本机 `uploads/`，模型缓存保存在本机 `data/`，都不会上传到第三方；`.gitignore` 已排除这两个目录。

音频元数据与练习结果保存在**服务进程内存**中，重启服务后需重新上传音频。