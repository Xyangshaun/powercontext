---
name: powercontext-minimax-project-memory
description: 把 PowerContext 插件装进 MiniMax Code，让 MiniMax 会话拥有可回查的项目记忆与跨会话交接。覆盖安装到数据目录、原生清单校验、Scope 解析、检索/保存/交接的时机与失败处理。触发词：MiniMax 接记忆、装 PowerContext 插件、MiniMax Code 记忆、跨会话交接。Use when installing or operating the PowerContext plugin inside MiniMax Code.
---

# MiniMax Code 项目记忆

PowerContext 以**原生 MiniMax 插件**形式接入：插件包自带 MCP 配置与 Skill，MiniMax Code 通过 `.minimax-plugin/plugin.json` 发现它。本 Skill 负责「装对、验对、用对」。

## 一、安装

生态分支 `2026-competition-ecosystem` 里已提供可直接使用的包：`integrations/minimax/plugins/powercontext`。把它复制到 MiniMax 数据目录，不要就地修改仓库内文件：

```bash
# 默认数据目录是 ~/.minimax；设置了 MINIMAX_DATA_DIR 时以它为准
mkdir -p "$MINIMAX_DATA_DIR/plugins"
cp -R integrations/minimax/plugins/powercontext "$MINIMAX_DATA_DIR/plugins/powercontext"
```

要点：

- 数据目录默认 `~/.minimax`，`MINIMAX_DATA_DIR` 可覆盖；升级时保留用户已有配置，只替换插件内容。
- 包内共 12 个文件：`.minimax-plugin/plugin.json`（清单，引用 MCP 配置、Skill 与图标）、`powercontext.mcp.json`（MCP 服务定义）、`LICENSE`、`README.md`、`icon.png`、`skills/powercontext-project-context/SKILL.md` 及其 `references/` 下 5 份参考文件。
- 服务地址与令牌通过环境变量注入，**不要**写进 `powercontext.mcp.json` 并提交；令牌放主机凭据。包内默认指向 `http://127.0.0.1:8000/mcp`。
- 改插件内容后同步更新清单里的版本号，否则宿主可能继续用旧缓存。
- 装完后用 `find "$MINIMAX_DATA_DIR/plugins/powercontext" -type f | wc -l` 核对文件数（应为 12），少文件说明用了会跳过点文件的复制方式。

## 二、参数级工具清单

插件通过 MCP 暴露下面这些工具。参数名与约束来自 PowerContext 的 OpenAPI 契约（服务端 `extra=forbid`，多余字段直接报错）。

| 工具 | 用途 | 必填参数 | 可选参数 | 主要返回 |
| --- | --- | --- | --- | --- |
| `resolve_scope_binding` | 解析会话 Scope | 无（`allow_default` 默认 `true`） | `explicit_scope_id`（1–256 字符）、`binding_keys[]` | `scope_id`、`title`、`summary`、`version` |
| `search_memory` | 检索历史记忆 | `scope_id`、`query` | `limit`（1–50，默认 10；本 Skill 用 5）、`mode`（`auto`/`fts`/`vector`/`hybrid`）、`tag_filter` | `hits[]`：`text`、`score`、`matched_by[]`、`citation` |
| `list_memory_entries` | 显式盘点记忆 | `scope_id` | 分页参数以工具目录为准 | 条目列表 |
| `get_memory_entry` | 按引用取精确内容 | `scope_id`、`citation` | — | 条目正文与 revision |
| `remember_memory` | 显式保存 | `scope_id`、`kind`（≤128）、`text`（≤8192 UTF-8 字节） | `reason`（≤512）、`expected_revision`（≥1） | `memory` 引用；`entry` |
| `revise_memory_entry` | 更正条目 | `scope_id`、`citation`、`kind`、`text` | `reason` | `memory` 引用与 `entry` |
| `retire_memory_entry` | 作废条目 | `scope_id`、`citation` | `reason` | `memory` 引用 |
| `search_topic_memory` | 主题摘要检索 | `scope_id`、`query` | `limit`（1–20，默认 10） | 主题摘要命中 |
| `get_topic_memory` | 读取主题记忆 | `scope_id`、`artifact` | — | 主题记忆内容 |
| `handoff_current_work` | 生成临时交接 | `scope_id`、`source_id`、`handoff` | — | `PreparedWorkHandoff`（未提交） |
| `commit_handoff` | 提交里程碑交接 | `scope_id`、`handoff`（上一步原样返回） | — | `CommittedHandoff` |

- `citation` 必须原样回传，不能自己拼 `entry_id` / `entry_version_id`。
- `search_memory` 返回的 `mode` 说明这一轮实际走的召回路径（`fts`/`vector`/`hybrid`），排查"搜不到"时先看它。
- `score` 是相似度，不是"可信度"，不要写进结论。

