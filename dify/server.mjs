// 阿吉客栈 · 记仇掌柜 —— 与 dify/aji-inn-chatflow.yml 等价的最小可运行入口。
// 三个动作与编排图一一对应：
//   1. 解析记忆作用域  -> POST /v1/scope-bindings/resolve
//   2. 写入记忆        -> POST /v1/memory/remember
//   3. 召回记忆        -> POST /v1/memory/search
// 记忆后端是真实 PowerContext Server，不再是进程内存数组。
// PowerContext 不可用时明确降级并继续，不静默失败。

import http from "node:http";
import { fileURLToPath } from "node:url";
import { resolveScope, remember, search, hitText, hitCitation } from "./src/powercontext.mjs";
import { createSeekdbLedger } from "./src/ledger.mjs";

const REMEMBER_TRIGGER = /记住|记一下|记下来|别忘了/;
const RECALL_TRIGGER = /记得|上次|旧账|账本/;
const PORT = Number(process.env.PORT || 8790);
const KIND = "aji_inn_debt";
// 写入正文里的类别词：让「你还记得我上次干了什么吗」这类没有共同词的问句
// 也能用词法检索命中账本。
const KIND_LABEL = "客栈账目";

// PowerContext 的写入回执有两种形态：
//   新版 Atomic Memory：records[].artifact.artifact_id
//   旧版：citation.entry_id / artifact_id
export function receiptEntryId(receipt) {
  if (!receipt) return null;
  if (Array.isArray(receipt.records) && receipt.records.length) {
    const artifact = receipt.records[0].artifact || receipt.records[0];
    if (artifact && artifact.artifact_id) return artifact.artifact_id;
    if (artifact && artifact.entry_id) return artifact.entry_id;
  }
  if (receipt.citation && receipt.citation.entry_id) return receipt.citation.entry_id;
  if (receipt.entry && receipt.entry.citation && receipt.entry.citation.entry_id) {
    return receipt.entry.citation.entry_id;
  }
  if (receipt.artifact_id) return receipt.artifact_id;
  if (receipt.entry_id) return receipt.entry_id;
  return null;
}

// 召回时不能拿整句去 fts 检索：写入的是「事件正文」，整句问话与正文没有公共词。
// 这里去掉客套话与疑问词后取词，作为检索式；与编排图「整理命中」节点的取词逻辑一致。
const RECALL_STOPWORDS = /掌柜的|你|我|还|记得|吗|什么|上次|旧账|账本|请|帮|一下/g;
// 这些词单独出现时没有检索价值（「干了」「什么」之类），保留会稀释召回。
const USELESS_TOKENS = new Set(["干", "了", "的", "事", "什么", "嘛", "呢", "啊"]);

