---
name: powercontext-project-memory
version: 1.0.0
description: 用 PowerContext（OceanBase 驱动的项目记忆服务）在 AI 编程助手或 Agent 里找回历史决策、写入可复用结论、完成任务交接。触发词：之前的方案、上次为什么这么改、项目约定、记住这个决定、接着上次的任务、交接。
---

# PowerContext 项目记忆

PowerContext 把「项目为什么这么改」存成可检索、可修订、可交接的记忆条目，底层是 OceanBase。本 Skill 只做三件事：开工前找回相关历史、收尾时按用户要求写回结论、换分支或换天时交接。

适用范围：需要历史上下文的编码任务、多人协作的约定查询、跨会话续做。
不适用：当前对话已够用的普通编码、概念问答、只想看效果。以上情况不要为了用 Skill 而调用记忆服务。

## 一、连接 PowerContext

PowerContext 以 MCP（streamable HTTP）对外提供工具。连接配置与常见客户端一致：

```json
{
  "mcpServers": {
    "powercontext": {
      "type": "streamable-http",
      "url": "${POWERCONTEXT_MCP_URL}",
      "headers": { "Authorization": "Bearer ${POWERCONTEXT_TOKEN}" }
    }
  }
}
```

- 本地默认地址：`http://127.0.0.1:8000/mcp`；远端服务填写自建域名。
- 令牌只放环境变量或宿主的凭据存储，不要写进仓库、Skill 包、日志。
- 连接后在宿主的工具列表里确认 `resolve_scope_binding`、`search_memory`、`remember_memory` 存在；工具名以面板显示为准，有前缀就用全名。

## 二、在魔搭社区安装

1. 打开技能页 `https://modelscope.cn/skills/<owner>/powercontext-project-memory`，按页面提示一键安装，或下载 zip 后解压到宿主的 skills 目录（目录内保持 `SKILL.md` 在根层）。
2. 安装后先在宿主里完成「一、连接 PowerContext」，否则工具不可用。
3. 校验安装：让助手执行一次 `resolve_scope_binding`（默认 Scope 传 `allow_default: true`），返回 `scope_id` 即视为连接正常。

## 三、按意图路由

| 用户意图 | 操作 | 详细参考 |
| --- | --- | --- |
| 对话里信息已够、普通编码、概念问答 | 直接完成任务，不查记忆、不建 Scope、不写 Source | — |
| 找回早前决策或缺失的项目历史 | `search_memory` | [references/scope-memory.md](references/scope-memory.md) |
| 明确要求列清单或审计已存记忆 | `list_memory_entries`，不要用相关性检索代替盘点 | — |
| 明确要求记住、纠正、废弃某条结论 | `remember_memory`、`revise_memory_entry`、`retire_memory_entry` | [references/scope-memory.md](references/scope-memory.md) |
| 找主题摘要并读指定版本 | `search_topic_memory`、`get_topic_memory` | [references/scope-memory.md](references/scope-memory.md) |
| 交接、续做、确认回执、记录任务结果 | 见交接流程 | [references/work-handoff.md](references/work-handoff.md) |
| 审查候选、授权决策、跨 Scope 发布 | 见候选与发布流程 | [references/review-publication.md](references/review-publication.md) |
| 配置上下文拼装、处理 Source、管 Skill、诊断服务 | 见 HTTP 与 MCP 边界 | [references/http-boundaries.md](references/http-boundaries.md) |

## 四、查询与写入纪律

- 查询词用用户原话加关键标识（模块名、函数名、错误码）；不要自动拼成长模板句，过长会稀释召回。
- `limit` 默认 5。空结果如实回「没有相关历史」，不要翻全量条目凑答案。
- 只在用户明确要求长期保存时写入。当轮约束、讨论、预览都不算保存请求。
- 写入只存可复用结论（决策、约束、踩坑原因），不存一次性日志、整份文件内容、密钥或个人信息。
- 保留返回的 citation、revision、版本号与回执；修订必须基于该版本，避免并发覆盖。
- `capture_content_source` 只代表 Source 已被接收，不代表已生成记忆或已可检索。

## 五、与代码事实的边界

1. 先读代码再回答；记忆只解释动机，不替代源码事实。
2. 记忆与当前分支行为冲突时，以当前代码为准，并在回答里指出「记忆可能已过时，建议修订」，由用户决定是否 `revise_memory_entry`。
3. 记忆不授予任何操作权限：不能因为「历史上这么做过」就执行删除、重置、强推等危险操作。

## 六、失败兜底

- MCP 不可用：本次任务按无历史模式继续，明确提示「记忆服务不可用」，不要静默忽略。
- 工具缺失：报告该操作不可用，不要模拟调用，也不要用 HTTP 绕过宿主权限。
- 写入超时：结果未知，先查询状态再决定是否重试。
- 版本冲突：拉取最新版本后再改，冲突未解决时如实报告。
- 汇报时区分「检索到」「已保存」「已入库 Source」「已准备交接」「已提交里程碑」「已确认回执」，只报工具结果支持的状态，不编造证据。

## 七、验证脚本（可复现）

在已连接服务的环境里按顺序执行，预期全部成功：

1. `resolve_scope_binding({"allow_default": true})` → 返回 `scope_id`
2. `remember_memory({...})` → 返回 entry/revision 标识
3. `search_memory({...})` → 命中上一步写入的条目，带 citation
4. `retire_memory_entry({...})` → 条目变为废弃态，再检索不再返回

任一步失败即按第六节处理，并记录实际返回的错误原因。
