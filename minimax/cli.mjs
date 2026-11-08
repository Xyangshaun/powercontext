import { openDb, ensureSchema, vectorSearch } from "./src/db.mjs";
import { ingest } from "./src/ingest.mjs";
import { buildContext } from "./src/context.mjs";
import { saveState, loadState } from "./src/state.mjs";
import { embed } from "./src/embed.mjs";

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
  } else if (cmd === "context") {
    const task = arg("task");
    if (!task) throw new Error("缺少 --task");
    console.log(JSON.stringify(await buildContext(db.conn, task), null, 2));
  } else if (cmd === "search") {
    const q = arg("task");
    console.log(JSON.stringify(await vectorSearch(db.conn, "specs", embed(q), 5), null, 2));
  } else if (cmd === "state-save") {
    const task = arg("task");
    const split = (s) => s.split("|").map((x) => x.trim()).filter(Boolean);
    const out = await saveState(task, {
      done: split(arg("done")),
      todo: split(arg("todo")),
      verified: split(arg("verified")),
    });
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === "state-load") {
    console.log(JSON.stringify(await loadState(arg("task")), null, 2));
  } else {
    console.log("用法: node cli.mjs ingest|context|search|state-save|state-load --task ...");
  }
} finally {
  await db.close();
}
