// 召回：给定一个研究问题，先用 seekdb 向量检索找出相关文献与决策，
// 再尝试用 PowerContext 读回该课题上已保存的决策（不可用时如实降级）。
import { embed } from "./embed.mjs";
import { vectorSearch } from "./db.mjs";
import { loadDecision } from "./workbench.mjs";

export async function recall(conn, question, opts = {}) {
  const limit = opts.limit || 3;
  const vec = embed(question);
  const notes = (await vectorSearch(conn, "notes", vec, limit)).map((r) => ({
    source: `notes/${r.id}.md`,
    id: r.id,
    title: r.title,
    summary: String(r.body).split("\n").filter((l) => l.trim().startsWith("-")).slice(0, 4).join(" ") || String(r.body).slice(0, 160),
    distance: Number(r.dist),
  }));
  const decisions = (await vectorSearch(conn, "decisions", vec, limit)).map((r) => ({
    source: `decisions/${r.id}.md`,
    id: r.id,
    topic: r.topic,
    distance: Number(r.dist),
  }));

  let memory = null;
  try {
    const found = await loadDecision(question);
    memory = { available: true, scopeId: found.scopeId, decision: found.decision };
  } catch (e) {
    memory = { available: false, error: String(e.message || e) };
  }

  return { question, notes, decisions, memory, generatedAt: new Date().toISOString() };
}
