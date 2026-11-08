// 真实 MiniMax 开发会话：seekdb 检索上下文 → 发给 MiniMax → 应用其返回代码 → 跑测试。
// 所有调用记录（含 request_id）落盘到 docs/evidence/，不含任何凭据。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb, ensureSchema } from "../src/db.mjs";
import { ingest } from "../src/ingest.mjs";
import { buildContext } from "../src/context.mjs";
import { chat, endpoint, modelName } from "../src/minimax.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = path.join(ROOT, "demo/todo/store.mjs");
const TASK = "给待办列表增加按状态筛选";
const TARGET_TEST = "demo/todo/tests/target.test.mjs";
const EVIDENCE_DIR = path.join(ROOT, "docs/evidence");

function runTest(file) {
  const r = spawnSync(process.execPath, ["--test", file], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return {
    file,
    exitCode: r.status,
    passed: r.status === 0,
    output: `${r.stdout || ""}${r.stderr || ""}`.trim(),
  };
}

function extractFunctionBlock(src, name) {
  const start = src.indexOf(`export function ${name}`);
  if (start < 0) return null;
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1, code: src.slice(start, i + 1) };
    }
  }
  return null;
}

function pickCodeBlock(text, name) {
  const blocks = [...text.matchAll(/```(?:js|javascript|mjs)?\n([\s\S]*?)```/g)].map((m) => m[1]);
  const withFn = blocks.filter((b) => b.includes(`function ${name}`));
  if (withFn.length) return withFn[withFn.length - 1].trimEnd();
  if (text.includes(`export function ${name}`)) {
    const blk = extractFunctionBlock(text, name);
    if (blk) return blk.code;
  }
  return null;
}

function applyPatch(file, name, newCode) {
  const src = fs.readFileSync(file, "utf8");
  const blk = extractFunctionBlock(src, name);
  if (!blk) throw new Error(`在 ${file} 中未找到函数 ${name}`);
  const patched = `${src.slice(0, blk.start)}${newCode}${src.slice(blk.end)}`;
  fs.writeFileSync(file, patched);
  return { before: blk.code, after: newCode, changed: blk.code !== newCode };
}

