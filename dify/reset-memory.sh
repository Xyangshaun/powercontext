#!/usr/bin/env bash
# 恢复 PowerContext 默认作用域到「零记忆」状态，便于重复执行 4.3 验证样例。
# 用法：POWERCONTEXT_BASE_URL=https://<your-host> ./dify/reset-memory.sh [--dry-run]
set -euo pipefail

BASE="${POWERCONTEXT_BASE_URL:-}"
if [ -z "$BASE" ]; then
  echo "缺少 POWERCONTEXT_BASE_URL，例如：POWERCONTEXT_BASE_URL=https://xxx.trycloudflare.com $0" >&2
  exit 2
fi
BASE="${BASE%/}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

PY="$(command -v python3 || true)"
[ -z "$PY" ] && { echo "需要 python3 来解析 JSON" >&2; exit 2; }

SID="$("$PY" - "$BASE" <<'PY'
import json, sys, urllib.request
base = sys.argv[1]
req = urllib.request.Request(
    base + "/v1/scope-bindings/resolve",
    data=json.dumps({"allow_default": True}).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
print(json.load(urllib.request.urlopen(req, timeout=20))["scope_id"])
PY
)"
echo "scope_id=$SID"

"$PY" - "$BASE" "$SID" "$DRY_RUN" <<'PY'
import json, sys, urllib.request
base, sid, dry = sys.argv[1], sys.argv[2], sys.argv[3] == "1"

def post(path, payload):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    return json.load(urllib.request.urlopen(req, timeout=20))

entries = post("/v1/memory/entries/list", {"scope_id": sid})
items = entries.get("entries") or entries.get("items") or []
print("现有条目数：%d" % len(items))
for item in items:
    citation = item.get("citation") or {}
    print("  - %s  %s" % (citation.get("entry_id"), (item.get("text") or "")[:40]))
    if dry:
        continue
    post("/v1/memory/entries/retire", {"scope_id": sid, "citation": citation, "reason": "reset-for-demo"})
print("已作废 %d 条（dry-run=%s）" % (0 if dry else len(items), dry))
PY
