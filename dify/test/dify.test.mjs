// 运行验证：与 dify/aji-inn-chatflow.yml 的三个节点一一对应。
// PowerContext 可用时验证真实调用；不可用时验证降级行为明确。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore, handleTurn } from "../server.mjs";
import { hitText, hitCitation } from "../src/powercontext.mjs";
import { closeLedger } from "../src/ledger.mjs";

after(async () => {
  await closeLedger();
});

const REMEMBER_TEXT = "记住，我把你后厨的铜锅砸了个豁口。";
const RECALL_TEXT = "掌柜的，你还记得我上次干了什么吗？";
const BASE = process.env.POWERCONTEXT_BASE_URL || "http://127.0.0.1:8787";

async function powerContextUp() {
  try {
    const res = await fetch(BASE + "/v1/scope-bindings/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow_default: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

test("PowerContext 可用时，记账与翻旧账走真实后端并带回 request_id", async (t) => {
  if (!(await powerContextUp())) {
    t.skip("PowerContext 未部署，跳过真实后端用例");
    return;
  }
  const store = createMemoryStore();
  const r1 = await handleTurn(REMEMBER_TEXT, store);
  assert.equal(r1.backend, "powercontext");
  assert.equal(r1.mode, "remote");
  assert.equal(typeof r1.requestId, "string");
  assert.ok(r1.requestId.length > 0, "应带回 X-PowerContext-Request-ID");
  assert.equal(r1.hits.length, 1);
  assert.ok(r1.hits[0].entry_id, "应带回记忆条目标识");

  const r2 = await handleTurn(RECALL_TEXT, store);
  assert.equal(r2.backend, "powercontext");
  assert.equal(r2.mode, "remote");
  assert.ok(r2.requestId.length > 0);
  assert.equal(r2.hits.length >= 1, true);
  assert.match(r2.reply, /翻到了/);
});

test("PowerContext 不可用时降级到真实 seekdb 账本，并给出原因", async (t) => {
  const store = createMemoryStore();
  assert.equal(store.kind, "seekdb");
  const prev = process.env.POWERCONTEXT_BASE_URL;
  process.env.POWERCONTEXT_BASE_URL = "http://127.0.0.1:1";
  const unique = `记住，测试落库 ${Date.now()}`;
  try {
    const r = await handleTurn(unique, store);
    assert.equal(r.backend, "degraded");
    assert.equal(r.mode, "local");
    assert.equal(r.ledger, "seekdb");
    assert.equal(typeof r.error, "string");
    assert.match(r.reply, /记忆服务不可用/);
    assert.ok(r.hits.length === 1 && r.hits[0].entry_id, "应写入 seekdb 并回带条目号");

    // 再翻旧账：能从 seekdb 读回，证明不是进程内存。
    const back = await store.find(unique.replace(/^记住，/, ""));
    assert.ok(back && back.entry_id, "seekdb 中应能按正文查回这条");
  } finally {
    if (prev === undefined) delete process.env.POWERCONTEXT_BASE_URL;
    else process.env.POWERCONTEXT_BASE_URL = prev;
  }
});

test("没说要记的句子不入账，也翻不出来", async () => {
  const store = createMemoryStore();
  const prev = process.env.POWERCONTEXT_BASE_URL;
  process.env.POWERCONTEXT_BASE_URL = "http://127.0.0.1:1";
  try {
    const r = await handleTurn("我偷偷往你酒坛里兑了水。", store);
    assert.equal(r.hits.length, 0);
    assert.match(r.reply, /没听清你要记什么/);
  } finally {
    if (prev === undefined) delete process.env.POWERCONTEXT_BASE_URL;
    else process.env.POWERCONTEXT_BASE_URL = prev;
  }
});

test("检索结果兼容 PowerContext 1.4.0 的 hits[].memory.text 与旧版 hits[].text", () => {
  const v14 = { memory: { text: "铜锅砸了个豁口", citation: { entry_id: "e1" } } };
  assert.equal(hitText(v14), "铜锅砸了个豁口");
  assert.equal(hitCitation(v14).entry_id, "e1");
  const old = { text: "铜锅砸了个豁口" };
  assert.equal(hitText(old), "铜锅砸了个豁口");
  assert.equal(hitText({}), "");
});