async function main() {
  process.chdir(ROOT);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const handle = await openDb();
  const conn = handle.conn;
  await ensureSchema(conn);
  await ingest(conn);

  const ctx = await buildContext(conn, TASK, { limit: 3 });
  const currentStore = fs.readFileSync(STORE, "utf8");
  const targetSrc = fs.readFileSync(path.join(ROOT, TARGET_TEST), "utf8");

  const before = runTest(TARGET_TEST);

  const specText = ctx.specs
    .map((s) => `【规格 ${s.id}】${s.title}\n${s.summary}\n距离=${s.distance.toFixed(3)}`)
    .join("\n\n");

  const messages = [
    {
      role: "system",
      content:
        "你是资深 JavaScript 工程师，在 SDD 流程中负责实现代码。只输出一个 ```js 代码块，代码块内只包含 export function filterByStatus(status) 的完整实现，不要输出解释、不要输出其它函数。要求：返回匹配 status 的条目副本数组、保持创建顺序、不修改内部存储、状态不存在时返回空数组。",
    },
    {
      role: "user",
      content: [
        `开发任务：${TASK}`,
        `当前代码（${ctx.code.map((c) => c.source).join(", ")}）：`,
        "```js",
        currentStore,
        "```",
        "适用的规格（由 seekdb 向量检索得到）：",
        specText,
        "目标测试（当前失败原因即 filterByStatus 未实现）：",
        "```js",
        targetSrc,
        "```",
        "请给出实现。",
      ].join("\n"),
    },
  ];

  const rounds = [];
  let patch = null;
  let after = before;

  for (let round = 1; round <= 2; round += 1) {
    const resp = await chat(messages, { maxTokens: 1024, temperature: round === 1 ? 0.2 : 0.1 });
    const code = pickCodeBlock(resp.content, "filterByStatus");
    const record = {
      round,
      endpoint: resp.endpoint,
      model: resp.model,
      requestId: resp.requestId,
      startedAt: resp.startedAt,
      latencyMs: resp.latencyMs,
      usage: resp.usage,
      requestMessages: messages,
      responseContent: resp.content,
      extractedCode: code,
    };
    rounds.push(record);
    if (!code) {
      messages.push({ role: "assistant", content: resp.content });
      messages.push({ role: "user", content: "上一条回复里没有可用的 ```js 代码块。请只输出一个包含 export function filterByStatus(status) 的 js 代码块。" });
      continue;
    }
    patch = applyPatch(STORE, "filterByStatus", code);
    after = runTest(TARGET_TEST);
    if (after.passed) break;
    messages.push({ role: "assistant", content: resp.content });
    messages.push({
      role: "user",
      content: `应用你的代码后目标测试仍失败，输出如下，请修正并只输出新的 js 代码块：\n${after.output.slice(0, 1200)}`,
    });
  }

  const regression = runTest("demo/todo/tests/regression.test.mjs");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(EVIDENCE_DIR, `minimax-session-${stamp}.json`);
  const mdPath = path.join(EVIDENCE_DIR, `minimax-session-${stamp}.md`);
  const evidence = {
    task: TASK,
    recordedAt: new Date().toISOString(),
    context: ctx,
    endpoint: rounds[0] ? rounds[0].endpoint : endpoint(),
    model: rounds[0] ? rounds[0].model : modelName(),
    targetTestBefore: { passed: before.passed, exitCode: before.exitCode },
    targetTestAfter: { passed: after.passed, exitCode: after.exitCode },
    regression,
    rounds,
    appliedPatch: patch,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);

  const md = [
    "# MiniMax 真实开发会话记录",
    "",
    `- 任务：${TASK}`,
    `- 时间：${evidence.recordedAt}`,
    `- 端点：\`${evidence.endpoint}\``,
    `- 模型：\`${evidence.model}\``,
    `- 调用轮次：${rounds.length}`,
    "",
    "## 上下文来源（seekdb 向量检索）",
    "",
    ...ctx.specs.map((s) => `- 规格 \`${s.id}\` ${s.title}（distance=${s.distance.toFixed(3)}）`),
    ...ctx.code.map((c) => `- 代码 \`${c.source}\`（distance=${c.distance.toFixed(3)}）`),
    ...ctx.tests.map((t) => `- 测试 \`${t.source}\`（distance=${t.distance.toFixed(3)}）`),
    "",
    "## 调用明细",
    "",
    ...rounds.map((r) =>
      [
        `### 第 ${r.round} 轮`,
        "",
        `- request_id：\`${r.requestId}\``,
        `- 模型：\`${r.model}\``,
        `- 耗时：${r.latencyMs} ms`,
        `- usage：${JSON.stringify(r.usage)}`,
        "",
        "返回内容：",
        "",
        "```text",
        String(r.responseContent).slice(0, 2000),
        "```",
        "",
      ].join("\n")
    ),
    "## 代码差异（MiniMax 返回并被应用）",
    "",
    "改前：",
    "",
    "```js",
    patch ? patch.before : "(未产出可用补丁)",
    "```",
    "",
    "改后：",
    "",
    "```js",
    patch ? patch.after : "(未产出可用补丁)",
    "```",
    "",
    "## 测试结果",
    "",
    `- 目标测试 改前：${before.passed ? "通过" : "失败"}（exit=${before.exitCode}）`,
    `- 目标测试 改后：${after.passed ? "通过" : "失败"}（exit=${after.exitCode}）`,
    `- 回归测试：${regression.passed ? "全部通过" : "存在失败"}（exit=${regression.exitCode}）`,
    "",
    "目标测试 改后输出：",
    "",
    "```text",
    after.output.slice(0, 1500),
    "```",
    "",
  ].join("\n");
  fs.writeFileSync(mdPath, md);

  await handle.close();
  console.log(
    JSON.stringify(
      {
        ok: after.passed && regression.passed,
        jsonPath: path.relative(ROOT, jsonPath),
        mdPath: path.relative(ROOT, mdPath),
        rounds: rounds.map((r) => ({ round: r.round, requestId: r.requestId, latencyMs: r.latencyMs })),
        targetBefore: before.passed,
        targetAfter: after.passed,
        regression: regression.passed,
      },
      null,
      2
    )
  );
  if (!after.passed || !regression.passed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("会话失败：", e.message);
  process.exitCode = 1;
});
