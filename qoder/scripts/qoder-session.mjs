// 真实开发会话记录：seekdb 向量检索召回 → PowerContext 写入与读回决策 → 落盘 evidence。
// 每次 HTTP 调用都记录服务返回的 X-PowerContext-Request-ID 与耗时，不含任何凭据。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb, ensureSchema } from "../src/db.mjs";
import { ingest } from "../src/ingest.mjs";
import { recall } from "../src/recall.mjs";
import { saveDecision, loadDecision } from "../src/workbench.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_DIR = path.join(ROOT, "docs/evidence");
const QUESTION = "单机向量索引该怎么选";
const TOPIC = "向量索引选型";

function runTest() {
  const r = spawnSync(process.execPath, ["--test", "test/workbench.test.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return {
    file: "test/workbench.test.mjs",
    exitCode: r.status,
    passed: r.status === 0,
    output: `${r.stdout || ""}${r.stderr || ""}`.trim(),
  };
}

async function main() {
  process.chdir(ROOT);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const handle = await openDb();
  const conn = handle.conn;
  await ensureSchema(conn);
  const counts = await ingest(conn);

  const ctx = await recall(conn, QUESTION, { limit: 3 });

  // PowerContext 侧的真实调用：写入一条决策，再在新的一次调用里读回。
  const calls = [];
  let memoryAvailable = false;
  try {
    const saved = await saveDecision(TOPIC, "采用 IVF 平面索引，索引只保存质心与归属，不保留全量向量");
    calls.push({
      step: "remember",
      endpoint: saved.endpoint,
      method: "POST",
      scopeId: saved.scopeId,
      requestId: saved.requestId,
      latencyMs: saved.latencyMs,
      body: { scope_id: saved.scopeId, kind: "research_decision", text: `${TOPIC}\n${JSON.stringify(saved.payload)}` },
      receipt: saved.receipt,
    });

    const loaded = await loadDecision(TOPIC);
    calls.push({
      step: "search",
      endpoint: loaded.endpoint,
      method: "POST",
      scopeId: loaded.scopeId,
      requestId: loaded.requestId,
      latencyMs: loaded.latencyMs,
      mode: loaded.mode,
      body: { scope_id: loaded.scopeId, query: TOPIC, limit: 10, mode: "fts" },
      hits: loaded.hits,
      hitCount: (loaded.hits || []).length,
      hitNote: "同一决策在多次会话中被反复写入，因此检索会返回多条历史记录；读回逻辑按 at 取最新一条。",
      decision: loaded.decision,
    });
    memoryAvailable = true;
  } catch (e) {
    calls.push({ step: "remember", error: String(e.message || e) });
  }

  const tests = runTest();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(EVIDENCE_DIR, `qoder-session-${stamp}.json`);
  const mdPath = path.join(EVIDENCE_DIR, `qoder-session-${stamp}.md`);
  const evidence = {
    task: QUESTION,
    recordedAt: new Date().toISOString(),
    ingest: counts,
    context: ctx,
    memoryAvailable,
    calls,
    tests,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);

  const md = [
    "# Qoder 文献工作台 · 真实运行记录",
    "",
    `- 任务：${QUESTION}`,
    `- 时间：${evidence.recordedAt}`,
    `- 入库：文献 ${counts.notes} 条、研究决策 ${counts.decisions} 条`,
    `- 记忆后端：${memoryAvailable ? "PowerContext Server（真实 HTTP 调用，request_id 见下）" : "不可用，已如实降级"}`,
    "",
    "## 上下文来源（seekdb 向量检索）",
    "",
    ...ctx.notes.map((n) => `- 文献 \`${n.source}\` ${n.title}（distance=${n.distance.toFixed(3)}）`),
    ...ctx.decisions.map((d) => `- 决策 \`${d.source}\` ${d.topic}（distance=${d.distance.toFixed(3)}）`),
    "",
    "## PowerContext 调用明细",
    "",
    ...calls.map((c) =>
      [
        `### ${c.step}`,
        "",
        `- endpoint：\`${c.endpoint || "-"}\``,
        `- method：\`${c.method || "-"}\``,
        `- scope_id：\`${c.scopeId || "-"}\``,
        `- request_id：\`${c.requestId || "-"}\``,
        `- 耗时：${c.latencyMs === undefined ? "-" : c.latencyMs + " ms"}`,
        c.hitCount !== undefined ? `- 命中条数：${c.hitCount}（${c.hitNote || ""}）` : "",
        c.error ? `- 错误：${c.error}` : "",
        "",
        "请求体：",
        "",
        "```json",
        JSON.stringify(c.body || {}, null, 2).slice(0, 1200),
        "```",
        "",
        "回包：",
        "",
        "```json",
        JSON.stringify(c.receipt || c.hits || c.decision || {}, null, 2).slice(0, 1600),
        "```",
        "",
      ].filter((x) => x !== "").join("\n")
    ),
    "## 测试结果",
    "",
    `- 测试文件：\`${tests.file}\``,
    `- 结果：${tests.passed ? "全部通过" : "存在失败"}（exit=${tests.exitCode}）`,
    "",
    "```text",
    tests.output.slice(0, 2000),
    "```",
    "",
  ].join("\n");
  fs.writeFileSync(mdPath, md);

  await handle.close();
  console.log(
    JSON.stringify(
      {
        ok: tests.passed && ctx.notes.length > 0 && ctx.decisions.length > 0,
        jsonPath: path.relative(ROOT, jsonPath),
        mdPath: path.relative(ROOT, mdPath),
        notes: ctx.notes.length,
        decisions: ctx.decisions.length,
        memoryAvailable,
        calls: calls.map((c) => ({ step: c.step, requestId: c.requestId || null, latencyMs: c.latencyMs })),
        testsPassed: tests.passed,
      },
      null,
      2
    )
  );
  if (!tests.passed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("会话失败：", e.message);
  process.exitCode = 1;
});
