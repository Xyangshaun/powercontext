// PowerContext HTTP 客户端。默认地址来自 POWERCONTEXT_URL，未设置时用本机 8787。
// 只依赖内置 fetch，不引入额外依赖。
// 每次响应都带上服务返回的 X-PowerContext-Request-ID，便于把调用与证据对应起来。
export const REQUEST_ID_HEADER = "x-powercontext-request-id";

function baseUrl() {
  // 每次调用时读取，允许测试与降级演练在运行期切换地址。
  return (process.env.POWERCONTEXT_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
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
  r.body.scope_id = r.body.scope_id;
  r.scopeId = r.body.scope_id;
  return r.body.scope_id;
}

export async function remember(scopeId, kind, text, reason) {
  return call("/v1/memory/remember", {
    method: "POST",
    body: JSON.stringify({ scope_id: scopeId, kind, text, reason }),
  });
}

export async function search(scopeId, query, limit = 5) {
  return call("/v1/memory/search", {
    method: "POST",
    body: JSON.stringify({ scope_id: scopeId, query, limit, mode: "fts" }),
  });
}

export async function healthy() {
  try {
    await resolveScope();
    return true;
  } catch {
    return false;
  }
}
