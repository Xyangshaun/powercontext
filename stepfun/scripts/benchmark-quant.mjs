#!/usr/bin/env node
/**
 * Quantization benchmark.
 *
 * Measures, on the exact same corpus used by the web app:
 *   - artifact size (bytes on disk) of fp32 / fp16 / int8 ONNX exports
 *   - embedding latency and load time
 *   - retrieval quality with a small hand-labelled query set (doc-level Recall@5 / MRR@5)
 *
 * Embeddings are produced with @huggingface/transformers (same library the browser
 * worker uses) and ranked by cosine similarity. The app itself always embeds in the
 * browser; this script exists only to produce the quantization comparison report.
 *
 * Usage: node scripts/benchmark-quant.mjs
 * Output: results/quantization.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline, env } from "@huggingface/transformers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_ID = "bge-small-en-v1.5";
const MODEL_DIR = path.join(ROOT, "public/models", MODEL_ID);

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = path.join(ROOT, "public/models") + path.sep;

const VARIANTS = [
  { dtype: "fp32", file: "onnx/model.onnx", label: "FP32 (baseline)" },
  { dtype: "fp16", file: "onnx/model_fp16.onnx", label: "FP16" },
  { dtype: "q8", file: "onnx/model_quantized.onnx", label: "INT8 (shipped)" },
];

/** Hand-labelled queries: every id listed is an acceptable answer for the query. */
const GOLD = [
  { query: "how to build seekdb for iOS", ids: [110, 112, 114, 116, 119, 121] },
  { query: "run the mysql test suite and select cases", ids: [123, 125, 128, 130] },
  { query: "use the seekdb WebAssembly shell", ids: [179, 181, 183, 186, 188, 190] },
  { query: "set up homebrew mirrors for faster installs", ids: [108] },
  { query: "build and run seekdb on Android", ids: [70, 72, 74, 76] },
  { query: "copy-on-write sandbox for agent exploration", ids: [7] },
  { query: "hybrid retrieval in a single SQL statement", ids: [50] },
  { query: "why does P99 spike under streaming writes", ids: [38, 41, 43, 45] },
  { query: "refresh a vector index so new writes become queryable", ids: [54] },
  { query: "embed seekdb in a process without a separate server", ids: [12, 14, 16, 18] },
  { query: "CXX bridge between C++ and Rust", ids: [134] },
  { query: "configure build concurrency for remote C++ compilation", ids: [83, 85, 87] },
  { query: "install the Rust toolchain on a Windows host", ids: [154, 157, 159, 161] },
  { query: "package a release of the WebAssembly shell", ids: [197, 199, 201, 203] },
  { query: "MySQL-compatible ACID embeddable database", ids: [9] },
  { query: "agents need an undo button", ids: [47] },
  { query: "the wrong benchmark to choose a vector database", ids: [34, 36] },
  { query: "add and execute a unit test", ids: [168] },
  // Semantic paraphrases: intentionally share little surface vocabulary with the target chunk.
  { query: "ship the database inside a mobile application", ids: [110, 112, 114, 116, 119, 121] },
  { query: "make repeated agent attempts cheap by rolling state back", ids: [7, 47] },
  { query: "combine keyword matching and nearest neighbour search in one request", ids: [50] },
  { query: "measure the latency tail when writes and reads overlap", ids: [38, 41, 43, 45] },
  { query: "avoid running a separate daemon process", ids: [12, 14, 16, 18] },
  { query: "compile the engine so it runs inside a web page", ids: [170, 172, 174, 177] },
  { query: "try the product in the cloud without registering", ids: [52] },
  { query: "throughput comparison against Elasticsearch and Milvus", ids: [1, 3, 5] },
];

const corpus = Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, "data/corpus.json"), "utf8")));
const docs = corpus.map((d) => ({ id: d.id, title: d.title || "", text: `${d.title || ""}\n${d.content || ""}`.trim() }));

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function embedAll(extractor, texts, batchSize = 16) {
  const t0 = performance.now();
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const res = await extractor(texts.slice(i, i + batchSize), { pooling: "cls", normalize: true });
    for (let r = 0; r < Math.min(batchSize, texts.length - i); r++) {
      out.push(Float32Array.from(res.data.slice(r * 384, (r + 1) * 384)));
    }
  }
  return { vectors: out, ms: performance.now() - t0 };
}

