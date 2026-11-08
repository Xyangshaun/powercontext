#!/usr/bin/env bash
# 初始化：安装依赖并把规格/代码/测试导入 seekdb（数据落在 ./.data/seekdb，可删可重建）
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node20/bin:$PATH"
npm i --no-audit --no-fund
npm i @oceanbase/seekdb-node-darwin-arm64@1.4.0 --no-audit --no-fund 2>/dev/null || true
node cli.mjs ingest
