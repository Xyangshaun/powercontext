// seekdb 连接与表结构：真实调用 @oceanbase/seekdb-node 建库并用 MySQL 协议读写。
import { seekdb } from "@oceanbase/seekdb-node";
import mysql from "mysql2/promise";
import path from "node:path";
import fs from "node:fs";

export const DB_DIR = process.env.SEEKDB_DIR || path.join(process.cwd(), ".data", "seekdb");

export async function openDb() {
  const parent = path.dirname(DB_DIR);
  fs.mkdirSync(parent, { recursive: true });
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = await seekdb.open(DB_DIR, {
    parameters: { memory_budget: "1G", mysql_port_mode: "random" },
  });
  const ep = db.connectionOptions();
  const loc = ep.transport === "tcp" ? { host: ep.host, port: ep.port } : { socketPath: ep.unixSocket };
  const conn = await mysql.createConnection({ ...loc, user: ep.user, password: "", database: "test" });
  return { db, conn, close: async () => { await conn.end(); db.close(); } };
}

export async function ensureSchema(conn) {
  await conn.query("CREATE TABLE IF NOT EXISTS notes (id VARCHAR(64) PRIMARY KEY, title VARCHAR(200), body TEXT, vec VECTOR(384))");
  await conn.query("CREATE TABLE IF NOT EXISTS decisions (id VARCHAR(128) PRIMARY KEY, topic VARCHAR(200), body TEXT, vec VECTOR(384))");
}

export async function vectorSearch(conn, table, queryVec, limit = 5) {
  const [rows] = await conn.query(
    `SELECT * , cosine_distance(vec, ?) AS dist FROM ${table} ORDER BY dist ASC LIMIT ${limit}`,
    [queryVec]
  );
  return rows;
}
