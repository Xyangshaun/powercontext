#!/usr/bin/env python3
"""把 modelscope/ 目录打包并发布到魔搭 Skills 广场。

仅使用 Python 标准库。流程：获取身份 → 打包 zip → 上传拿 file_id → 创建或更新 Skill → 校验。

用法：
    MODELSCOPE_API_TOKEN=xxx python3 upload_skill.py --owner <username>

可选参数：
    --dir <目录>         待打包的 Skill 目录，默认脚本所在目录的上一级
    --skill-name <名字>  默认 powercontext-project-memory
    --category <分类>    默认 developer-tools
    --public / --private 默认私有；确定要公开时再传 --public
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
import zipfile

BASE = "https://modelscope.cn/openapi/v1"


def _token() -> str:
    token = os.environ.get("MODELSCOPE_API_TOKEN", "").strip()
    if not token:
        sys.exit("缺少环境变量 MODELSCOPE_API_TOKEN，请先到 https://modelscope.cn/my/myaccesstoken 获取")
    return token


def _request(method: str, path: str, token: str, payload=None, raw=None, content_type=None):
    url = BASE + path
    headers = {"Authorization": f"Bearer {token}"}
    data = None
    if raw is not None:
        data = raw
        headers["Content-Type"] = content_type
    elif payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as err:
        body = err.read().decode(errors="replace")
        sys.exit(f"{method} {path} 失败 HTTP {err.code}: {body}")


def _zip_dir(root: str) -> bytes:
    count = 0
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for current, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in {"__pycache__", ".git"}]
            for name in files:
                full = os.path.join(current, name)
                rel = os.path.relpath(full, root)
                if rel == "SKILL.md":
                    count += 1
                zf.write(full, rel)
    if count != 1:
        sys.exit(f"zip 根目录必须且只能有 1 个 SKILL.md，当前发现 {count} 个")
    data = buf.getvalue()
    if len(data) > 5 * 1024 * 1024:
        sys.exit(f"zip 超过 5MB（{len(data)} 字节），请把大文件改为外链")
    return data


def _multipart(field: str, filename: str, content: bytes):
    boundary = uuid.uuid4().hex
    body = b"".join(
        [
            f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode(),
            b"Content-Type: application/zip\r\n\r\n",
            content,
            f"\r\n--{boundary}--\r\n".encode(),
        ]
    )
    return body, f"multipart/form-data; boundary={boundary}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap.add_argument("--skill-name", default="powercontext-project-memory")
    ap.add_argument("--owner", default=None)
    ap.add_argument("--category", default="developer-tools")
    ap.add_argument("--display-name", default="PowerContext 项目记忆")
    ap.add_argument("--description", default=None)
    ap.add_argument("--public", action="store_true")
    args = ap.parse_args()

    token = _token()

    me = _request("GET", "/users/me", token)
    owner = args.owner or me.get("data", {}).get("username")
    if not owner:
        sys.exit(f"无法从 /users/me 取得 username：{me}")

    content = _zip_dir(args.dir)
    body, ctype = _multipart("file", f"{args.skill_name}.zip", content)
    uploaded = _request("POST", "/files/upload", token, raw=body, content_type=ctype)
    file_id = uploaded.get("data", {}).get("id")
    if not file_id:
        sys.exit(f"上传未返回 file_id：{uploaded}")

    description = args.description or (
        "用 PowerContext（OceanBase 驱动的项目记忆服务）找回历史决策、写入可复用结论并完成任务交接。"
    )

    skill = _request("POST", "/skills", token, payload={
        "skill_name": args.skill_name,
        "owner": owner,
        "display_name": args.display_name,
        "description": description,
        "license": "Apache-2.0",
        "category": args.category,
        "private": not args.public,
        "skill_file": file_id,
    })
    url = skill.get("data", {}).get("url") or f"https://modelscope.cn/skills/{owner}/{args.skill_name}"
    print(json.dumps({"owner": owner, "skill_name": args.skill_name, "url": url}, ensure_ascii=False))


if __name__ == "__main__":
    main()
