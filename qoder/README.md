# Qoder 生态题交付说明

> **项目网站已通过 Qoder Sites 发布，公开可访问**：<https://powercontext-9ic1smu57sb.qoder.zone>
>
> 访问验证：2026-11-08 用未登录的 `curl` 访问该地址返回 **HTTP 200**（75KB，页面标题「PowerContext — 让 AI 记住你的项目」）。

对应赛题：`600078`（CODE 类型，20 分，除 commit/branch 外必填「作品链接」）。

## 一、交付物

| 文件 | 作用 |
| --- | --- |
| `qoder/SKILL.md` | Qoder 场景的项目记忆 Skill：MCP 接入配置、IDE 使用节奏、查询/写入纪律、与代码事实的边界、失败处理 |

题面判定为 CODE 类型，评审以仓库内文件为准，因此 Skill 本身必须可被 Qoder 直接加载使用，`commit` / `branch` 指向本分支包含 `qoder/SKILL.md` 的提交。

## 二、「作品链接」填什么

按优先级取一条即可，三条都是可公开访问、无需登录的地址：

1. **仓库文件页（推荐、最稳）**

   ```
   https://github.com/Xyangshaun/powercontext/blob/2026-competition-ecosystem/qoder/SKILL.md
   ```

2. **仓库目录页**（想让评审顺带看到同分支其他生态材料时用）

   ```
   https://github.com/Xyangshaun/powercontext/tree/2026-competition-ecosystem/qoder
   ```

3. **Qoder Sites 站点（已发布，首选）**

   ```
   https://powercontext-9ic1smu57sb.qoder.zone
   ```

不要填本地路径、私有仓库地址或需要登录的链接。

## 三、在 Qoder 里验证（可复现，不依赖截图）

1. Qoder → 设置 → MCP，新增 `powercontext` 服务，`url` 填你的 PowerContext MCP 地址，`Authorization` 用环境变量占位。
2. 打开工具列表，确认 `resolve_scope_binding`、`search_memory`、`remember_memory` 三个工具可见（有前缀则用全名）。
3. 在对话里说「接着上次的任务」，观察是否触发 `search_memory`、是否带 citation 返回；服务不可用时应明确提示「记忆服务不可用」而不是静默跳过。
4. 说「记住这个决定：……」，确认 `remember_memory` 返回 entry/revision 标识。
5. 说「这轮先这样，明天继续」，确认走 `handoff_current_work` 并明确区分「已准备交接」与「已提交里程碑」。

以上任一环节的实际返回即为证据；未跑通就如实写「未验证」，不要补截图。

## 四、边界

- 仓库内不写真实令牌、不写真实内网地址，统一用 `${POWERCONTEXT_MCP_URL}` / `${POWERCONTEXT_TOKEN}` 占位。
- 记忆不授予权限：不能因为「历史上这么做过」就执行删除、重置、强推。
