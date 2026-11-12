// 最小连通性验证：解析作用域 + 写入一条记忆 + 检索，输出 request_id。
import { resolveScope, remember, search } from "../src/powercontext.mjs";

const started = Date.now();
const scope = await resolveScope();
const saved = await remember(scope.scopeId, "aji_inn_debt", "连通性验证条目", "verify");
const found = await search(scope.scopeId, "连通性验证", 5);

console.log(
  JSON.stringify(
    {
      ok: true,
      scope_id: scope.scopeId,
      resolve_request_id: scope.requestId,
      remember_request_id: saved.requestId,
      search_request_id: found.requestId,
      hits: found.hits.length,
      wall_ms: Date.now() - started,
    },
    null,
    2
  )
);
