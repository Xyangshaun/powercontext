// 最小连通性验证：seekdb 打开 + 建表 + 一次向量检索，打印结果，不写证据文件。
import { openDb, ensureSchema, vectorSearch } from "../src/db.mjs";
import { embed } from "../src/embed.mjs";

const started = Date.now();
const handle = await openDb();
try {
  await ensureSchema(handle.conn);
  const [rows] = await handle.conn.query("SELECT COUNT(*) AS n FROM notes");
  const hits = await vectorSearch(handle.conn, "notes", embed("向量索引怎么选"), 3);
  console.log(
    JSON.stringify(
      {
        ok: true,
        dbDir: handle.db ? "opened" : "opened",
        notesRows: Number(rows[0].n),
        hits: hits.map((r) => ({ id: r.id, title: r.title, distance: Number(r.dist) })),
        wall_ms: Date.now() - started,
      },
      null,
      2
    )
  );
} finally {
  await handle.close();
}
