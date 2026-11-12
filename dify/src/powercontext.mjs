// PowerContext HTTP 客户端：与 Dify 编排图里的三个 http-request 节点同一套接口。
// 地址来自 POWERCONTEXT_BASE_URL，未设置时回退到本机 8787。
// 每次响应都带回服务返回的 X-PowerContext-Request-ID，便于取证。
export const REQUEST_ID_HEADER = "x-powercontext-request-id";

function baseUrl() {
  return (process.env.POWERCONTEXT_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
}

async function call(path, init = {}) {
  const started = Date.now();
  const base = baseUrl();
  const res = await fetch(base + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PowerContext ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return {
    body,
    requestId: res.headers.get(REQUEST_ID_HEADER) || null,
    latencyMs: Date.now() - started,
    endpoint: `${base}${path}`,
  };
}

export async function resolveScope() {
  const r = await call("/v1/scope-bindings/resolve", {
    method: "POST",
    body: JSON.stringify({ allow_default: true }),
  });
  return { scopeId: r.body.scope_id, requestId: r.requestId, latencyMs: r.latencyMs, endpoint: r.endpoint };
}

export async function remember(scopeId, kind, text, reason) {
  const r = await call("/v1/memory/remember", {
    method: "POST",
    body: JSON.stringify({ scope_id: scopeId, kind, text, reason }),
  });
  return {
    scopeId,
    receipt: r.body.memory || r.body,
    requestId: r.requestId,
    latencyMs: r.latencyMs,
    endpoint: r.endpoint,
  };
}

export async function search(scopeId, query, limit = 10) {
  const r = await call("/v1/memory/search", {
    method: "POST",
    body: JSON.stringify({ scope_id: scopeId, query, limit, mode: "fts" }),
  });
  return {
    scopeId,
    hits: r.body.hits || [],
    mode: r.body.mode,
    requestId: r.requestId,
    latencyMs: r.latencyMs,
    endpoint: r.endpoint,
  };
}

// PowerContext 1.4.0 的检索结果形如 hits[].memory.text，旧版本形如 hits[].text。
export function hitText(hit) {
  if (!hit) return "";
  if (typeof hit.text === "string") return hit.text;
  if (hit.memory && typeof hit.memory.text === "string") return hit.memory.text;
  if (hit.memory && typeof hit.memory.content === "string") return hit.memory.content;
  return "";
}

export function hitCitation(hit) {
  return hit.citation || (hit.memory && hit.memory.citation) || hit;
}
