# Qoder 生态题交付说明

> **项目网站已通过 Qoder Sites 发布，公开可访问**：<https://powercontext-9ic1smu57sb.qoder.zone>
>
> 访问验证：2026-11-08 用未登录的 `curl` 访问该地址返回 **HTTP 200**（75KB，页面标题「PowerContext — 让 AI 记住你的项目」）。

对应赛题：`600078`（CODE 类型，20 分，除 commit/branch 外必填「作品链接」）。

## 一、交付物

本目录是一个**可运行的真实项目**：文献工作台（Qoder 开发），核心功能同时依赖 seekdb 与 PowerContext。

| 路径 | 作用 |
| --- | --- |
| `qoder/src/db.mjs` | 真实调用 `@oceanbase/seekdb-node` 建库、用 MySQL 协议建表与读写 |
| `qoder/src/ingest.mjs` | 把 `notes/`、`decisions/` 切成条目并写入 seekdb 向量列 |
| `qoder/src/embed.mjs` | 本地确定性嵌入（384 维），用于向量召回 |
| `qoder/src/powercontext.mjs` | 真实 HTTP 调用 `/v1/scope-bindings/resolve`、`/v1/memory/remember`、`/v1/memory/search` |
| `qoder/src/workbench.mjs` | 研究决策的写入与读回，兼容 PowerContext 1.4.0 与旧版返回结构 |
| `qoder/src/recall.mjs` | 召回入口：seekdb 向量检索 + PowerContext 决策读回 |
| `qoder/cli.mjs` | 命令行入口：ingest / search / recall / remember / recall-decision |
| `qoder/scripts/init.sh` | 可复现初始化：`npm i` + 入库 |
| `qoder/scripts/qoder-session.mjs` | 生成带 request_id 的真实运行证据 |
| `qoder/scripts/verify-qoder.mjs` | 最小连通性验证（seekdb 打开 + 一次向量检索） |
| `qoder/test/workbench.test.mjs` | 5 条测试，覆盖嵌入、采集、召回、兼容读回、降级 |
| `qoder/notes/` | 文献笔记（入库后被向量检索召回） |
| `qoder/decisions/` | 研究决策（入库后被向量检索召回） |
| `qoder/docs/evidence/` | 真实运行记录，含 PowerContext 返回的 request_id |

`qoder/SKILL.md` 是项目在 Qoder 里的使用规范（如何在 IDE 里用本项目）。

## 二、为什么这算「实际使用」

不是文档声明，而是代码里真实存在两条可验证的调用链：

1. **seekdb**：@oceanbase/seekdb-node 真实进程启动，MySQL 协议建表
   `notes(id, title, body, vec VECTOR(384))` / `decisions(...)`，写入向量后用
   `cosine_distance(vec, ?) ORDER BY dist ASC` 召回。证据文件里的 distance 值来自真实查询。
2. **PowerContext**：真实 HTTP POST `/v1/memory/remember` 与 `/v1/memory/search`，
   证据文件里的 `request_id` 取自服务响应的 `X-PowerContext-Request-ID` 头。

两者的距离值、request_id、耗时、回包体全部来自实际执行。

## 三、本地复现

```bash
cd qoder
bash scripts/init.sh          # npm i + 入库
bash scripts/run-demo.sh      # 入库 -> 向量检索 -> 综合召回 -> 测试
```

需要 Node >= 22（与评测环境一致）。PowerContext 未启动时，召回会明确降级并继续，
不会静默失败；带上 `POWERCONTEXT_URL` 即可指向真实服务：

```bash
POWERCONTEXT_URL=http://127.0.0.1:8787 node scripts/qoder-session.mjs
```

## 四、「作品链接」填什么

按优先级取一条即可，三条都是可公开访问、无需登录的地址：

1. **Qoder Sites 站点（已发布，首选）**

   ```
   https://powercontext-9ic1smu57sb.qoder.zone
   ```

2. **仓库目录页**

   ```
   https://github.com/Xyangshaun/powercontext/tree/2026-competition-ecosystem/qoder
   ```

3. **仓库文件页**

   ```
   https://github.com/Xyangshaun/powercontext/blob/2026-competition-ecosystem/qoder/README.md
   ```

不要填本地路径、私有仓库地址或需要登录的链接。

## 五、边界

- 仓库内不写真实令牌、不写真实内网地址，统一用 `${POWERCONTEXT_URL}` / `${POWERCONTEXT_TOKEN}` 占位。
- 嵌入是本地确定性哈希，不是模型嵌入，仅用于检索召回。
- 记忆不授予权限：不能因为「历史上这么做过」就执行删除、重置、强推。
