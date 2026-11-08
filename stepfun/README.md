# StepFun (600073)

OceanBase 生态题 600073 的可运行提交：浏览器端本地向量化（WebGPU 优先、WASM 自动降级）+
`@oceanbase/seekdb-node` 嵌入式数据库内的**单条 SQL** 向量/全文混合检索。

技术说明见 [TECHNOTE.md](./TECHNOTE.md)。实测产物在 `results/`。

## 快速启动

```bash
cd stepfun
npm install     # 需要 Node >= 22
npm start       # http://localhost:8787 （可用 PORT=8899 npm start 改端口）
```

- `http://localhost:8787/`：建库 + 检索，页面顶部显示设备（WebGPU / WASM 降级）与索引文档数。
- `http://localhost:8787/?bench`：自动执行「冷启动 → 预热后」双阶段评测，并写出 `results/submission-results.json`；
  `?bench&debug` 会把诊断日志打到浏览器控制台。
- `http://localhost:8787/?wasm`：强制走 WASM 后端，用于验证 WebGPU 不可用时的降级路径与界面提示。
- `npm run benchmark:quant`：重新生成 `results/quantization.json`（FP32 / FP16 / INT8 的体积、延迟与检索质量对比）。

首次启动会在 `data/seekdb/` 初始化嵌入式数据库；`results/` 中的 JSON 都是实测运行产物。

## 目录结构

```
stepfun/
├─ server.mjs                      # 静态服务 + seekdb 嵌入式实例 + 3 个 API
├─ src/embed-worker.src.js         # 浏览器 Worker 源码（Transformers.js 推理）
├─ scripts/
│  ├─ build-worker.mjs             # esbuild 打包 Worker 到 public/embed-worker.js
│  ├─ build-corpus.mjs             # 从 seekdb 文档生成 data/corpus.json
│  └─ benchmark-quant.mjs          # 量化对比（体积 / 延迟 / Recall@5 / MRR@5）
├─ public/
│  ├─ index.html / app.js / styles.css
│  ├─ embed-worker.js              # 打包后的 Worker（可直接运行）
│  └─ models/bge-small-en-v1.5/    # 离线模型：config、tokenizer、fp32 / fp16 / int8 ONNX
├─ data/corpus.json                # 96 篇切块语料
└─ results/                        # submission-results.json / quantization.json（实测）
```

## 数据与模型来源

- 语料：seekdb 上游文档（Apache-2.0），由 `scripts/build-corpus.mjs` 清洗、分块生成 `data/corpus.json`。
  重新生成需要设置 `SEEKB_SRC` 指向 seekdb 仓库；仓库中已附带生成结果。
- 模型：`BAAI/bge-small-en-v1.5`（MIT），ONNX 导出来自 `Xenova/bge-small-en-v1.5`。仓库只附带交付用的
  INT8 权重（`model_quantized.onnx`），运行时禁用远程模型下载（`env.allowRemoteModels = false`）。
- 复现量化对比需要 FP32 / FP16 基线（不入库，约 128 MiB + 64 MiB）：

```bash
cd public/models/bge-small-en-v1.5/onnx
curl -L -o model.onnx      "https://hf-mirror.com/Xenova/bge-small-en-v1.5/resolve/main/onnx/model.onnx"
curl -L -o model_fp16.onnx "https://hf-mirror.com/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_fp16.onnx"
cd ../../../.. && npm run benchmark:quant
```
- 推理运行时：`@huggingface/transformers` + `onnxruntime-web`；ORT 的 wasm 资源由服务端从
  `node_modules/onnxruntime-web/dist` 代理到 `/vendor/ort/`，因此无需 CDN。

## 重新打包 Worker

修改 `src/embed-worker.src.js` 后执行：

```bash
node scripts/build-worker.mjs
```

（`esbuild` 为开发依赖；打包产物 `public/embed-worker.js` 不入库，`npm start` 会通过 prestart 自动重建，也可手动执行上面的命令。）
