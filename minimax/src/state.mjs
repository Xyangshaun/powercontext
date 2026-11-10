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

// PowerContext 1.4.0 的检索结果形如 hits[].memory.text，旧版本形如 hits[].text，
// 这里统一取文本，避免因返回结构差异把已保存的状态读成 null。
function hitText(h) {
  if (!h) return "";
  if (typeof h.text === "string") return h.text;
  if (h.memory && typeof h.memory.text === "string") return h.memory.text;
  if (h.memory && typeof h.memory.content === "string") return h.memory.content;
  return "";
}

function hitCitation(h) {
  return h.citation || (h.memory && h.memory.citation) || h;
}

export function stateFromHits(scopeId, hits, task) {
  let best = null;
  for (const h of hits || []) {
    const text = hitText(h);
    const i = text.indexOf("{");
    if (i < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(i).trim());
      if (!parsed || parsed.task !== task) continue;
      // 同一任务可能存有多条历史，取 at 最新的一条，避免读到旧进展。
      if (!best || String(parsed.at || "") > String(best.state.at || "")) {
        best = { scopeId, state: parsed, citation: hitCitation(h) };
      }
    } catch {
      /* 非本条状态记录，继续找 */
    }
  }
  return best || { scopeId, state: null };
}

export async function loadState(task) {
  const scopeId = await resolveScope();
  const body = await search(scopeId, task, 10);
  return stateFromHits(scopeId, body.hits, task);
}
