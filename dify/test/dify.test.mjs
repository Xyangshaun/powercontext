// 运行验证：与 dify/4.2-运行说明.md 第一节三个动作一一对应。
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore, handleTurn } from "../server.mjs";

test("记账动作写入账本并返回 entry_id", () => {
  const store = createMemoryStore();
  const r = handleTurn("记住，我把你后厨的铜锅砸了个豁口。", store);
  assert.equal(store.entries.length, 1);
  assert.equal(r.hits[0].entry_id, "e1");
  assert.match(r.reply, /账本第 1 条/);
});

test("换会话翻旧账能命中上一会话的条目", () => {
  const store = createMemoryStore();
  handleTurn("记住，我把你后厨的铜锅砸了个豁口。", store);
  const r = handleTurn("掌柜的，你还记得我上次干了什么吗？", store);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].entry_id, "e1");
  assert.match(r.reply, /铜锅/);
});

test("没说要记的句子不入账，也翻不出来", () => {
  const store = createMemoryStore();
  handleTurn("我偷偷往你酒坛里兑了水。", store);
  assert.equal(store.entries.length, 0);
  const r = handleTurn("掌柜的，你还记得我上次干了什么吗？", store);
  assert.equal(r.hits.length, 0);
  assert.match(r.reply, /还没你的名字/);
});
