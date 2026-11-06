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
3. 若应用通过自定义工具走 HTTP，而不是 MCP，请改用 PowerContext 的 HTTP API，并保持同样的读写纪律（见第六节）。

## 二、参数级工具清单

下表的参数名、约束与返回字段来自 PowerContext 的 OpenAPI 契约。Dify 里配置工具节点时按这张表填，不要凭印象加字段（服务端 `extra=forbid`，多余字段会直接 400）。

| 工具 | 用途 | 必填参数 | 可选参数 | 主要返回 |
| --- | --- | --- | --- | --- |
| `resolve_scope_binding` | 解析本次会话的 Scope | 无（`allow_default` 默认 `true`） | `explicit_scope_id`（1–256 字符、非空白）、`binding_keys[]`（每项含 `root.{integration,kind,external_id}` 与 `scope_id`） | `scope_id`、`title`、`summary`、`parent_scope_id`、`version` |
| `search_memory` | 检索历史记忆 | `scope_id`、`query`（1–8192 字符） | `limit`（1–50，默认 10；本 Skill 固定 5）、`mode`（`auto`/`fts`/`vector`/`hybrid`，默认 `auto`）、`tag_filter` | `hits[]`：`text`、`score`（0–1）、`matched_by[]`、`citation.{memory_ref,entry_id,entry_version_id}`；`mode` 为实际生效的检索模式 |
| `list_memory_entries` | 显式盘点/审计已存记忆 | `scope_id` | 分页与过滤参数以工具面板为准 | 条目列表（含 citation） |
| `get_memory_entry` | 按引用取精确内容 | `scope_id`、`citation`（原样回传检索结果里的那一个） | — | 条目正文、`kind`、revision |
| `remember_memory` | 显式保存新记忆 | `scope_id`、`kind`（≤128 字符）、`text`（规范化后 ≤8192 UTF-8 字节） | `reason`（≤512 字符）、`expected_revision`（≥1） | `memory` 引用；`entry`（新建时为条目，幂等命中时为 `null`） |
| `revise_memory_entry` | 更正已有条目 | `scope_id`、`citation`、`kind`、`text` | `reason` | `memory` 引用与更新后的 `entry` |
| `retire_memory_entry` | 作废条目 | `scope_id`、`citation` | `reason` | `memory` 引用；`entry` 通常为 `null` |
| `search_topic_memory` | 主题级摘要检索 | `scope_id`、`query`（1–8192 字符、首尾非空白） | `limit`（1–20，默认 10） | `hits[]`（主题摘要 + 引用） |
| `get_topic_memory` | 读取主题记忆全文 | `scope_id`、`artifact`（`ArtifactReference`，来自 `search_topic_memory`） | — | 主题记忆 artifact 内容 |
| `handoff_current_work` | 生成**临时**交接 | `scope_id`、`source_id`、`handoff`（`CurrentWorkHandoff`） | — | `PreparedWorkHandoff`（未提交，不可当里程碑） |
| `commit_handoff` | 提交里程碑交接 | `scope_id`、`handoff`（`PreparedHandoff`，必须是上一步原样返回的对象） | — | `CommittedHandoff`：`reference`、`content`、`source_refs`、`artifact_refs` |

要点：

- `citation` 是不透明引用，必须原样回传；自己拼 `entry_id` 或 `entry_version_id` 一定失败。
- `score` 是相似度不是置信概率，不要把它写进给用户的结论里。
- `search_memory` 的 `mode` 返回 `fts`/`vector`/`hybrid` 之一，说明这一轮到底走了哪条召回；排查"为什么没搜到"时先看它。

## 三、推荐工作流骨架

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
- **检索参数**：`query` 用用户原话，不要自行改写成长句模板；`limit` 固定 5，检索为空是合法结果，不要升级成全量列举。
- **回答约束**：只使用返回片段中的事实；跨应用/跨租户数据不得串用 Scope。

## 四、什么时候读、什么时候写

