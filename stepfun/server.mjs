import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seekdb } from "@oceanbase/seekdb-node";
import mysql from "mysql2/promise";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const RESULTS_DIR = path.join(ROOT, "results");
const DB_DIR = path.join(DATA_DIR, "seekdb");
const PORT = Number(process.env.PORT || 8787);
const DIM = 384;
const TABLE = "docs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function decodeVector(value) {
  if (Array.isArray(value)) {
    if (value.length !== DIM) throw new Error(`vector dim ${value.length} != ${DIM}`);
    return "[" + value.map((v) => Number(v).toFixed(6)).join(",") + "]";
  }
  if (typeof value === "string") {
    const buf = Buffer.from(value, "base64");
    if (buf.byteLength !== DIM * 4) throw new Error(`vector bytes ${buf.byteLength} != ${DIM * 4}`);
    const f32 = new Float32Array(DIM);
    for (let i = 0; i < DIM; i++) f32[i] = buf.readFloatLE(i * 4);
    return "[" + Array.from(f32, (v) => v.toFixed(6)).join(",") + "]";
  }
  throw new Error("embedding must be base64 Float32 or number array");
}

const send = (res, status, body, type = "application/json; charset=utf-8") => {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(payload);
};

const dbStart = performance.now();
const db = await seekdb.open(DB_DIR, { parameters: { memory_budget: "2G" } });
const endpoint = db.connectionOptions();
const conn = await mysql.createConnection({
  ...(endpoint.transport === "tcp"
    ? { host: endpoint.host, port: endpoint.port }
    : { socketPath: endpoint.unixSocket }),
  user: endpoint.user,
  password: "",
  database: "test",
});
const dbOpenMs = performance.now() - dbStart;

const [[versionRow]] = await conn.query("SELECT VERSION() AS v");
const version = versionRow.v;

async function ensureTable() {
  await conn.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INT PRIMARY KEY,
    title TEXT,
    content TEXT,
    source TEXT,
    embedding VECTOR(${DIM}),
    FULLTEXT INDEX idx_docs_fts (content),
    VECTOR INDEX idx_docs_vec (embedding) WITH (DISTANCE=l2, TYPE=hnsw, LIB=vsag)
  )`);
}
await ensureTable();

async function resetTable() {
  await conn.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await ensureTable();
}

function hybridSql(k, candidates) {
  return `
SELECT d.id, d.title, d.content, d.source,
       MAX(u.rr) AS score,
       MAX(CASE WHEN u.src = 'v' THEN u.rnk END) AS vec_rank,
       MAX(CASE WHEN u.src = 'f' THEN u.rnk END) AS fts_rank
