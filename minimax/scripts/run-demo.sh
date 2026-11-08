#!/usr/bin/env bash
# 验证样例：构建上下文 -> 保存状态 -> 新进程读回状态 -> 跑回归与目标测试
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node20/bin:$PATH"
TASK="给待办列表增加按状态筛选"
node cli.mjs context --task "$TASK"
node cli.mjs state-save --task "$TASK" --done "规格/代码/测试已入库" --todo "实现 filterByStatus" --verified "seekdb 检索通过"
node cli.mjs state-load --task "$TASK"
set +e
node --test demo/todo/tests/
CODE=$?
set -e
echo "demo tests exit=$CODE（改造前目标测试失败属预期）"
