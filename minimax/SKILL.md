---
name: powercontext-minimax-project-memory
description: 把 PowerContext 插件装进 MiniMax Code，让 MiniMax 会话拥有可回查的项目记忆与跨会话交接。覆盖安装到数据目录、原生清单校验、Scope 解析、检索/保存/交接的时机与失败处理。触发词：MiniMax 接记忆、装 PowerContext 插件、MiniMax Code 记忆、跨会话交接。Use when installing or operating the PowerContext plugin inside MiniMax Code.
---

# MiniMax Code 项目记忆

PowerContext 以**原生 MiniMax 插件**形式接入：插件包自带 MCP 配置与 Skill，MiniMax Code 通过 `.minimax-plugin/plugin.json` 发现它。本 Skill 负责「装对、验对、用对」。

## 一、安装

产品仓库已提供可直接使用的包：`integrations/minimax/plugins/powercontext`。把它复制到 MiniMax 数据目录，不要就地修改仓库内文件：

```bash
# 默认数据目录是 ~/.minimax；设置了 MINIMAX_DATA_DIR 时以它为准
cp -R integrations/minimax/plugins/powercontext "$MINIMAX_DATA_DIR/plugins/powercontext"
```

要点：

- 数据目录默认 `~/.minimax`，`MINIMAX_DATA_DIR` 可覆盖；升级时保留用户已有配置，只替换插件内容。
- 包内结构：`.minimax-plugin/plugin.json`（清单，引用 MCP 配置、Skill 与图标）、`powercontext.mcp.json`（MCP 服务定义）、`skills/powercontext-project-context/SKILL.md` 及其 `references/`。
- 服务地址与令牌通过环境变量注入，**不要**写进 `powercontext.mcp.json` 并提交；令牌放主机凭据。
- 改插件内容后同步更新清单里的版本号，否则宿主可能继续用旧缓存。

## 二、校验

1. 用 MiniMax Code 的**原生插件列表/加载命令**确认 `powercontext` 出现在列表里。注意：命令退出码为 0 不代表包有效，被拒绝的包会被静默跳过，必须看列表内容。
2. 加载校验只证明发现与引用正确，**不证明** MCP 连通或模型可调用；还要在会话里实际调一次 `resolve_scope_binding` 看到成功返回。
3. MiniMax 公开的 `validate.mjs` 面向根 `plugin.json` 的可移植 Agent Plugin，不覆盖本包的原生 `.minimax-plugin/plugin.json`；不要用它的结果替代原生校验。

## 三、会话内怎么用

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

## 四、升级与回滚

1. 升级：替换 `plugins/powercontext` 内容，保留用户在数据目录下的其他插件与配置。
2. 回滚：保留上一份包目录副本，出问题时整目录回退，并重新执行原生列表校验。
3. 清单版本与 Skill 内容不一致会导致「装了但行为没变」，升级后必须核对版本号与 Skill 正文。

## 五、失败处理

- MCP 连不上：说明「记忆服务不可用」，本次会话降级为无历史模式，不要假装检索过。
- 写入超时：结果未知，先查状态再重试，避免重复写入。
- 清单被拒：检查 JSON 语法、相对路径引用与图标是否存在，再跑原生列表命令。
