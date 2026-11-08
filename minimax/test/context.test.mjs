import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { embed, DIM } from "../src/embed.mjs";
import { openDb, ensureSchema } from "../src/db.mjs";
import { ingest } from "../src/ingest.mjs";
import { buildContext } from "../src/context.mjs";

test("嵌入确定且为 384 维", () => {
  const a = embed("按状态筛选待办");
  assert.equal(JSON.parse(a).length, DIM);
  assert.equal(embed("按状态筛选待办"), a);
  assert.notEqual(embed("完全不同的文本"), a);
});

test("上下文中的规格/代码/测试来源在仓库里真实存在", async () => {
  const db = await openDb();
  try {
    await ensureSchema(db.conn);
    const counts = await ingest(db.conn);
    assert.equal(counts.specs >= 2, true);
    const ctx = await buildContext(db.conn, "给待办列表增加按状态筛选");
    assert.equal(ctx.specs.length > 0 && ctx.code.length > 0 && ctx.tests.length > 0, true);
    for (const s of ctx.specs) assert.equal(fs.existsSync(s.source), true, s.source);
    for (const c of ctx.code) assert.equal(fs.existsSync(c.path), true, c.path);
    for (const t of ctx.tests) assert.equal(fs.existsSync(t.path), true, t.path);
    assert.equal(ctx.code.some((c) => c.symbol === "filterByStatus"), true);
  } finally {
    await db.close();
  }
});