| 用户意图 | 操作 |
| --- | --- |
| 问「上次/之前/当时怎么定的」、缺少项目背景 | `search_memory` |
| 明确要求盘点、审计已存记忆 | `list_memory_entries`（不要用空检索替代列举） |
| 明确要求「记住」「更正」「作废」 | `remember_memory` / `revise_memory_entry` / `retire_memory_entry` |
| 想看主题级摘要 | `search_topic_memory` → `get_topic_memory` |
| 会话要跨天接续、需要正式交接 | `handoff_current_work`（返回临时 handoff），里程碑确定后再 `commit_handoff` |
| 只是当前这轮的临时约束、讨论、预览 | **不写** |

写入前先问自己：这是不是用户的持久化意图。同一任务已给过的授权可以复用；新任务不要顺手写库。

## 五、多轮与并发

- 每个 Dify 会话维护一个 `scope_id` 变量，后续节点复用它，避免每次重新解析。
- `capture_content_source` 只表示来源被接收，不代表已生成记忆或立即可检索；不要用它替代显式保存。
- 写入是幂等还是非幂等要看操作本身：超时的写入结果可能未知，先查状态再重试，不要盲目重放。

## 六、失败与收尾

- 工具报错或连接断开：在 End 节点输出「记忆服务不可用」，本次回答降级为无历史模式，**不要把失败当成空结果**。
- 版本冲突：刷新条目后重试，或提示用户冲突存在。
- 汇报时区分：检索到的历史 / 已保存的记忆 / 已接收的来源 / 已提交的交接 / 已确认的回执。只报工具结果支持的状态。

## 七、绝对禁止

- 不在 `resolve_scope_binding` 成功返回前调用任何读写工具；不用空对象、不用猜出来的 `scope_id`、不从目录名/分支名推导 Scope。
- 不把 `search_memory` 的空结果当成"系统里没有这条记忆"之外的结论，也不用它替代 `list_memory_entries` 的盘点。
- 不编造、改写或补全 `citation`（`memory_ref`/`entry_id`/`entry_version_id`）；只能原样引用工具返回的那一份。
- 不在用户没有明确表达"记住/更正/作废"时写入记忆；当前轮讨论、预览、概念解释都不构成写入授权。
- 不跨 Scope 复用命中内容，不把 A 应用的记忆拼进 B 应用的回答。
- 不把服务地址、令牌、用户隐私写进提示词、日志节点或仓库文件。
- 工具缺失或调用失败时，如实报告"该操作不可用"，不用文本模拟调用，也不改用别的持久化工具假装成功。

## 八、端到端最小示例

**输入**（Dify Chatflow 的 `Start` 节点，`question`）：

> 上次我们把 PDF 证据页的上限从 20 调到多少了？

**节点 1**：`resolve_scope_binding`

```json
{"allow_default": true, "explicit_scope_id": null, "binding_keys": []}
```

返回（节选）：

```json
{"scope_id": "scope_01HQ...", "title": "PowerContext 竞赛项目", "summary": "OB 2026 参赛工程与验收记录", "version": 3}
```

**节点 2**：`search_memory`

```json
{"scope_id": "scope_01HQ...", "query": "PDF 证据页上限从 20 调到多少", "limit": 5, "mode": "auto"}
```

返回（节选，`hits` 只列 1 条）：

```json
{
  "mode": "hybrid",
  "hits": [
    {
      "text": "证据页上限从 20 调到 40，理由是平台按组统计 Recall@20，需要给出更多候选页。",
      "score": 0.71,
      "matched_by": ["fts", "vector"],
      "citation": {"memory_ref": {"artifact_id": "mem_01H..."}, "entry_id": "ent_01H...", "entry_version_id": "rev_01H..."}
    }
  ]
}
```

**节点 3**：LLM 回答（System 里约束"只依据 `hits[].text`，逐条附 citation"）

**输出**：

> 上次把 PDF 证据页上限从 20 调到了 **40**，原因是平台按组统计 Recall@20，多给候选页更稳。
> 依据：`ent_01H... / rev_01H...`（命中方式 fts+vector）。

**End 节点**：`answer` 为上面的正文，`citations` 填 `hits[].citation` 原样数组，`scope_id` 填节点 1 返回值。

若节点 2 返回 `{"mode": "fts", "hits": []}`：回答"没有检索到相关历史"，不写成"从未讨论过"；不进入 `remember_memory`。
