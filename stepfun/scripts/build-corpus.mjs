import fs from "node:fs";
import path from "node:path";

// Build the demo corpus from the upstream seekdb documentation (Apache-2.0).
const SRC = process.env.SEEKB_SRC || "/Users/xyris/Documents/Trae-CN/temp_20261104_01/ob2026/seekdb-src";
const OUT = new URL("../data/corpus.json", import.meta.url);

const files = [
  "README.md",
  ...walk(path.join(SRC, "docs")).filter((f) => f.endsWith(".md") && !/README\.md$/.test(f)).slice(0, 40),
];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const chunks = [];
for (const rel of files) {
  const file = rel.startsWith("/") ? rel : path.join(SRC, rel);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  let heading = path.basename(file, ".md");
  let buffer = [];
  const flush = () => {
    const body = buffer.join(" ").replace(/\s+/g, " ").trim();
    if (body.length < 60) { buffer = []; return; }
    // split long sections into ~450 character windows on sentence boundaries
    const sentences = body.split(/(?<=[.!?。！？])\s+/);
    let piece = "";
    const push = (s) => {
      if (!s) return;
      chunks.push({
        id: chunks.length + 1,
        title: heading.slice(0, 120),
        content: s,
        source: rel,
      });
    };
    for (const s of sentences) {
      if ((piece + " " + s).trim().length > 480 && piece) { push(piece.trim()); piece = s; }
      else piece = (piece + " " + s).trim();
    }
    if (piece.trim()) push(piece.trim());
    buffer = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const m = /^(#{1,4})\s+(.+)\.md?$/.exec(line) || /^(#{1,4})\s+(.+)$/.exec(line);
    if (m) { flush(); heading = m[2].trim(); continue; }
    if (/^[|-]{3,}$/.test(line.trim())) continue;
    if (line.trim()) buffer.push(line.trim());
  }
  flush();
}

// Drop code-block-only noise and dedupe identical content
const seen = new Set();
const final = [];
const clean = (s) => s
  .replace(/<[^>]*>/g, " ")
  .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/https?:\/\/\S+/g, " ")
  .replace(/&[a-z]+;/gi, " ")
  .replace(/[*_`#>]/g, " ")
  .replace(/\s+/g, " ")
  .trim();
for (const c of chunks) {
  const content = clean(c.content.replace(/```[\s\S]*?```/g, " "));
  if (content.length < 80) continue;
  const key = content.slice(0, 120);
  if (seen.has(key)) continue;
  seen.add(key);
  final.push({ ...c, id: final.length + 1, content });
}

const CAP = Number(process.env.CORPUS_CAP || 96);
let picked = final;
if (final.length > CAP) {
  const step = final.length / CAP;
  picked = Array.from({ length: CAP }, (_, i) => final[Math.floor(i * step)]);
}
fs.mkdirSync(path.dirname(OUT.pathname), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(picked, null, 1));
console.log(`corpus docs: ${picked.length} (from ${final.length} chunks), bytes: ${fs.statSync(OUT.pathname).size}`);
