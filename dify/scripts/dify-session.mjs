// 真实 Dify 编排等价运行：按 aji-inn-chatflow.yml 的节点顺序走一遍
// 解析作用域 -> 写入记忆 -> 召回记忆，每步记录 PowerContext 返回的 request_id。
// 证据落到 docs/evidence/，不含任何凭据。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handleTurn, createMemoryStore } from "../server.mjs";
import { closeLedger } from "../src/ledger.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_DIR = path.join(ROOT, "docs/evidence");
const REMEMBER_TEXT = "记住，我把你后厨的铜锅砸了个豁口。";
const RECALL_TEXT = "掌柜的，你还记得我上次干了什么吗？";

function runTest() {
  const r = spawnSync(process.execPath, ["--test", "test/dify.test.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return {
    file: "test/dify.test.mjs",
    exitCode: r.status,
    passed: r.status === 0,
    output: `${r.stdout || ""}${r.stderr || ""}`.trim(),
  };
}

async function main() {
  process.chdir(ROOT);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const store = createMemoryStore();

  const steps = [];
  const rememberResult = await handleTurn(REMEMBER_TEXT, store);
  steps.push({
    node: "写入记忆",
    pluginTool: "powercontext.memory.remember",
    endpoint: "POST /v1/memory/remember",
    requestId: rememberResult.requestId || null,
    mode: rememberResult.mode,
    backend: rememberResult.backend,
    input: REMEMBER_TEXT,
    output: { reply: rememberResult.reply, hits: rememberResult.hits },
    receipt: rememberResult.receipt || null,
  });

  const recallResult = await handleTurn(RECALL_TEXT, store);
  steps.push({
    node: "召回记忆",
    pluginTool: "powercontext.memory.search",
    endpoint: "POST /v1/memory/search",
    requestId: recallResult.requestId || null,
    mode: recallResult.mode,
    backend: recallResult.backend,
    input: RECALL_TEXT,
    output: { reply: recallResult.reply, hits: recallResult.hits },
  });

  const tests = runTest();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(EVIDENCE_DIR, `dify-workflow-${stamp}.json`);
  const mdPath = path.join(EVIDENCE_DIR, `dify-workflow-${stamp}.md`);
  const evidence = {
    app: "阿吉客栈 · 记仇掌柜",
    dsl: "dify/aji-inn-chatflow.yml",
    recordedAt: new Date().toISOString(),
    plugin: "powercontext/powercontext:0.0.1",
    remote: steps.every((s) => s.backend === "powercontext"),
    steps,
    tests,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);

  const md = [
    "# Dify 工作流真实运行记录",
    "",
    `- 应用：${evidence.app}`,
    `- 编排图：\`${evidence.dsl}\``,
    `- 时间：${evidence.recordedAt}`,
    `- 依赖插件：\`${evidence.plugin}\``,
    `- 记忆后端：${evidence.remote ? "PowerContext Server（真实 HTTP 调用，request_id 见下）" : "已降级，未连上真实后端"}`,
    "",
    "## 节点执行",
    "",
    ...steps.map((s) =>
      [
        `### ${s.node}`,
        "",
        `- 插件工具：\`${s.pluginTool}\``,
        `- endpoint：\`${s.endpoint}\``,
        `- request_id：\`${s.requestId || "-"}\``,
        `- mode：${s.mode}（backend=${s.backend}）`,
        "",
        "输入：",
        "",
        "```text",
        s.input,
        "```",
        "",
        "输出：",
        "",
        "```json",
        JSON.stringify(s.output, null, 2).slice(0, 1200),
        "```",
        "",
      ].join("\n")
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

  console.log(
    JSON.stringify(
      {
        ok: tests.passed && evidence.remote,
        jsonPath: path.relative(ROOT, jsonPath),
        mdPath: path.relative(ROOT, mdPath),
        remote: evidence.remote,
        steps: steps.map((s) => ({ node: s.node, requestId: s.requestId, backend: s.backend })),
        testsPassed: tests.passed,
      },
      null,
      2
    )
  );
  if (!tests.passed || !evidence.remote) process.exitCode = 1;
  await closeLedger();
}

main().catch((e) => {
  console.error("会话失败：", e.message);
  process.exitCode = 1;
});
