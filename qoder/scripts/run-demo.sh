#!/usr/bin/env bash
# 验证样例：入库 -> 向量检索召回 -> 读回研究决策 -> 跑测试
# PowerContext 未部署时，决策读回会明确降级并继续，不中断流程。
set -euo pipefail
cd "$(dirname "$0")/.."
QUESTION="单机向量索引该怎么选"
echo "--- 1) 入库"
node cli.mjs ingest
echo "--- 2) 向量检索召回"
node cli.mjs search --query "$QUESTION"
echo "--- 3) 综合召回（文献 + 决策 + 记忆读回）"
node cli.mjs recall --question "$QUESTION"
echo "--- 4) 测试"
node --test test/*.test.mjs
