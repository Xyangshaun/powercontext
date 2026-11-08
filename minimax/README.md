# MiniMax SDD 上下文模块

面向软件持续演进的 SDD 上下文模块示例：把规格、代码、测试导入 seekdb，按开发任务检索出开发上下文，并用 PowerContext 保存/复用任务状态。

## 目录

```
specs/          规格文本（入库检索的规格来源）
demo/todo/      示例业务工程 + 目标/回归测试
src/            embed / db / ingest / context / state / powercontext
test/           模块自身测试
cli.mjs         调用入口
scripts/        init.sh、run-demo.sh
docs/           一页技术说明、验证样例、技术使用记录
```

## 依赖与版本

| 组件 | 版本 / 方式 |
| --- | --- |
| Node.js | 包声明 >=22；本机在 v20.19.0 实测可运行（npm 会告警 EBADENGINE），干净环境建议 22/24 |
| seekdb | `@oceanbase/seekdb-node@1.4.0`（内嵌引擎，darwin-arm64 原生包），实测 `5.7.25-OceanBase seekdb-v1.4.0.0` |
| SQL 客户端 | `mysql2` |
| PowerContext | HTTP API，默认 `http://127.0.0.1:8787`，可用 `POWERCONTEXT_URL` 覆盖 |

不需要 docker、obd、obclient；卸载只需删除 `node_modules` 与 `.data`。

## 配置

- `POWERCONTEXT_URL`：PowerContext 地址，默认 `http://127.0.0.1:8787`
- `SEEKDB_DIR`：seekdb 数据目录，默认 `./.data/seekdb`（首次启动会自动创建，初始化可能较慢）
- 不提交任何真实凭据；本模块不读模型 Key

## 初始化与调用

```bash
bash scripts/init.sh                 # 安装依赖并把 specs/ demo/ 入库
node cli.mjs context --task "给待办列表增加按状态筛选"
node cli.mjs state-save --task "给待办列表增加按状态筛选" --done "..." --todo "..." --verified "..."
node cli.mjs state-load --task "给待办列表增加按状态筛选"
node cli.mjs ingest                  # 规格修改后重新导入，下一次 context 即使用新内容
```

`context` 输出结构：`specs[]`（source/id/title/summary）、`code[]`（source/symbol/path）、`tests[]`（source/name/path）、`state`（PowerContext 中读回的任务状态）。

## 测试

```bash
node --test test/                    # 模块测试（需要本机可启动 seekdb）
node --test demo/todo/tests/         # 回归 + 目标测试；改造前目标测试应失败
```

## MiniMax 真实开发会话

```bash
export MINIMAX_API_KEY=...          # 只放环境变量，不写文件
export SEEKDB_DIR=/tmp/minimax-build/data   # 独立数据目录，不与其它实例共用
node scripts/minimax-session.mjs
```

脚本会：seekdb 入库 → 向量检索出上下文 → 调 MiniMax 生成 `filterByStatus` → 直接应用返回代码 → 跑目标测试与回归测试 → 把完整请求/响应、`request_id`、耗时、代码差异写入 `docs/evidence/`。

只想确认 Key 与本机网络可用时，跑最小探针（不写文件，只打印 `request_id`）：

```bash
export MINIMAX_API_KEY=...
node scripts/verify-minimax.mjs     # 或 npm run probe
```

## 已知限制（如实记录）

- 检索嵌入是**本地确定性哈希嵌入**（`src/embed.mjs`，384 维），只用于 seekdb 向量召回，不是模型 embedding，也不冒充 MiniMax 能力。
- PowerContext 不可达时 `context` 的 `state` 会返回错误字段，其余检索不受影响；`state-*` 命令需要服务在线。
- 同一任务存有多条历史状态时，`loadState` 按 `at` 取最新一条（此前取首个命中会读到旧进展）。
- MiniMax 只实测了 ChatCompletion v2 非流式单轮改码；流式、函数调用、多轮长上下文**未实测**。
- seekdb 首次初始化耗时明显；重复打开同目录会复用已有数据。
