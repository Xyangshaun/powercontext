import { seekdb } from "@oceanbase/seekdb-node";
import mysql from "mysql2/promise";
import path from "node:path";
import fs from "node:fs";

export const DB_DIR = process.env.SEEKDB_DIR || path.join(process.cwd(), ".data", "seekdb");

export async function openDb() {
  const parent = path.dirname(DB_DIR);
  fs.mkdirSync(parent, { recursive: true });
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  const db = await seekdb.open(DB_DIR, {
    parameters: { memory_budget: "1G", mysql_port_mode: "random" },
  });
  const ep = db.connectionOptions();
  const loc = ep.transport === "tcp" ? { host: ep.host, port: ep.port } : { socketPath: ep.unixSocket };
  const conn = await mysql.createConnection({ ...loc, user: ep.user, password: "", database: "test" });
  return { db, conn, close: async () => { await conn.end(); db.close(); } };
}

export async function ensureSchema(conn) {
  const [r] = await conn.query("SELECT MD5(CONCAT('sdd-context','seekdb')) AS _");
  await conn.query("CREATE TABLE IF NOT EXISTS specs (id VARCHAR(64) PRIMARY KEY, title VARCHAR(200), body TEXT, vec VECTOR(384))");
  await conn.query("CREATE TABLE IF NOT EXISTS code_chunks (id VARCHAR(128) PRIMARY KEY, path VARCHAR(200), symbol VARCHAR(200), body TEXT, vec VECTOR(384))");
  await conn.query("CREATE TABLE IF NOT EXISTS test_cases (id VARCHAR(128) PRIMARY KEY, path VARCHAR(200), name VARCHAR(300), body TEXT, vec VECTOR(384))");
  return r;
}

export async function vectorSearch(conn, table, queryVec, limit = 3) {
  const [rows] = await conn.query(
    `SELECT * , cosine_distance(vec, ?) AS dist FROM ${table} ORDER BY dist ASC LIMIT ${limit}`,
    [queryVec]
  );
  return rows;
}
