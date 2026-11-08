import fs from "node:fs";
import path from "node:path";
import { embed } from "./embed.mjs";

const ROOT = process.cwd();

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), "utf8");
}

function titleOf(text, fallback) {
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

export function collectSpecs() {
  const dir = path.join(ROOT, "specs");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
    const body = read(path.join("specs", f));
    return { id: f.replace(/\.md$/, ""), title: titleOf(body, f), body };
  });
}

export function collectCode() {
  const files = ["demo/todo/store.mjs", "demo/todo/index.mjs"].filter((f) => fs.existsSync(path.join(ROOT, f)));
  const chunks = [];
  for (const f of files) {
    const text = read(f);
    const re = /export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/g;
    const marks = [];
    let m;
    while ((m = re.exec(text))) marks.push({ symbol: m[1], at: m.index });
    if (!marks.length) marks.push({ symbol: path.basename(f, ".mjs"), at: 0 });
    marks.forEach((mk, i) => {
      const body = text.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : text.length).trim();
      chunks.push({ id: `${f}#${mk.symbol}`, path: f, symbol: mk.symbol, body });
    });
  }
  return chunks;
}

export function collectTests() {
  const dir = path.join(ROOT, "demo", "todo", "tests");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".mjs"))) {
    const text = read(path.join("demo", "todo", "tests", f));
    const re = /test\(\s*"([^"]+)"/g;
    const marks = [];
    let m;
    while ((m = re.exec(text))) marks.push({ name: m[1], at: m.index });
    marks.forEach((mk, i) => {
      out.push({
        id: `demo/todo/tests/${f}#${mk.name}`,
        path: `demo/todo/tests/${f}`,
        name: mk.name,
        body: text.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : text.length).trim(),
      });
    });
  }
  return out;
}

const enc = (s) => s.replace(/'/g, "''");

export async function ingest(conn) {
  const specs = collectSpecs();
  const code = collectCode();
  const tests = collectTests();
  await conn.query("DELETE FROM specs");
  await conn.query("DELETE FROM code_chunks");
  await conn.query("DELETE FROM test_cases");
  for (const s of specs) {
    await conn.query(
      "INSERT INTO specs VALUES (?,?,?,?)",
      [s.id, s.title, s.body, embed(s.title + "\n" + s.body)]
    );
  }
  for (const c of code) {
    await conn.query(
      "INSERT INTO code_chunks VALUES (?,?,?,?,?)",
      [c.id, c.path, c.symbol, c.body, embed(c.symbol + "\n" + c.body)]
    );
  }
  for (const t of tests) {
    await conn.query(
      "INSERT INTO test_cases VALUES (?,?,?,?,?)",
      [t.id, t.path, t.name, t.body, embed(t.name + "\n" + t.body)]
    );
  }
  return { specs: specs.length, code: code.length, tests: tests.length, at: new Date().toISOString() };
}

export { enc };
