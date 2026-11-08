# 魔搭（ModelScope）生态题交付说明

对应赛题：`600075`（ARTIFACT 类型，20 分，必填「魔搭作品链接」）。

作品形态：一个发布到**魔搭 Skills 技能广场**的公开 Skill，作品链接即技能页地址：

```
https://modelscope.cn/skills/<owner>/powercontext-project-memory
```

## 一、交付物清单

| 文件 | 作用 |
| --- | --- |
| `modelscope/SKILL.md` | Skill 主体，含 `name` / `version` / `description` front-matter、触发词、操作路由、失败兜底、可复现验证步骤 |
| `modelscope/references/` | 五个按需加载的细则：Scope 与记忆、交接、候选审查与发布、HTTP/MCP 边界、调用样例 |
| `modelscope/scripts/upload_skill.py` | 仅依赖 Python 标准库的一键上传脚本：身份校验 → 打包 → 上传拿 file_id → 创建 Skill → 回传技能页 URL |

## 二、上传（二选一）

方式 A：脚本一键（推荐）

```bash
export MODELSCOPE_API_TOKEN=<你的魔搭访问令牌>   # https://modelscope.cn/my/myaccesstoken
python3 modelscope/scripts/upload_skill.py --owner <你的用户名> --public
```

脚本成功时只输出一行 JSON，其中 `url` 就是可直接提交的作品链接。同名技能已存在时接口会返回 409，此时改 `--skill-name` 或到网页端更新。

方式 B：网页手工

1. 把 `modelscope/` 目录打成 zip（`SKILL.md` 必须在 zip 根层，且只能有 1 个；zip ≤ 5MB）。
2. 打开 <https://modelscope.cn/skills>，用「发布 Skill / 上传」入口上传该 zip。
3. 分类选 `developer-tools`，可见性选公开，发布后复制技能页地址。

若同名技能已存在，走更新：`PATCH /openapi/v1/skills/<owner>/<skill-name>/settings`，先重新上传新 zip 拿 `file_id`，再传 `skill_file`。

## 三、提交前校验

1. 用浏览器退出登录（或换无痕窗口）打开作品链接，确认**无需登录即可看到技能页与 SKILL.md 内容**。
2. 页面出现 `SKILL.md` 文件树、说明文字与安装入口，说明发布成功。
3. 若页面提示 `private` 或 404，回到平台把可见性改为公开后重试。

## 四、边界

- 令牌只放环境变量，脚本不会写入任何文件；仓库内不含真实令牌。
- 作品内容为 PowerContext 项目记忆 Skill，服务地址与令牌均为占位符，读者需自行部署 PowerContext 后填入。
