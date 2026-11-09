// 阿吉客栈·记仇掌柜 —— 与 dify/aji-inn-chatflow.yml 等价的最小可运行入口。
// 只做三件事：关键词触发的记账、跨会话翻旧账、未记账不入库。
// 无外部依赖，Node 20 内置模块即可启动；真实记忆后端仍是 PowerContext，见 4.2。

import http from "node:http";
import { fileURLToPath } from "node:url";

const REMEMBER_TRIGGER = /记住|记一下|记下来|别忘了/;
const RECALL_TRIGGER = /记得|上次|旧账|账本/;
const PORT = Number(process.env.PORT || 8790);

export function createMemoryStore() {
  return { seq: 0, entries: [] };
}

export function handleTurn(input, store) {
  const text = String(input || "").trim();
  if (!text) {
    return { reply: "掌柜的没听清。", hits: [], mode: "local" };
  }

  if (REMEMBER_TRIGGER.test(text)) {
    const content = text
      .replace(REMEMBER_TRIGGER, "")
      .replace(/^[，,。：:\s]+/, "")
      .trim();
    if (!content) {
      return { reply: "要记什么？掌柜的等你开口。", hits: [], mode: "local" };
    }
    const dup = store.entries.find((e) => e.content === content);
    if (dup) {
      return {
        reply: `这条已经在账上 #${dup.entry_id}。`,
        hits: [{ entry_id: dup.entry_id, score: 1 }],
        mode: "local",
      };
    }
    store.seq += 1;
    const entry = { entry_id: `e${store.seq}`, content, version: 1 };
    store.entries.push(entry);
    return {
      reply: `记下了，账本第 ${store.seq} 条：${content}`,
      hits: [{ entry_id: entry.entry_id, score: 1 }],
      mode: "local",
    };
  }

  if (RECALL_TRIGGER.test(text)) {
    const hit = store.entries.length ? store.entries[store.entries.length - 1] : null;
    if (!hit) {
      return { reply: "账本上还没你的名字。", hits: [], mode: "local" };
    }
    return {
      reply: `翻到了 #${hit.entry_id}：${hit.content}`,
      hits: [{ entry_id: hit.entry_id, score: 0.9 }],
      mode: "local",
    };
  }

  return { reply: "掌柜的没听清你要记什么。", hits: [], mode: "local" };
}

export function createServer() {
  const store = createMemoryStore();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, entries: store.entries.length }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/chat") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      const result = handleTurn(body.message, store);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ session_id: body.session_id || "default", ...result }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  createServer().listen(PORT, "127.0.0.1", () => {
    console.log(`aji-inn dify demo listening on http://127.0.0.1:${PORT}`);
  });
}
