---
name: powercontext-dify-project-memory
description: 在 Dify 工作流/Agent 中接入 PowerContext，为多轮应用提供可回查的项目记忆。检索历史决策、按用户明确要求记住/修正记忆、读取主题摘要、交接当前工作。触发词：记住这个、上次的决定、项目记忆、历史背景、接着上次做、交接。Use when a Dify app needs durable project memory, earlier decisions, or a resumable handoff across runs.
---

# Dify 项目记忆

把 PowerContext 当作 Dify 应用的记忆后端：先用 `search_memory` 找回历史，再回答；只有用户明确要求时才写入。所有引用、版本号与回执原样保留，不编造证据。

## 一、在 Dify 中连接

1. 在 **工具 → MCP 服务** 中新增一个 MCP Server：
   - 传输方式：**Streamable HTTP**（服务端同时支持 SSE 时再降级）
   - URL：环境变量 `POWERCONTEXT_MCP_URL`（例如 `https://<host>/mcp`）
   - 鉴权：按服务端要求填 `Authorization` 头，令牌放 Dify 的**环境变量/凭据**，不要写进工作流提示词或仓库文件
2. 连接成功后确认工具列表里能看到 `resolve_scope_binding`、`search_memory`、`remember_memory` 等操作；工具的完整名称以 Dify 工具面板显示的为准（带命名空间前缀时使用全名，不要自己拼）。
3. 若应用通过自定义工具走 HTTP，而不是 MCP，请改用 PowerContext 的 HTTP API，并保持同样的读写纪律（见第五节）。

## 二、推荐工作流骨架

```
Start（question, user_intent, explicit_scope_id?）
  → 参数提取（LLM：判断是否属于「需要历史」的请求）
  → MCP：resolve_scope_binding（第一条数据操作前必调）
  → 条件分支
      ├─ 需要历史 → MCP：search_memory（query=question，limit=5）
      └─ 不需要   → 跳过检索
  → LLM 回答（把命中的 text 与 citation 作为上下文，按引用逐条标注）
  → 条件分支：用户明确说「记住/记一下/更正」→ MCP：remember_memory / revise_memory_entry
  → End（answer, citations[], scope_id, receipt?）
```

- **Scope 先行**：`resolve_scope_binding` 先调再读写。用户明确指定 Scope 时传 `explicit_scope_id`；使用默认 Scope 时显式传 `allow_default: true`，不要用空对象调用，也不要猜 ID。
- **检索参数**：`query` 用用户原话，不要自行改写成长句模板；`limit` 默认 5，检索为空是合法结果，不要升级成全量列举。
- **回答约束**：只使用返回片段中的事实；跨应用/跨租户数据不得串用 Scope。

## 三、什么时候读、什么时候写

| 用户意图 | 操作 |
| --- | --- |
| 问「上次/之前/当时怎么定的」、缺少项目背景 | `search_memory` |
| 明确要求盘点、审计已存记忆 | `list_memory_entries`（不要用空检索替代列举） |
| 明确要求「记住」「更正」「作废」 | `remember_memory` / `revise_memory_entry` / `retire_memory_entry` |
| 想看主题级摘要 | `search_topic_memory` → `get_topic_memory` |
| 会话要跨天接续、需要正式交接 | `handoff_current_work`（返回临时 handoff），里程碑确定后再 `commit_handoff` |
| 只是当前这轮的临时约束、讨论、预览 | **不写** |

写入前先问自己：这是不是用户的持久化意图。同一任务已给过的授权可以复用；新任务不要顺手写库。

## 四、多轮与并发

- 每个 Dify 会话维护一个 `scope_id` 变量，后续节点复用它，避免每次重新解析。
- `capture_content_source` 只表示来源被接收，不代表已生成记忆或立即可检索；不要用它替代显式保存。
- 写入是幂等还是非幂等要看操作本身：超时的写入结果可能未知，先查状态再重试，不要盲目重放。

## 五、失败与收尾

- 工具报错或连接断开：在 End 节点输出「记忆服务不可用」，本次回答降级为无历史模式，**不要把失败当成空结果**。
- 版本冲突：刷新条目后重试，或提示用户冲突存在。
- 汇报时区分：检索到的历史 / 已保存的记忆 / 已接收的来源 / 已提交的交接 / 已确认的回执。只报工具结果支持的状态。
- 不要把令牌、内部 URL、用户隐私写进日志节点或调试输出。