function evaluate(docVecs, queryVecs, topK = 5) {
  const perQuery = [];
  for (let qi = 0; qi < GOLD.length; qi++) {
    const ranked = docVecs
      .map((vec, di) => ({ id: docs[di].id, score: cosine(queryVecs[qi], vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    const firstHit = ranked.findIndex((r) => GOLD[qi].ids.includes(r.id));
    perQuery.push({
      query: GOLD[qi].query,
      hitAt5: firstHit >= 0,
      rank: firstHit >= 0 ? firstHit + 1 : null,
      rr: firstHit >= 0 ? 1 / (firstHit + 1) : 0,
      top1: ranked[0]
        ? { id: ranked[0].id, title: docs.find((d) => d.id === ranked[0].id)?.title?.slice(0, 70) }
        : null,
    });
  }
  const recall = perQuery.filter((q) => q.hitAt5).length / perQuery.length;
  const mrr = perQuery.reduce((s, q) => s + q.rr, 0) / perQuery.length;
  return { recallAt5: recall, mrrAt5: mrr, perQuery };
}

const measurements = [];
const docVectorsByDtype = {};
for (const v of VARIANTS) {
  const abs = path.join(MODEL_DIR, v.file);
  const bytes = fs.existsSync(abs) ? fs.statSync(abs).size : null;
  const entry = { ...v, bytes, mib: bytes ? +(bytes / 1048576).toFixed(2) : null };
  if (!bytes) {
    entry.status = "missing";
    measurements.push(entry);
    console.log(`- ${v.label}: file missing (${v.file})`);
    continue;
  }
  try {
    const t0 = performance.now();
    const extractor = await pipeline("feature-extraction", MODEL_ID, { dtype: v.dtype, device: "cpu" });
    entry.loadMs = performance.now() - t0;
    const docRun = await embedAll(extractor, docs.map((d) => d.text.slice(0, 320)));
    docVectorsByDtype[v.dtype] = docRun.vectors;
    const queryRun = await embedAll(extractor, GOLD.map((g) => g.query));
    entry.indexEmbedMs = docRun.ms;
    entry.msPerDoc = docRun.ms / docs.length;
    entry.queryEmbedMs = queryRun.ms / GOLD.length;
    Object.assign(entry, evaluate(docRun.vectors, queryRun.vectors));
    entry.status = "ok";
  } catch (err) {
    entry.status = "error";
    entry.error = String(err?.message || err).slice(0, 300);
  }
  measurements.push(entry);
  console.log(`- ${v.label}: ${entry.mib} MiB | ${entry.status}` +
    (entry.status === "ok" ? ` | load ${entry.loadMs.toFixed(0)} ms | ${entry.msPerDoc.toFixed(1)} ms/doc | Recall@5 ${(entry.recallAt5 * 100).toFixed(1)}% | MRR@5 ${entry.mrrAt5.toFixed(3)}` : ` | ${entry.error}`));
}

const fp32Vectors = docVectorsByDtype.fp32;
if (fp32Vectors) {
  for (const entry of measurements) {
    const vecs = docVectorsByDtype[entry.dtype];
    if (entry.status !== "ok" || !vecs) continue;
    const sims = vecs.map((vec, i) => cosine(vec, fp32Vectors[i]));
    sims.sort((a, b) => a - b);
    entry.embeddingAgreement = {
      meanCosineVsFp32: +(sims.reduce((s, x) => s + x, 0) / sims.length).toFixed(6),
      minCosineVsFp32: +sims[0].toFixed(6),
      p05CosineVsFp32: +sims[Math.floor(sims.length * 0.05)].toFixed(6),
    };
  }
}

const fp32 = measurements.find((m) => m.dtype === "fp32" && m.status === "ok");
const int8 = measurements.find((m) => m.dtype === "q8" && m.status === "ok");
const report = {
  generatedAt: new Date().toISOString(),
  runtime: `node ${process.versions.node} + @huggingface/transformers (onnxruntime-node, CPU EP)`,
  method: [
    "Same corpus (data/corpus.json, 96 chunks) and same hand-labelled query set for every variant; embeddings use the CLS pooling + L2 normalisation the app uses.",
    "Quality = doc-level Recall@5 and MRR@5 over cosine similarity on 18 labelled queries (any listed id counts as a hit).",
    "Sizes are bytes on disk of the ONNX export only (tokenizer/config excluded).",
    "The shipped web app always embeds inside a browser Web Worker; this script only produces the quantization comparison.",
  ],
  corpusDocs: docs.length,
  goldQueries: GOLD.length,
  measurements: measurements.map((m) => ({
    dtype: m.dtype,
    label: m.label,
    file: `public/models/${MODEL_ID}/${m.file}`,
    bytes: m.bytes,
    mib: m.mib,
    status: m.status,
    ...(m.status === "ok"
      ? {
          loadMs: +m.loadMs.toFixed(1),
          indexEmbedMs: +m.indexEmbedMs.toFixed(1),
          msPerDoc: +m.msPerDoc.toFixed(1),
          queryEmbedMs: +m.queryEmbedMs.toFixed(1),
          recallAt5: +m.recallAt5.toFixed(4),
          mrrAt5: +m.mrrAt5.toFixed(4),
          perQuery: m.perQuery,
          ...(m.embeddingAgreement ? { embeddingAgreement: m.embeddingAgreement } : {}),
        }
      : { error: m.error }),
  })),
  deltas: fp32 && int8
    ? {
        int8SizeVsFp32: +((1 - int8.bytes / fp32.bytes) * 100).toFixed(2),
        int8RecallVsFp32: +((int8.recallAt5 - fp32.recallAt5) * 100).toFixed(2),
        int8MrrVsFp32: +(int8.mrrAt5 - fp32.mrrAt5).toFixed(4),
        fp16SizeVsFp32: measurements.find((m) => m.dtype === "fp16" && m.bytes)
          ? +((1 - measurements.find((m) => m.dtype === "fp16").bytes / fp32.bytes) * 100).toFixed(2)
          : null,
      }
    : null,
};

fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "results/quantization.json"), JSON.stringify(report, null, 2));
console.log(`\n[bench] wrote results/quantization.json`);
