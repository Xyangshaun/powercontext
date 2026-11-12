import { openDb, ensureSchema } from "./src/db.mjs";
import { ingest } from "./src/ingest.mjs";
import { recall } from "./src/recall.mjs";
import { saveDecision, loadDecision } from "./src/workbench.mjs";
import { embed } from "./src/embed.mjs";
import { vectorSearch } from "./src/db.mjs";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const cmd = process.argv[2];

const db = await openDb();
try {
  await ensureSchema(db.conn);
  if (cmd === "ingest") {
    console.log(JSON.stringify(await ingest(db.conn), null, 2));
  } else if (cmd === "search") {
    const q = arg("query");
    if (!q) throw new Error("缺少 --query");
    const rows = await vectorSearch(db.conn, "notes", embed(q), 5);
    console.log(JSON.stringify(rows.map((r) => ({ id: r.id, title: r.title, distance: Number(r.dist) })), null, 2));
  } else if (cmd === "recall") {
    const q = arg("question");
    if (!q) throw new Error("缺少 --question");
    console.log(JSON.stringify(await recall(db.conn, q, { limit: 3 }), null, 2));
  } else if (cmd === "remember") {
    const topic = arg("topic");
    const note = arg("note");
    if (!topic || !note) throw new Error("缺少 --topic 或 --note");
    console.log(JSON.stringify(await saveDecision(topic, note), null, 2));
  } else if (cmd === "recall-decision") {
    const topic = arg("topic");
    if (!topic) throw new Error("缺少 --topic");
    console.log(JSON.stringify(await loadDecision(topic), null, 2));
  } else {
    console.log("用法: node cli.mjs ingest|search|recall|remember|recall-decision --query/--question/--topic/--note ...");
  }
} finally {
  await db.close();
}
