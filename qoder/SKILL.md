---
name: qoder-lit-workbench
description: 在 Qoder（AI IDE）里用文献工作台做研究提效：开工前用 seekdb 向量检索召回相关文献与决策，收尾时把可复用结论写进 PowerContext 记忆，跨会话/换分支时交接。触发词：相关文献、之前为什么这么定、检索笔记、记住这个结论、接着上次的调研、交接。Use in Qoder when a research task needs prior literature context or must leave a resumable decision record.
---

# 文献工作台

研究工作里最容易丢的是「之前查过什么、为什么这么定」。本项目只做三件事：开工前用向量检索召回相关文献与决策、收尾时按需保存结论、换会话时交接。代码本身、当前仓库事实和用户当轮指令永远优先于历史记忆。

## 一、项目是什么

文献工作台是一个单进程本地服务，数据分两处：

- **seekdb**（本地向量库）：存 `notes/` 下的文献笔记与 `decisions/` 下的研究决策，
  每条带 384 维向量，用 `cosine_distance` 做语义召回。
- **PowerContext**（长期记忆服务）：存跨会话的研究决策，按 scope 检索。

召回入口是 `qoder/src/recall.mjs`：先用 seekdb 找相关文献与决策，再尝试用
PowerContext 读回该课题上已保存的决策；PowerContext 不可用时明确降级，不静默失败。

## 二、在 Qoder 中连接

1. Qoder 的 **设置 → MCP** 新增 PowerContext 服务（JSON 结构与常见客户端一致）：

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

2. 令牌放环境变量或 Qoder 的凭据存储，**不要**提交到仓库。

3. 连上后确认 `resolve_scope_binding`、`search_memory`、`remember_memory` 出现在工具列表
   （工具名以面板显示为准，有前缀就用全名）。

## 三、推荐的 IDE 使用节奏

| 时机 | 动作 |
| --- | --- |
| 打开一个陌生课题 | `node cli.mjs recall --question "<课题>"` 或让 IDE 触发 `search_memory` |
| 用户问「上次为什么这么定」 | `search_memory`，命中的条目标注 citation 与版本 |
| 用户明确说「记住这个结论/约束」 | `remember_memory`；需要改写时用 `revise_memory_entry` |
| 当天收尾、要换分支 | `handoff_current_work`，返回临时 handoff；确认后再 `commit_handoff` |
| 只是这轮临时约定、代码草稿、试错 | **不写** |

## 四、查询与写入的具体纪律

- 查询词用**用户原话 + 关键标识**（课题名、模块名、函数名、错误码），不要自动拼成很长的模板句；过长查询会稀释召回。
- `limit` 默认 5。空结果就如实说「没有相关历史」，不要去翻全量条目凑答案。
- 写入内容只保存可复用结论（决策、约束、踩坑原因），不保存一次性日志、完整文件内容或密钥。
- 写入后用返回的 entry/revision 标识记录，后续修订要基于该版本，避免并发覆盖。
- 引用原文片段时保留 citation；不要把记忆里的话改写成代码注释充实现有实现。

## 五、与代码事实的边界

1. 先读代码再回答；记忆只解释动机，不替代源码事实。
2. 历史记忆与当前分支行为冲突时，以当前代码为准，并在回答里指出「记忆已过时，建议修订」，由用户决定是否 `revise_memory_entry`。
3. 记忆不授予任何操作权限：不能因为「历史上这么做过」就执行删除、重置、强推等危险操作。

## 六、失败处理

- MCP 不可用：本项目按无历史模式继续，明确提示「记忆服务不可用」，不要静默忽略。
- 写入超时：结果未知，先查询状态再决定重试。
- 版本冲突：拉取最新版本后再改，冲突未解决就如实报告。
- 汇报时区分「检索到」「已保存」「已交接」「已确认回执」，只报工具结果支持的状态。

## 七、本地验证

```bash
cd qoder
bash scripts/init.sh
bash scripts/run-demo.sh
node --test test/*.test.mjs
```

`scripts/qoder-session.mjs` 会跑一次真实调用并把带 request_id 的证据写到
`docs/evidence/`，用于核对检索命中与记忆写入确实发生。
