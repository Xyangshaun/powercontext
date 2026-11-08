# StepFun — 浏览器端本地向量化 + seekdb 单条 SQL 混合检索

赛题 600073（20 分）。文档与查询向量全部在浏览器 Web Worker 内计算（Transformers.js + ONNX Runtime Web），
seekdb 以嵌入式方式运行在同一进程，向量 + 全文混合检索由**一条 SQL** 完成。

## 1. 架构

```
浏览器 (Chrome)
 ├─ Web Worker: @huggingface/transformers + bge-small-en-v1.5 (int8, 384d)
 │    ├─ WebGPU EP 优先；不可用时自动降级 WASM EP，界面顶部显示降级提示
 │    └─ 文档向量 / 查询向量都在 Worker 内产生，未调用任何云端推理 API
 └─ 单页应用：建库、检索、分阶段计时、触发评测
        │ base64 Float32 向量，HTTP
        ▼
Node 服务 (server.mjs, 端口 8787 或 PORT)
 ├─ @oceanbase/seekdb-node（嵌入式，unix socket + mysql2）
 │    ├─ docs(id, title, content, source, embedding VECTOR(384))
 │    ├─ VECTOR INDEX idx_docs_vec (embedding) WITH (DISTANCE=l2, TYPE=hnsw, LIB=vsag)
 │    └─ FULLTEXT INDEX idx_docs_fts (content)
 └─ 静态资源 + 评测结果落盘（results/）
```

关键点：服务端不计算向量，只接收向量、写库、执行 SQL；`MATCH` 与 `l2_distance` 都由 seekdb 执行。

## 2. 混合检索：单条 SQL（服务端执行）

```sql
SELECT d.id, d.title, d.content, d.source,
       MAX(u.rr) AS score,
       MAX(CASE WHEN u.src = 'v' THEN u.rnk END) AS vec_rank,
       MAX(CASE WHEN u.src = 'f' THEN u.rnk END) AS fts_rank
FROM (
  SELECT id, 'v' AS src, rnk, 1.0 / (60 + rnk) AS rr FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY l2_distance(embedding, ?) ASC) AS rnk
    FROM docs ORDER BY l2_distance(embedding, ?) APPROXIMATE LIMIT 40
  ) v
  UNION ALL
  SELECT id, 'f' AS src, rnk, 1.0 / (60 + rnk) AS rr FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY MATCH(content) AGAINST(?) DESC) AS rnk
    FROM docs WHERE MATCH(content) AGAINST(?) LIMIT 40
  ) f
) u JOIN docs d ON d.id = u.id
GROUP BY d.id, d.title, d.content, d.source
ORDER BY score DESC, vec_rank ASC LIMIT 8;
```

RRF（k=60）在 SQL 内完成融合，客户端只拿到最终排名，不存在「客户端拼两路」。`EXPLAIN` 显示
`VECTOR INDEX SCAN |docs(idx_docs_vec)` 与 `TEXT RETRIEVAL SCAN |docs(idx_docs_fts)` 同时出现，
原始执行计划见 `results/explain.json`，同一份计划也写入 `submission-results.json` 的 `retrieval.explain`。
写入后调用 `CALL DBMS_VECTOR.REFRESH_INDEX('idx_docs_vec','docs','embedding',1,'FAST')` 使新数据立即可查。

> 踩坑记录：建表时若加 `ORGANIZATION = HEAP`，`APPROXIMATE` 向量查询会静默返回 0 行；去掉后 HNSW 正常。

## 3. 模型与量化

- 模型：[BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5)（MIT），ONNX 导出由 `Xenova/bge-small-en-v1.5` 提供；模型文件随仓库离线携带，`env.allowRemoteModels = false`。
- 交付使用 **INT8**（`model_quantized.onnx`，384 维）。

