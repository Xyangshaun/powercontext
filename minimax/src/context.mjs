import { embed } from "./embed.mjs";
import { vectorSearch } from "./db.mjs";
import { loadState } from "./state.mjs";

// 给定开发任务，产出开发上下文：适用规格、需改代码、验证测试、任务状态。
export async function buildContext(conn, task, opts = {}) {
  const limit = opts.limit || 3;
  const vec = embed(task);
  const specs = (await vectorSearch(conn, "specs", vec, limit)).map((r) => ({
    source: `specs/${r.id}.md`,
    id: r.id,
    title: r.title,
    summary: String(r.body).split("\n").filter((l) => l.trim().startsWith("-")).slice(0, 5).join(" ") || String(r.body).slice(0, 160),
    distance: Number(r.dist),
  }));
  const code = (await vectorSearch(conn, "code_chunks", vec, limit)).map((r) => ({
    source: `${r.path}#${r.symbol}`,
    symbol: r.symbol,
    path: r.path,
    distance: Number(r.dist),
  }));
  const tests = (await vectorSearch(conn, "test_cases", vec, limit)).map((r) => ({
    source: `${r.path}::${r.name}`,
    name: r.name,
    path: r.path,
    distance: Number(r.dist),
  }));
  let state = null;
  try {
    state = await loadState(task);
  } catch (e) {
    state = { error: String(e.message || e) };
  }
  return { task, specs, code, tests, state, generatedAt: new Date().toISOString() };
}
