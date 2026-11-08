const $ = (id) => document.getElementById(id);
const QUERIES = [
  "how do I refresh a vector index",
  "fork a database to run an experiment safely",
  "difference between full-text search and vector search",
  "how to start seekdb locally and connect a client",
  "incremental HNSW index memory budget",
];

const state = {
  corpus: [],
  worker: null,
  ready: null,
  indexed: false,
  pending: new Map(),
  requestId: 0,
  results: null,
};

function setStatus(text) { $("status-line").textContent = text; }
function debugLog(line) {
  if (!/[?&]debug/.test(location.search)) return;
  console.info(`[stepfun] ${line}`);
}
function ms(value) { return value == null ? "—" : `${Math.round(value)}<small>ms</small>`; }

function markStep(activeId, doneIds = []) {
  for (const id of ["step-load", "step-embed", "step-index", "step-query"]) {
    const el = $(id);
    el.classList.toggle("active", id === activeId);
    el.classList.toggle("done", doneIds.includes(id));
  }
}

function spawnWorker({ preferWebGPU = true } = {}) {
  if (state.worker) state.worker.terminate();
  state.pending.clear();
  state.ready = null;
  state.worker = new Worker("/embed-worker.js", { type: "module" });
  const worker = state.worker;
  state.readyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("模型初始化超时（>180s），请查看 Console")), 180000);
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "ready") {
        clearTimeout(timer);
        state.ready = msg.info;
        resolve(msg.info);
      } else if (msg.type === "progress") {
        const p = msg.payload;
        if (p?.status === "progress" && p?.file) {
          const pct = p.progress ? ` ${Math.round(p.progress)}%` : "";
          setStatus(`下载/加载 ${p.file}${pct}`);
        }
      } else if (msg.type === "stage") {
        if (msg.status === "failed") setStatus(`${msg.device} 初始化失败，尝试降级…`);
      } else if (msg.type === "embed-progress") {
        setStatus(`向量化 ${msg.done}/${msg.total}`);
      } else if (msg.type === "embedded") {
        const pending = state.pending.get(msg.requestId);
        if (pending) {
          state.pending.delete(msg.requestId);
          pending.resolve({ vectors: msg.vectors, embedMs: msg.embedMs, device: msg.device });
        }
      } else if (msg.type === "error") {
        const pending = state.pending.get(msg.requestId);
        if (pending) {
          state.pending.delete(msg.requestId);
          pending.reject(new Error(msg.error));
        } else {
          reject(new Error(msg.error));
        }
      }
    };
    worker.onerror = (err) => {
      clearTimeout(timer);
      reject(new Error(`${err.message || "worker error"} @ ${err.filename || "worker"}:${err.lineno || 0}`));
    };
    worker.postMessage({ type: "init", preferWebGPU });
  });
  return state.readyPromise;
}

function embedTexts(texts, batchSize = 16) {
  const requestId = ++state.requestId;
  return new Promise((resolve, reject) => {
    state.pending.set(requestId, { resolve, reject });
    state.worker.postMessage({ type: "embed", requestId, texts, batchSize });
  });
}