| 精度 | 文件体积 | 相对 FP32 | 加载 | 向量化 | Recall@5 | MRR@5 | 与 FP32 向量余弦（均值 / 最小） |
|---|---|---|---|---|---|---|---|
| FP32 | 126.93 MiB | — | 153 ms | 5.3 ms/doc | 96.2% | 0.846 | 1.000000 / 1.000000 |
| FP16 | 63.66 MiB | −49.85% | 120 ms | 7.8 ms/doc | 96.2% | 0.846 | ≈1.000000 / ≈1.000000 |
| INT8（交付） | 32.44 MiB | **−74.44%** | 64 ms | 6.0 ms/doc | 96.2% | 0.846 | 0.998450 / 0.996762 |

度量方法（`scripts/benchmark-quant.mjs`，真实运行产出 `results/quantization.json`）：同一语料（96 块）、
同一套 26 条人工标注查询（18 条关键词型 + 8 条语义改写型），文档级命中（任一标注 id 进 Top-5 记为命中），
余弦排序。结论：INT8 体积降至 FP32 的 1/4，在本标注集上检索指标与 FP32 完全一致，向量余弦平均 0.9985。
该测量在 Node + onnxruntime-node (CPU EP) 上完成；浏览器加载的是同一份权重文件，量化对嵌入的影响与运行后端无关。

## 4. 分阶段计时（真实浏览器实测，96 篇 / 384 维 / int8 / WebGPU）

| 阶段 | 首次（冷） | 预热后 |
|---|---|---|
| 模型加载 | 772 ms | 733 ms |
| 语料向量化（96 篇） | 39.84 s（415 ms/篇） | 41.43 s（432 ms/篇） |
| 写入 seekdb（40 条/批） | 24.3 ms | 25.7 ms |
| 索引刷新 REFRESH_INDEX | 10.1 ms | 6.6 ms |
| 建库合计（向量化+写入+刷新） | 41.34 s | 42.97 s |
| 查询向量化（5 条均值） | 103.5 ms | 116.7 ms |
| 混合检索 SQL（5 条均值） | 4.80 ms | 5.50 ms |
| 单次查询端到端（均值） | 110.3 ms | 124.5 ms |

数据取自 `results/submission-results.json`（`generatedAt` 2026-11-08T11:38Z，WebGPU，int8，96 篇）。
冷/热差异主要来自首次 GPU 管线编译；语料向量化本身在同机多次实测为 39.8–72.8 s，存在明显波动，
端到端里查询向量化占绝对主导（约 94%），SQL 约 4–6%。
WASM 降级路径也已实测：Worker 自检 `READY device=wasm loadMs=679`，主页面 `?wasm&auto` 会显示
「当前浏览器未启用 WebGPU，embedding 已自动降级到 WASM 后端…」横幅；早前 214 篇语料在 WASM 下
向量化耗时 164 s（约 0.77 s/篇）。

## 5. 复现

```bash
cd stepfun
npm install          # node >= 22（seekdb-native 要求）
npm start            # 默认 8787，可 PORT=8899 npm start
# 打开 http://localhost:8787/ 手动建库与检索
# 打开 http://localhost:8787/?bench 自动跑冷/热双阶段评测并写出 results/submission-results.json
npm run benchmark:quant   # 生成 results/quantization.json（fp32/fp16/int8 体积与质量对比）
# 打开 http://localhost:8787/?wasm 可强制 WASM 后端，验证降级提示
```

`results/submission-results.json` 由页面内的评测流程真实写入（服务端 `/api/results` 落盘），非手工编辑。

## 6. 已知边界（如实声明）

- 语料为 seekdb 上游文档（Apache-2.0）切块 96 篇，检索质量标注集 26 条，规模小，指标仅用于量化对比而非通用评测。
- 量化质量测量走 CPU EP（Node），未在浏览器 WebGPU 上重跑 FP16/FP32；FP16 在浏览器 WebGPU 亦可加载，但未纳入提交数据。
- 冷启动「模型加载」包含从本地 HTTP 读取 32.4 MiB 权重的时间；不含系统 DNS 等外部因素。
- 单进程单表（`docs`），未做分片/多租户；seekdb 以 `memory_budget: 2G` 嵌入式启动。
