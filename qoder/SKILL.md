---
name: powercontext-qoder-project-memory
description: 在 Qoder（AI IDE）里把 PowerContext 当项目记忆：编码前找回历史决策与约定，任务结束时按需保存结论，跨天/换分支时交接。触发词：之前的方案、上次为什么这么改、项目约定、记住这个决定、接着上次的任务、交接。Use in Qoder when a coding task depends on earlier decisions or must leave a resumable handoff.
---

# Qoder 项目记忆

IDE 场景下最容易丢的是「为什么这么改」。本 Skill 只做三件事：开工前找回相关历史、收尾时按用户要求写回结论、换分支/换天时交接。代码本身、当前仓库事实和用户当轮指令永远优先于历史记忆。

## 一、在 Qoder 中连接

1. 在 Qoder 的 **设置 → MCP**（或 MCP Servers 面板）新增服务，JSON 结构与常见客户端一致：

```json
{
  "mcpServers": {
    "powercontext": {
      "type": "http",
      "url": "${POWERCONTEXT_MCP_URL}",
      "headers": { "Authorization": "Bearer ${POWERCONTEXT_TOKEN}" }
    }
  }
}
```

2. 令牌放环境变量或 Qoder 的凭据存储，**不要**提交到仓库、不要写进 `.qoder/` 规则文件。
3. 连接后确认 `resolve_scope_binding`、`search_memory`、`remember_memory` 出现在工具列表；工具名以面板显示为准（有前缀就用全名）。

## 二、推荐的 IDE 使用节奏

| 时机 | 动作 |
| --- | --- |
| 打开一个不熟悉的仓库/模块 | `resolve_scope_binding` → `search_memory`（query 用「模块名 + 要解决的问题」） |
| 用户问「上次为什么这么设计」 | `search_memory`，命中的条目标注 citation 与版本 |
| 用户明确说「记住这个决定/约束」 | `remember_memory`；已有条目需要改写时用 `revise_memory_entry` |
| 用户说「这条过时了」 | `retire_memory_entry` |
| 当天任务收尾、要换分支 | `handoff_current_work`，返回临时 handoff；确认后再 `commit_handoff` |
| 只是这轮临时约定、代码草稿、试错 | **不写** |

## 三、查询与写入的具体纪律

- 查询词用**用户原话 + 关键标识**（模块名、函数名、错误码），不要自动拼成很长的模板句；过长查询会稀释召回。
- `limit` 默认 5。空结果就如实说「没有相关历史」，不要去翻全量条目凑答案。
- 写入内容只保存可复用结论（决策、约束、踩坑原因），不保存一次性日志、完整文件内容或密钥。
- 写入后用返回的 entry/revision 标识记录，后续修订要基于该版本，避免并发覆盖。
- 引用原文片段时保留 citation；不要把记忆里的话改写成代码注释充实现有实现。

## 四、与代码事实的边界

1. 先读代码再回答；记忆只解释动机，不替代源码事实。
2. 历史记忆与当前分支行为冲突时，以当前代码为准，并在回答里指出「记忆已过时，建议修订」，由用户决定是否 `revise_memory_entry`。
3. 记忆不授予任何操作权限：不能因为「历史上这么做过」就执行删除、重置、强推等危险操作。

## 五、失败处理

- MCP 不可用：本次任务按无历史模式继续，明确提示「记忆服务不可用」，不要静默忽略。
- 写入超时：结果未知，先查询状态再决定重试。
- 版本冲突：拉取最新版本后再改，冲突未解决时如实报告。
- 汇报时区分「检索到」「已保存」「已交接」「已确认回执」，只报工具结果支持的状态。
