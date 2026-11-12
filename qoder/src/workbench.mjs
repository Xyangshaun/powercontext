// 研究决策记忆：把「某课题上决定了什么」写进 PowerContext，并在新会话里读回。
// PowerContext 1.4.0 的检索结果形如 hits[].memory.text，旧版本形如 hits[].text，
// 这里统一取文本，避免因返回结构差异把已保存的决策读成 null。
import { resolveScope, remember, search } from "./powercontext.mjs";

const KIND = "research_decision";

export async function saveDecision(topic, note) {
  const scopeId = await resolveScope();
  const payload = { topic, note, at: new Date().toISOString() };
  const r = await remember(
    scopeId,
    KIND,
    `${topic}\n${JSON.stringify(payload)}`,
    "文献工作台保存研究决策"
  );
  return {
    scopeId,
    payload,
    receipt: r.body.memory || r.body,
    requestId: r.requestId,
    endpoint: r.endpoint,
    latencyMs: r.latencyMs,
  };
}

export function decisionFromHits(scopeId, hits, topic) {
  let best = null;
  for (const h of hits || []) {
    let text = "";
    if (h && typeof h.text === "string") text = h.text;
    else if (h && h.memory && typeof h.memory.text === "string") text = h.memory.text;
    else if (h && h.memory && typeof h.memory.content === "string") text = h.memory.content;
    if (!text) continue;
    const i = text.indexOf("{");
    if (i < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(i).trim());
      if (!parsed || parsed.topic !== topic) continue;
      if (!best || String(parsed.at || "") > String(best.decision.at || "")) {
        best = { scopeId, decision: parsed, citation: h.citation || (h.memory && h.memory.citation) || h };
      }
    } catch {
      /* 非本条决策记录，继续找 */
    }
  }
  return best || { scopeId, decision: null };
}

export async function loadDecision(topic) {
  const scopeId = await resolveScope();
  const r = await search(scopeId, topic, 10);
  const out = decisionFromHits(scopeId, r.body.hits, topic);
  out.requestId = r.requestId;
  out.endpoint = r.endpoint;
  out.latencyMs = r.latencyMs;
  out.mode = r.body.mode;
  out.hits = r.body.hits;
  return out;
}
