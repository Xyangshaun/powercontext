import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { embed, DIM } from "../src/embed.mjs";
import { openDb, ensureSchema } from "../src/db.mjs";
import { ingest, collectNotes, collectDecisions } from "../src/ingest.mjs";
import { recall } from "../src/recall.mjs";
import { decisionFromHits } from "../src/workbench.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("嵌入确定且为 384 维", () => {
  const a = embed("向量索引怎么选");
  assert.equal(JSON.parse(a).length, DIM);
  assert.equal(embed("向量索引怎么选"), a);
  assert.notEqual(embed("完全不同的文本"), a);
});

test("文献与决策都被采集到，且来源文件真实存在", () => {
  const notes = collectNotes();
  const decisions = collectDecisions();
  assert.equal(notes.length >= 3, true, `notes=${notes.length}`);
  assert.equal(decisions.length >= 2, true, `decisions=${decisions.length}`);
  for (const n of notes) assert.equal(fs.existsSync(path.join(ROOT, "notes", `${n.id}.md`)), true, n.id);
  for (const d of decisions) assert.equal(fs.existsSync(path.join(ROOT, "decisions", `${d.id}.md`)), true, d.id);
});

test("seekdb 建表入库后，向量检索能召回相关内容", async () => {
  const handle = await openDb();
  try {
    await ensureSchema(handle.conn);
    const counts = await ingest(handle.conn);
    assert.equal(counts.notes >= 3, true);
    assert.equal(counts.decisions >= 2, true);

    const ctx = await recall(handle.conn, "单机向量索引该怎么选", { limit: 3 });
    assert.equal(ctx.notes.length > 0, true, "应有文献命中");
    assert.equal(ctx.decisions.length > 0, true, "应有决策命中");

    // 命中的来源文件必须真实存在
    for (const n of ctx.notes) assert.equal(fs.existsSync(path.join(ROOT, n.source)), true, n.source);
    for (const d of ctx.decisions) assert.equal(fs.existsSync(path.join(ROOT, d.source)), true, d.source);

    // 距离单调不降
    const dists = ctx.notes.map((n) => n.distance);
    for (let i = 1; i < dists.length; i++) assert.equal(dists[i] >= dists[i - 1], true);

    // 索引型课题应当召回向量索引相关的决策
    assert.equal(
      ctx.decisions.some((d) => d.source.includes("vector-index-choice")),
      true,
      `实际召回: ${ctx.decisions.map((d) => d.source).join(",")}`
    );
  } finally {
    await handle.close();
  }
});

test("决策读回兼容 PowerContext 1.4.0 的 hits[].memory.text", () => {
  const topic = "向量索引选型";
  const payload = { topic, note: "采用 IVF", at: "2026-11-11T00:00:00.000Z" };
  const v14 = decisionFromHits("scope-1", [{ memory: { text: `${topic}\n${JSON.stringify(payload)}` } }], topic);
  assert.equal(v14.decision.note, "采用 IVF");

  // 旧结构 hits[].text 仍可用，且同一课题取 at 最新的一条
  const older = decisionFromHits("scope-1", [
    { text: `${topic}\n{"topic":"${topic}","at":"2026-11-10T00:00:00.000Z"}` },
    { text: `${topic}\n{"topic":"${topic}","at":"2026-11-11T00:00:00.000Z"}` },
  ], topic);
  assert.equal(older.decision.at, "2026-11-11T00:00:00.000Z");

  // 其它课题或无关记录不误判
  assert.equal(decisionFromHits("scope-1", [{ memory: { text: "无关记录" } }], topic).decision, null);
});

test("PowerContext 不可用时，召回明确降级而不中断", async () => {
  const handle = await openDb();
  try {
    await ensureSchema(handle.conn);
    await ingest(handle.conn);
    const prev = process.env.POWERCONTEXT_URL;
    process.env.POWERCONTEXT_URL = "http://127.0.0.1:1";
    const ctx = await recall(handle.conn, "向量索引怎么选", { limit: 2 });
    assert.equal(ctx.memory.available, false);
    assert.equal(typeof ctx.memory.error, "string");
    assert.equal(ctx.notes.length > 0, true, "降级时向量检索仍应给出结果");
    if (prev === undefined) delete process.env.POWERCONTEXT_URL;
    else process.env.POWERCONTEXT_URL = prev;
  } finally {
    await handle.close();
  }
});
