#!/usr/bin/env bash
# 初始化：安装依赖并把文献笔记与研究决策导入 seekdb
# 数据落在 ./.data/seekdb，可删可重建
set -euo pipefail
cd "$(dirname "$0")/.."
npm i --no-audit --no-fund
node cli.mjs ingest
