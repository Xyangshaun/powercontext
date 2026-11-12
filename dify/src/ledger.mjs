// 本地账本：PowerContext 不可用时的降级存储，落在真实 seekdb 上，不再是进程内存数组。
// seekdb 由 @oceanbase/seekdb-node 拉起，通过 MySQL 协议读写。
import { seekdb } from "@oceanbase/seekdb-node";
import mysql from "mysql2/promise";
import path from "node:path";
import fs from "node:fs";

export const LEDGER_DIR = process.env.SEEKDB_DIR || path.join(process.cwd(), ".data", "seekdb-dify");

let opening = null;

export async function openLedger() {
  if (opening) return opening;
  opening = (async () => {
    fs.mkdirSync(path.dirname(LEDGER_DIR), { recursive: true });
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    const db = await seekdb.open(LEDGER_DIR, {
      parameters: { memory_budget: "1G", mysql_port_mode: "random" },
    });
    const ep = db.connectionOptions();
    const loc = ep.transport === "tcp" ? { host: ep.host, port: ep.port } : { socketPath: ep.unixSocket };
    const conn = await mysql.createConnection({ ...loc, user: ep.user, password: "", database: "test" });
    await conn.query(
      "CREATE TABLE IF NOT EXISTS ledger (seq INT AUTO_INCREMENT PRIMARY KEY, entry_id VARCHAR(64), content TEXT)"
    );
    return { db, conn, close: async () => { await conn.end(); db.close(); } };
  })();
  return opening;
}

// seekdb 会在进程里常驻，跑完要显式关闭，否则 node --test 不会退出。
export async function closeLedger() {
  if (!opening) return;
  const handle = await opening;
  opening = null;
  await handle.close();
}

// 与 handleTurn 约定的账本接口：add / find / last，全部异步。
export function createSeekdbLedger() {
  return {
    kind: "seekdb",
    async add(content) {
      const { conn } = await openLedger();
      const [res] = await conn.query("INSERT INTO ledger (entry_id, content) VALUES (?, ?)", ["", content]);
      const entryId = `e${res.insertId}`;
      await conn.query("UPDATE ledger SET entry_id = ? WHERE seq = ?", [entryId, res.insertId]);
      return { entry_id: entryId, content };
    },
    async find(content) {
      const { conn } = await openLedger();
      const [rows] = await conn.query(
        "SELECT entry_id, content FROM ledger WHERE content = ? ORDER BY seq ASC LIMIT 1",
        [content]
      );
      return rows.length ? { entry_id: rows[0].entry_id, content: rows[0].content } : null;
    },
    async last() {
      const { conn } = await openLedger();
      const [rows] = await conn.query(
        "SELECT entry_id, content FROM ledger ORDER BY seq DESC LIMIT 1"
      );
      return rows.length ? { entry_id: rows[0].entry_id, content: rows[0].content } : null;
    },
  };
}