FROM (
  SELECT id, 'v' AS src, rnk, 1.0 / (60 + rnk) AS rr FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY l2_distance(embedding, ?) ASC) AS rnk
    FROM ${TABLE}
    ORDER BY l2_distance(embedding, ?) APPROXIMATE
    LIMIT ${candidates}
  ) v
  UNION ALL
  SELECT id, 'f' AS src, rnk, 1.0 / (60 + rnk) AS rr FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY MATCH(content) AGAINST(?) DESC) AS rnk
    FROM ${TABLE}
    WHERE MATCH(content) AGAINST(?)
    LIMIT ${candidates}
  ) f
) u
JOIN ${TABLE} d ON d.id = u.id
GROUP BY d.id, d.title, d.content, d.source
ORDER BY score DESC, vec_rank ASC
LIMIT ${k}`;
}

const routes = {
  "GET /api/meta": async () => {
    const [[{ c }]] = await conn.query(`SELECT COUNT(*) AS c FROM ${TABLE}`);
    return {
      ok: true,
      engine: "seekdb",
      version,
      dimension: DIM,
      table: TABLE,
      indexedDocs: c,
      serverStartedAt: new Date().toISOString(),
      embedder: {
        model: "Xenova/bge-small-en-v1.5 (BAAI/bge-small-en-v1.5)",
        quantization: "int8 (onnx model_quantized.onnx)",
        runtime: "transformers.js + onnxruntime-web",
      },
      dbOpenMs,
      offlineReady: true,
    };
  },
  "POST /api/reset": async () => {
    await resetTable();
    return { ok: true };
  },
  "POST /api/index": async (body) => {
    const docs = body?.docs;
    if (!Array.isArray(docs) || docs.length === 0) throw new Error("docs is required");
    const rows = docs.map((d) => {
      if (!Number.isInteger(d.id)) throw new Error("doc id must be integer");
      return [d.id, String(d.title ?? ""), String(d.content ?? ""), String(d.source ?? ""), decodeVector(d.embedding)];
    });
    await conn.query(`DELETE FROM ${TABLE}`);
    const tWrite = performance.now();
    for (let i = 0; i < rows.length; i += 40) {
      await conn.query(`INSERT INTO ${TABLE} (id, title, content, source, embedding) VALUES ?`, [rows.slice(i, i + 40)]);
    }
    const writeMs = performance.now() - tWrite;
    const tRefresh = performance.now();
    await conn.query(`CALL DBMS_VECTOR.REFRESH_INDEX('idx_docs_vec', '${TABLE}', 'embedding', 1, 'FAST')`);
    const refreshMs = performance.now() - tRefresh;
    return {
      ok: true,
      inserted: rows.length,
      timings: { writeMs, refreshMs, totalMs: writeMs + refreshMs },
    };
  },
  "POST /api/search": async (body) => {
    const query = String(body?.query ?? "").trim();
    if (!query) throw new Error("query is required");
    if (!body?.embedding) throw new Error("embedding is required");
    const k = Math.min(Math.max(Number(body.k) || 8, 1), 30);
    const candidates = Math.min(Math.max(Number(body.candidates) || 40, k), 200);
    const vec = decodeVector(body.embedding);
    const sql = hybridSql(k, candidates);
    const t0 = performance.now();
    const [rows] = await conn.query(sql, [vec, vec, query, query]);
    const sqlMs = performance.now() - t0;
    return {
      ok: true,
      sqlMs,
      k,
      candidates,
      engine: "seekdb",
      hybridInEngine: true,
      statement: { fulltext: "MATCH(content) AGAINST(?)", vector: "l2_distance(embedding, ?) APPROXIMATE", fusion: "RRF k=60 in SQL" },
      results: rows.map((r) => ({
        id: r.id,
        title: r.title,
        content: r.content,
        source: r.source,
        score: Number(r.score),
        vecRank: r.vec_rank === null ? null : Number(r.vec_rank),
        ftsRank: r.fts_rank === null ? null : Number(r.fts_rank),
      })),
    };
  },
  "POST /api/explain": async (body) => {
    const sql = hybridSql(8, 40);
    const zero = "[" + Array(DIM).fill("0").join(",") + "]";
    const query = String(body?.query ?? "vector index").trim();
    const [rows] = await conn.query(`EXPLAIN ${sql}`, [zero, zero, query, query]);
    return {
      ok: true,
      statement: sql.trim(),
      plan: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v]))),
    };
  },
  "POST /api/results": async (body) => {
    if (!body || typeof body !== "object") throw new Error("payload required");
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const target = path.join(RESULTS_DIR, "submission-results.json");
    fs.writeFileSync(target, JSON.stringify(body, null, 2));
    return { ok: true, path: "results/submission-results.json", bytes: fs.statSync(target).size };
  },
  "GET /api/results": async () => {
    const file = path.join(RESULTS_DIR, "submission-results.json");
    if (!fs.existsSync(file)) return { ok: false, exists: false };
    return { ok: true, exists: true, data: JSON.parse(fs.readFileSync(file, "utf8")) };
  },
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (urlPath.startsWith("/api/")) return false;
  let rel;
  if (urlPath === "/") rel = "public/index.html";
  else if (urlPath.startsWith("/results/") || urlPath.startsWith("/data/")) rel = urlPath.slice(1);
  else rel = "public" + urlPath;
  const file = path.normalize(path.join(ROOT, rel));
  let resolved = file;
  if (!fs.existsSync(resolved) && urlPath.startsWith("/vendor/ort/")) {
    resolved = path.join(ROOT, "node_modules/onnxruntime-web/dist", path.basename(urlPath));
  }
  if (!resolved.startsWith(ROOT) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return false;
  const type = MIME[path.extname(resolved)] || "application/octet-stream";
  const headers = { "content-type": type, "cache-control": path.extname(resolved) === ".onnx" ? "public, max-age=86400" : "no-cache" };
  if (path.extname(resolved) === ".wasm") headers["cross-origin-embedder-policy"] = "require-corp";
  res.writeHead(200, headers);
  fs.createReadStream(resolved).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  const pathname = new URL(req.url, "http://localhost").pathname;
  const route = routes[`${req.method} ${pathname}`];
  if (route) {
    let body = null;
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
      catch { return send(res, 400, { ok: false, error: "invalid JSON body" }); }
    }
    try {
      const result = await route(body);
      return send(res, 200, result);
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message });
    }
  }
  if (req.method === "GET" && serveStatic(req, res)) return;
  if (req.method === "GET" && pathname === "/") return serveStatic(req, res);
  send(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, () => {
  console.log(`[stepfun] http://localhost:${PORT} | seekdb ${version} | ${endpoint.transport}`);
  console.log(`[stepfun] db open ${dbOpenMs.toFixed(0)} ms | dir ${DB_DIR}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    try { await conn.end(); } catch {}
    try { db.close(); } catch {}
    process.exit(0);
  });
}
