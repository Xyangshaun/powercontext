// 文献工作台的入库逻辑：把 notes/ 下的文献笔记与 decisions/ 下的研究决策
// 切成条目并写入 seekdb（向量列用本地确定性嵌入）。
import fs from "node:fs";
import path from "node:path";
import { embed } from "./embed.mjs";

const ROOT = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function titleOf(text, fallback) {
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

export function collectNotes() {
  const dir = path.join(ROOT, "notes");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
    const body = read(path.join("notes", f));
    return { id: f.replace(/\.md$/, ""), title: titleOf(body, f), body };
  });
}

export function collectDecisions() {
  const dir = path.join(ROOT, "decisions");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
    const body = read(path.join("decisions", f));
    return { id: f.replace(/\.md$/, ""), topic: titleOf(body, f), body };
  });
}

export async function ingest(conn) {
  const notes = collectNotes();
  const decisions = collectDecisions();
  await conn.query("DELETE FROM notes");
  await conn.query("DELETE FROM decisions");
  for (const n of notes) {
    await conn.query(
      "INSERT INTO notes VALUES (?,?,?,?)",
      [n.id, n.title, n.body, embed(n.title + "\n" + n.body)]
    );
  }
  for (const d of decisions) {
    await conn.query(
      "INSERT INTO decisions VALUES (?,?,?,?)",
      [d.id, d.topic, d.body, embed(d.topic + "\n" + d.body)]
    );
  }
  return { notes: notes.length, decisions: decisions.length, at: new Date().toISOString() };
}
