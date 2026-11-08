import { resolveScope, remember, search } from "./powercontext.mjs";

const KIND = "sdd_task_state";

export async function saveState(task, patch) {
  const scopeId = await resolveScope();
  const payload = {
    task,
    done: patch.done || [],
    todo: patch.todo || [],
    verified: patch.verified || [],
    at: new Date().toISOString(),
  };
  const body = await remember(
    scopeId,
    KIND,
    `${task}\n${JSON.stringify(payload)}`,
    "SDD 上下文模块保存任务进展"
  );
  return { scopeId, payload, receipt: body.memory || body };
}

export async function loadState(task) {
  const scopeId = await resolveScope();
  const body = await search(scopeId, task, 10);
  const hits = body.hits || [];
  let best = null;
  for (const h of hits) {
    const text = String(h.text || "");
    const i = text.indexOf("{");
    if (i < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(i));
      if (!parsed || parsed.task !== task) continue;
      // 同一任务可能存有多条历史，取 at 最新的一条，避免读到旧进展。
      if (!best || String(parsed.at || "") > String(best.state.at || "")) {
        best = { scopeId, state: parsed, citation: h.citation || h };
      }
    } catch {
      /* 非本条状态记录，继续找 */
    }
  }
  return best || { scopeId, state: null };
}