export function recallQuery(text) {
  const parts = String(text || "")
    .replace(RECALL_STOPWORDS, " ")
    .split(/[，。！？、,.!?\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !USELESS_TOKENS.has(s));
  return parts.join(" ").trim();
}

// 「你还记得我上次干了什么吗」这类问句抽不出与正文共现的词，
// 语义上问的就是最近一条账目。这类问句直接回退到最近写入的条目。
const LAST_ITEM_PATTERN = /上次|最近|刚才|之前|先前/;

export function wantsLastItem(text) {
  return LAST_ITEM_PATTERN.test(String(text || ""));
}

// 本地降级账本：PowerContext 不可用时启用，落在真实 seekdb 上（见 src/ledger.mjs），
// 不是进程内存数组；回复里同时标注 mode=local 与具体原因。
export function createMemoryStore() {
  return createSeekdbLedger();
}

export async function handleTurn(input, store) {
  const text = String(input || "").trim();
  if (!text) {
    return { reply: "掌柜的没听清。", hits: [], mode: "local", backend: "none" };
  }

  const wantsRemember = REMEMBER_TRIGGER.test(text);
  const wantsRecall = RECALL_TRIGGER.test(text);
  if (!wantsRemember && !wantsRecall) {
    return { reply: "掌柜的没听清你要记什么。", hits: [], mode: "local", backend: "none" };
  }

  const content = wantsRemember
    ? text.replace(REMEMBER_TRIGGER, "").replace(/^[，,。：:\s]+/, "").trim()
    : "";

  try {
    const scope = await resolveScope();

    if (wantsRemember) {
      if (!content) {
        return { reply: "要记什么？掌柜的等你开口。", hits: [], mode: "remote", backend: "powercontext", scopeId: scope.scopeId };
      }
      // 写入时把类别词一起写进正文：PowerContext 的检索是词法的，
      // 玩家问「上次干了什么」时正文里没有共同词，只有类别词能兜住。
      const stored = `${KIND_LABEL} ${content}`;
      const saved = await remember(scope.scopeId, KIND, stored, "阿吉客栈记账");
      const entryId = receiptEntryId(saved.receipt);
      const revision =
        saved.receipt &&
        saved.receipt.records &&
        saved.receipt.records[0] &&
        saved.receipt.records[0].artifact &&
        saved.receipt.records[0].artifact.revision;
      return {
        reply: `记下了，账本第 ${revision || 1} 条：${content}`,
        hits: entryId ? [{ entry_id: entryId, score: 1, text: content }] : [],
        mode: "remote",
        backend: "powercontext",
        scopeId: scope.scopeId,
        requestId: saved.requestId,
        receipt: saved.receipt,
      };
    }

    // 检索式：关键词 + 类别词。PowerContext 的检索是词法的，
    // 玩家问「你还记得我上次干了什么吗」时正文里没有共同词，
    // 类别词是正文里一定有的一段，用它兜底才能稳定命中。
    const queries = [];
    const keyword = recallQuery(text);
    if (keyword) queries.push(keyword);
    if (!queries.includes(KIND_LABEL)) queries.push(KIND_LABEL);

    const seen = new Set();
    const hits = [];
    let requestId = null;
    for (const q of queries) {
      const found = await search(scope.scopeId, q, 10);
      requestId = found.requestId || requestId;
      for (const h of found.hits || []) {
        const citation = hitCitation(h);
        const entryId =
          (citation && (citation.entry_id || citation.artifact_id)) ||
          (h.artifact && h.artifact.artifact_id) ||
          (h.memory && h.memory.artifact && h.memory.artifact.artifact_id) ||
          null;
        if (!entryId || seen.has(entryId)) continue;
        seen.add(entryId);
        hits.push({
          entry_id: entryId,
          score: h.score,
          text: hitText(h),
          citation,
          matched_query: q,
        });
      }
      if (hits.length) break;
    }
    if (!hits.length) {
      return {
        reply: "账本上还没你的名字。",
        hits: [],
        mode: "remote",
        backend: "powercontext",
        scopeId: scope.scopeId,
        requestId,
      };
    }
    return {
      reply: `翻到了 ${hits[0].entry_id}：${hits[0].text}`,
      hits,
      mode: "remote",
      backend: "powercontext",
      scopeId: scope.scopeId,
      requestId,
    };
  } catch (e) {
    // PowerContext 不可用：降级到本地 seekdb 账本，回复里说明原因。
    try {
      if (wantsRemember) {
        const dup = await store.find(content);
        if (dup) {
          return { reply: `这条已经在账上 #${dup.entry_id}。`, hits: [{ entry_id: dup.entry_id, score: 1 }], mode: "local", backend: "degraded", ledger: store.kind, error: String(e.message || e) };
        }
        const entry = await store.add(content);
        return {
          reply: `记下了（记忆服务不可用，先记在本地 seekdb 账本 ${entry.entry_id}）：${content}`,
          hits: [{ entry_id: entry.entry_id, score: 1 }],
          mode: "local",
          backend: "degraded",
          ledger: store.kind,
          error: String(e.message || e),
        };
      }
      const last = await store.last();
      if (!last) {
        return { reply: "账本上还没你的名字。", hits: [], mode: "local", backend: "degraded", ledger: store.kind, error: String(e.message || e) };
      }
      return {
        reply: `翻到了 #${last.entry_id}：${last.content}`,
        hits: [{ entry_id: last.entry_id, score: 0.9 }],
        mode: "local",
        backend: "degraded",
        ledger: store.kind,
        error: String(e.message || e),
      };
    } catch (ledgerError) {
      // 连本地账本都起不来时如实报告，不静默。
      return {
        reply: `记忆服务与本地账本都不可用：${String(ledgerError.message || ledgerError)}`,
        hits: [],
        mode: "local",
        backend: "unavailable",
        error: String(e.message || e),
      };
    }
  }
}

export function createServer() {
  const store = createMemoryStore();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ledger: store.kind, backend: "powercontext" }));
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
      const result = await handleTurn(body.message, store);
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
