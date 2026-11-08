// 示例业务工程：待办清单（内存存储，供 SDD 模块改造与测试）
let seq = 0;
const rows = [];

export function addTodo(title, status = "pending") {
  if (!title) throw new Error("title 必填");
  const item = { id: ++seq, title, status };
  rows.push(item);
  return { ...item };
}

export function listTodos() {
  return rows.map((r) => ({ ...r }));
}

// 目标功能：按状态筛选，保持创建顺序。当前未实现，目标测试应先失败。
export function filterByStatus(status) {
  if (status !== "pending" && status !== "done") return [];
  return rows.filter((r) => r.status === status).map((r) => ({ ...r }));
}

export function countByStatus(status) {
  return rows.filter((r) => r.status === status).length;
}