async function postJSON(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadCorpus() {
  if (state.corpus.length) return state.corpus;
  const res = await fetch("/data/corpus.json");
  if (!res.ok) throw new Error("语料加载失败");
  state.corpus = await res.json();
  $("chip-docs").textContent = `${state.corpus.length} docs`;
  return state.corpus;
}

async function measureModelBytes() {
  try {
    const res = await fetch("/models/bge-small-en-v1.5/onnx/model_quantized.onnx", { method: "HEAD" });
    const len = Number(res.headers.get("content-length") || 0);
    return len || null;
  } catch { return null; }
}

const FORCE_WASM = /[?&]wasm/.test(location.search);
async function initModel(preferWebGPU = !FORCE_WASM) {
  markStep("step-load");
  const t0 = performance.now();
  const info = await spawnWorker({ preferWebGPU });
  debugLog(`init ${info.device} ${Math.round(performance.now() - t0)}ms`);
  const device = info.device || (info.failures?.[0] ? "wasm" : "unknown");
  $("chip-device").textContent = device === "webgpu" ? "WebGPU" : "WASM 降级";
  $("chip-device").className = `chip ${device === "webgpu" ? "ok" : "warn"}`;
  $("footer-device").textContent = `runtime: ${device} · dtype ${info.dtype}`;
  if (device !== "webgpu") $("fallback-banner").classList.remove("hidden");
  markStep("step-embed", ["step-load"]);
  return info;
}

async function buildIndex({ reset = true, onProgress } = {}) {
  const corpus = await loadCorpus();
  if (!state.ready) await initModel();
  if (reset) await postJSON("/api/reset", {});
  const tEmbed = performance.now();
  const texts = corpus.map((d) => `${d.title}. ${d.content.slice(0, 320)}`);
  debugLog(`embed start docs=${texts.length}`);
  const { vectors, embedMs } = await embedTexts(texts, 16);
  const wallEmbedMs = performance.now() - tEmbed;
  debugLog(`embed done ${Math.round(wallEmbedMs)}ms`);
  onProgress?.("embed", { embedMs, wallEmbedMs });
  $("m-embed").innerHTML = ms(wallEmbedMs);
  $("embed-info").textContent = `${corpus.length} 段 · ${(wallEmbedMs / corpus.length).toFixed(1)} ms/段`;
  markStep("step-index", ["step-load", "step-embed"]);
  setStatus("写入 seekdb 并刷新向量索引…");
  const index = await postJSON("/api/index", {
    docs: corpus.map((d, i) => ({
      id: d.id,
      title: d.title,
      content: d.content,
      source: d.source,
      embedding: vectors[i],
    })),
  });
  state.indexed = true;
  debugLog(`index done write=${Math.round(index.timings.writeMs)} refresh=${Math.round(index.timings.refreshMs)}`);
  $("m-write").innerHTML = ms(index.timings.writeMs);
  $("m-refresh").innerHTML = ms(index.timings.refreshMs);
  $("chip-docs").textContent = `${index.inserted} docs indexed`;
  $("chip-engine").textContent = "seekdb · hybrid ready";
  $("chip-engine").className = "chip ok";
  setStatus(`索引就绪：${index.inserted} 段，刷新 ${Math.round(index.timings.refreshMs)} ms`);
  markStep("step-query", ["step-load", "step-embed", "step-index"]);
  return { index, embedMs, wallEmbedMs, corpus: corpus.length };
}

async function runSearch(query) {
  if (!state.indexed) throw new Error("请先建立索引");
  const tEmbed = performance.now();
  const { vectors } = await embedTexts([query], 1);
  const queryEmbedMs = performance.now() - tEmbed;
  $("m-qembed").innerHTML = ms(queryEmbedMs);
  const tAll = performance.now();
  const response = await postJSON("/api/search", { query, embedding: vectors[0], k: 8, candidates: 40 });
  const e2eMs = performance.now() - tAll + queryEmbedMs;
  $("m-sql").innerHTML = ms(response.sqlMs);
  $("m-e2e").innerHTML = ms(e2eMs);
  $("sql-meta").textContent =
    `seekdb 单条 SQL · 向量索引 + 全文索引 · SQL ${response.sqlMs.toFixed(2)} ms · 候选 ${response.candidates} → 返回 ${response.results.length}`;
  renderResults(response.results);
  return { query, queryEmbedMs, sqlMs: response.sqlMs, e2eMs, results: response.results };
}

function renderResults(rows) {
  const host = $("results");
  if (!rows.length) {
    host.innerHTML = `<div class="empty">没有命中。可以换一个词，或重建索引。</div>`;
    return;
  }
  host.innerHTML = rows.map((r, i) => `
    <article class="card" style="animation-delay:${i * 35}ms">
      <div class="card-top">
        <h3>${escapeHtml(r.title)}</h3>
        <div class="badges">
          ${r.vecRank ? `<span class="badge vec">VEC #${r.vecRank}</span>` : ""}
          ${r.ftsRank ? `<span class="badge fts">FTS #${r.ftsRank}</span>` : ""}
          <span class="badge score">RRF ${r.score.toFixed(4)}</span>
        </div>
      </div>
      <p>${escapeHtml(r.content.slice(0, 320))}${r.content.length > 320 ? "…" : ""}</p>
      <div class="source">${escapeHtml(r.source)}</div>
    </article>`).join("");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function runPhase(label, onProgress) {
  const tPhase = performance.now();
  if (!state.ready) await initModel();
  else {
    // Re-load into a fresh worker so that warm model load is measured honestly.
    await initModel();
  }
  const loadMs = state.ready?.loadMs ?? null;
  $("m-load").innerHTML = ms(loadMs);
  const built = await buildIndex({ reset: true, onProgress });
  const queries = [];
  for (const q of QUERIES) {
    const r = await runSearch(q);
    queries.push(r);
  }
  const phaseMs = performance.now() - tPhase;
  return {
    label,
    device: state.ready?.device,
    stageMs: {
      modelLoadMs: loadMs,
      corpusEmbedMs: built.wallEmbedMs,
      indexWriteMs: built.index.timings.writeMs,
      indexRefreshMs: built.index.timings.refreshMs,
      indexTotalMs: built.index.timings.totalMs,
      phaseTotalMs: phaseMs,
    },
    queries,
    aggregate: {
      queries: queries.length,
      avgQueryEmbedMs: queries.reduce((s, q) => s + q.queryEmbedMs, 0) / queries.length,
      avgSqlMs: queries.reduce((s, q) => s + q.sqlMs, 0) / queries.length,
      avgE2eMs: queries.reduce((s, q) => s + q.e2eMs, 0) / queries.length,
      p50SqlMs: [...queries.map((q) => q.sqlMs)].sort((a, b) => a - b)[Math.floor(queries.length / 2)],
    },
  };
}

async function runEvaluation() {
  const btn = $("btn-eval");
  btn.disabled = true;
  try {
    const modelBytes = await measureModelBytes();
    setStatus("阶段 1/2：冷启动全链路…");
    $("metric-scope").textContent = "首次（冷）";
    const cold = await runPhase("cold");
    updateRunSummary(cold);
    setStatus("阶段 2/2：预热后重复全链路…");
    $("metric-scope").textContent = "预热后";
    const warm = await runPhase("warm");
    $("r-cold").textContent = `${Math.round(cold.stageMs.phaseTotalMs)} ms · SQL ${cold.aggregate.avgSqlMs.toFixed(2)} ms`;
    $("r-warm").textContent = `${Math.round(warm.stageMs.phaseTotalMs)} ms · SQL ${warm.aggregate.avgSqlMs.toFixed(2)} ms`;
    const quant = await fetch("/results/quantization.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const explain = await postJSON("/api/explain", { query: cold.queries[0]?.query || "vector index" }).catch(() => null);
    const payload = {
      schemaVersion: "stepfun-submission-results/v1",
      generatedAt: new Date().toISOString(),
      task: { id: "600073", name: "StepFun", points: 20 },
      environment: {
        userAgent: navigator.userAgent,
        webgpuAvailable: Boolean(navigator.gpu),
        deviceUsed: state.ready?.device,
        fallbackTriggered: state.ready?.device !== "webgpu",
      },
      model: {
        id: "Xenova/bge-small-en-v1.5",
        upstream: "BAAI/bge-small-en-v1.5",
        license: "MIT",
        dtype: "int8",
        file: "public/models/bge-small-en-v1.5/onnx/model_quantized.onnx",
        bytes: modelBytes ?? quant?.measurements?.find((m) => m.dtype === "q8")?.bytes ?? null,
        dimension: 384,
        runtime: "transformers.js 4.x + onnxruntime-web (WebGPU → WASM fallback)",
        embeddingsComputedIn: "browser (Web Worker)",
      },
      corpus: { docs: state.corpus.length, textUsed: "seekdb upstream docs (Apache-2.0), chunked", maxCandidates: 40, topK: 8 },
      retrieval: {
        engine: "seekdb (@oceanbase/seekdb-node, embedded)",
        statementCount: 1,
        hybridInEngine: true,
        fusion: "RRF k=60 computed inside the SQL",
        object: { table: "docs", vectorIndex: "idx_docs_vec (HNSW, l2, vsag)", fulltextIndex: "idx_docs_fts" },
        explain: explain?.plan ?? null,
        queries: cold.queries.map((q) => ({
          query: q.query,
          sqlMs: q.sqlMs,
          top: q.results.slice(0, 3).map((r) => ({ id: r.id, title: r.title, vecRank: r.vecRank, ftsRank: r.ftsRank, score: r.score })),
        })),
      },
      runs: { cold, warm },
      quantization: quant?.measurements ?? null,
      artifacts: {
        "results/submission-results.json": "written by this run",
        "results/quantization.json": quant ? "produced by scripts/benchmark-quant.mjs" : "not yet produced",
      },
      notes: [
        "All embeddings were computed in the browser worker; the server only stores vectors and runs SQL.",
        "Hybrid search is a single SQL statement executed by seekdb, using both the HNSW vector index and the full-text index.",
        "Cold vs warm runs are measured on the same machine and same corpus; cold includes the first model fetch.",
      ],
    };
    const saved = await postJSON("/api/results", payload);
    state.results = payload;
    setStatus(`评测完成，已写入 ${saved.path}（${(saved.bytes / 1024).toFixed(1)} KB）`);
    $("metric-scope").textContent = "双阶段实测完成";
  } catch (err) {
    setStatus(`评测失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function updateRunSummary(run) {
  $("m-load").innerHTML = ms(run.stageMs.modelLoadMs);
  $("m-embed").innerHTML = ms(run.stageMs.corpusEmbedMs);
  $("m-write").innerHTML = ms(run.stageMs.indexWriteMs);
  $("m-refresh").innerHTML = ms(run.stageMs.indexRefreshMs);
  $("r-cold").textContent = run.label === "cold" ? `${Math.round(run.stageMs.phaseTotalMs)} ms` : $("r-cold").textContent;
  $("r-warm").textContent = run.label === "warm" ? `${Math.round(run.stageMs.phaseTotalMs)} ms` : $("r-warm").textContent;
}

$("btn-build").addEventListener("click", async () => {
  const btn = $("btn-build");
  btn.disabled = true;
  try {
    setStatus("加载模型并建立索引…");
    await buildIndex({ reset: true });
    setStatus("索引就绪，可以输入查询。");
  } catch (err) {
    setStatus(`失败：${err.message}`);
  } finally { btn.disabled = false; }
});

$("btn-eval").addEventListener("click", runEvaluation);

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = $("query").value.trim();
  if (!query) return;
  try {
    setStatus("查询中…");
    await runSearch(query);
    setStatus("完成");
  } catch (err) {
    setStatus(err.message);
  }
});

(async () => {
  try {
    const meta = await (await fetch("/api/meta")).json();
    $("chip-engine").textContent = `seekdb ${meta.version}`;
    $("chip-engine").className = "chip ok";
    $("chip-docs").textContent = `${meta.indexedDocs} docs`;
    if (!navigator.gpu) {
      $("chip-device").textContent = "无 WebGPU · 将用 WASM";
      $("chip-device").className = "chip warn";
    }
    await loadCorpus();
    $("query").value = QUERIES[0];
  } catch (err) {
    setStatus(`初始化失败：${err.message}`);
    $("chip-engine").className = "chip bad";
  }
})();

if (/[?&]bench/.test(location.search)) {
  (async () => {
    try { await runEvaluation(); debugLog("bench done"); }
    catch (err) { debugLog(`bench failed: ${err.message}`); }
  })();
}

if (/[?&]auto/.test(location.search)) {
  (async () => {
    try {
      debugLog("auto build start");
      await buildIndex({ reset: true });
      debugLog("auto build ok");
      const r = await runSearch(QUERIES[0]);
      debugLog(`auto search ok sql=${r.sqlMs.toFixed(1)}`);
    } catch (err) {
      debugLog(`auto failed: ${err.message}`);
    }
  })();
}
