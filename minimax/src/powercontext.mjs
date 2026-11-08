// PowerContext HTTP 客户端。默认地址来自 POWERCONTEXT_URL，未设置时用本机 8787。
const BASE = (process.env.POWERCONTEXT_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");

async function call(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PowerContext ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

export async function resolveScope() {
  const body = await call("/v1/scope-bindings/resolve", {
    method: "POST",
    body: JSON.stringify({ allow_default: true }),
  });
  return body.scope_id;
}

export function remember(scopeId, kind, text, reason) {
  return call("/v1/memory/remember", {
    method: "POST",
    body: JSON.stringify({ scope_id: scopeId, kind, text, reason }),
  });
}

export function search(scopeId, query, limit = 5) {
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
