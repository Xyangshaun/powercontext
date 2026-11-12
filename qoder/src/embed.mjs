// 本地确定性嵌入：字符二元组 + 英文词哈希到 384 维并归一化。
// 用途仅为在 seekdb 里做向量检索召回，不代表模型嵌入，也不调用任何外部服务。
export const DIM = 384;

function buckets(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/g, "");
  const out = [];
  for (const w of String(text || "").toLowerCase().match(/[a-z0-9_]{2,}/g) || []) out.push(w);
  for (let i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
  return out;
}

export function embed(text) {
  const v = new Float64Array(DIM);
  for (const g of buckets(text)) {
    let h = 2166136261;
    for (let i = 0; i < g.length; i++) {
      h ^= g.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % DIM;
    v[idx] += 1;
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const a = new Array(DIM);
  for (let i = 0; i < DIM; i++) a[i] = Number((v[i] / n).toFixed(6));
  return "[" + a.join(",") + "]";
}
