import { test } from "node:test";
import assert from "node:assert/strict";
import { addTodo, filterByStatus } from "../store.mjs";

// 目标测试：改前应因 filterByStatus 未实现而失败；改造后应全部通过。
test("目标：按状态筛选只返回匹配项并保持创建顺序", () => {
  addTodo("A-pending", "pending");
  addTodo("B-done", "done");
  addTodo("C-pending", "pending");
  const pending = filterByStatus("pending");
  assert.deepEqual(pending.map((x) => x.title).slice(-2), ["A-pending", "C-pending"]);
  assert.equal(pending.every((x) => x.status === "pending"), true);
  assert.equal(filterByStatus("done").every((x) => x.status === "done"), true);
});
