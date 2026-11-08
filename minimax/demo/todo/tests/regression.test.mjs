import { test } from "node:test";
import assert from "node:assert/strict";
import { addTodo, listTodos, countByStatus } from "../store.mjs";

test("回归：新增待办返回自增 id 且默认 pending", () => {
  const a = addTodo("写规格");
  assert.equal(a.status, "pending");
  assert.ok(a.id >= 1);
});

test("回归：列表返回全部待办且不改原对象", () => {
  const before = listTodos().length;
  const b = addTodo("补测试", "done");
  assert.equal(listTodos().length, before + 1);
  const again = listTodos();
  again[0].title = "被外部改动";
  assert.notEqual(listTodos()[0].title, "被外部改动");
  assert.equal(countByStatus("done") >= 1, true, "计数应包含新加的 done 项: " + b.id);
});