## 三、校验

1. 用 MiniMax Code 的**原生插件列表/加载命令**确认 `powercontext` 出现在列表里。注意：命令退出码为 0 不代表包有效，被拒绝的包会被静默跳过，必须看列表内容。
2. 加载校验只证明发现与引用正确，**不证明** MCP 连通或模型可调用；还要在会话里实际调一次 `resolve_scope_binding` 看到成功返回。
3. MiniMax 公开的 `validate.mjs` 面向根 `plugin.json` 的可移植 Agent Plugin，不覆盖本包的原生 `.minimax-plugin/plugin.json`；不要用它的结果替代原生校验。

## 四、会话内怎么用

| 场景 | 操作 |
| --- | --- |
| 任何数据操作前 | `resolve_scope_binding`（默认 Scope 需显式 `allow_default: true`） |
| 需要历史决策/背景 | `search_memory`，`limit` 默认 5 |
| 明确要求记住或更正 | `remember_memory` / `revise_memory_entry` / `retire_memory_entry` |
| 主题摘要 | `search_topic_memory` → `get_topic_memory` |
| 跨会话交接 | `handoff_current_work` → 里程碑确认后 `commit_handoff` |
| 普通编码、当前上下文已足够 | 不调 PowerContext，不做 Scope/Source 多余写入 |

- 工具名用宿主实际暴露的全名（可能带 `powercontext` 命名空间）。工具缺失就报告不可用，不要用 HTTP 绕过宿主权限。
- 检索为空是合法结果；不要改写成全量列举。
- 回答里的引用、revision、receipt 原样保留；不编造证据。

## 五、升级与回滚

1. 升级：替换 `plugins/powercontext` 内容，保留用户在数据目录下的其他插件与配置。
2. 回滚：保留上一份包目录副本，出问题时整目录回退，并重新执行原生列表校验。
3. 清单版本与 Skill 内容不一致会导致「装了但行为没变」，升级后必须核对版本号与 Skill 正文。

## 六、失败处理

- MCP 连不上：说明「记忆服务不可用」，本次会话降级为无历史模式，不要假装检索过。
- 写入超时：结果未知，先查状态再重试，避免重复写入。
- 清单被拒：检查 JSON 语法、相对路径引用与图标是否存在，再跑原生列表命令。

## 七、绝对禁止

- 不在 `resolve_scope_binding` 成功返回前调任何读写工具；不用空对象、不猜 `scope_id`、不从仓库目录或分支名推导 Scope。
- 不在复制后手工改包内文件来「修好」安装——包内容应与分支一致；要改就改仓库源文件再重新复制。
- 不把令牌、服务地址、用户隐私写进 `powercontext.mcp.json`、会话记录或提交历史。
- 不编造 `citation`、revision、receipt；只原样引用工具返回的那一份。
- 不在用户没有明确要求时写入记忆；当前轮讨论、预览、普通编码都不构成写入授权。
- 不把 `search_memory` 的空结果当成"系统里从未有过这条记忆"，也不拿它替代 `list_memory_entries`。
- 工具缺失或调用失败时如实报告不可用，不用文本模拟调用，不换别的工具假装成功。
- 不用 `validate.mjs` 的通过结果冒充原生插件加载成功。

## 八、端到端最小示例

在装好插件并重启 MiniMax Code 后的新会话里：

**用户**：帮我把「PDF 证据页上限 40」这条结论记下来，供以后查。

**第 1 步**：`resolve_scope_binding`

```json
{"allow_default": true}
```

返回：`{"scope_id": "scope_01HQ...", "title": "PowerContext 竞赛项目", "version": 3}`

**第 2 步**：`remember_memory`

```json
{
  "scope_id": "scope_01HQ...",
  "kind": "decision",
  "text": "PDF 证据页上限从 20 调到 40；平台按组统计 Recall@20，需要更多候选页。",
  "reason": "用户明确要求记住"
}
```

返回：`{"memory": {"artifact_id": "mem_01H..."}, "entry": {"entry": {"entry_id": "ent_01H..."}, ...}}`

**第 3 步**（校验写入可检索）：`search_memory`

```json
{"scope_id": "scope_01HQ...", "query": "PDF 证据页上限", "limit": 5}
```

返回 `hits[0].text` 与第 2 步写入一致、`citation.entry_id` 与返回的 `ent_01H...` 一致，才算写完并能读回。

**第 4 步**：回复用户「已记录」时只陈述工具结果支持的事实（已写入、可检索、对应的 citation），不额外承诺"以后每次都会自动想起"。
