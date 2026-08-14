"""
前晋四公网站 · 上传价表 Serverless 函数（Vercel Python）

接收公网 admin 页 POST 的 xlsx 文件，
解析为 prices 结构后，通过 GitHub Contents API 把 prices.json 提交到价表仓库，
GitHub Pages 检测到推送即自动重建，公网站约 1 分钟生效。

仅提交 prices.json；schemes.json（海卡/代理公式渠道）保持仓库现状。

支持两种上传格式（自动检测）：
  - multipart/form-data（FormData）：字段 file=文件, pw=密码
  - application/octet-stream（原始字节）：头 X-Admin-Pw=密码

环境变量：
  ADMIN_PW      管理密码
  GITHUB_TOKEN  fine-grained PAT（Contents 读写）
  GITHUB_REPO   价表仓库
  GITHUB_BRANCH 分支（默认 main）
"""
import os
import re
import json
import base64
import tempfile
import urllib.request
import urllib.error
from datetime import datetime

sys_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if sys_path not in __import__("sys").path:
    __import__("sys").path.append(sys_path)
from parser_xlsx import parse_workbook  # noqa: E402


def _env(name, default=None):
    return os.environ.get(name, default)


def _gh_api(method, path, token, data=None):
    url = "https://api.github.com" + path
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "aheadfour-upload-fn",
    }
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {"message": e.reason}


def _gh_upload_file(repo, token, branch, path_rel, content_bytes, message=None):
    st, cur = _gh_api("GET", f"/repos/{repo}/contents/{path_rel}?ref={branch}", token)
    sha = cur.get("sha") if st == 200 else None
    data = {
        "message": message or f"sync: {path_rel}",
        "content": base64.b64encode(content_bytes).decode(),
        "branch": branch,
    }
    if sha:
        data["sha"] = sha
    return _gh_api("PUT", f"/repos/{repo}/contents/{path_rel}", token, data)


def _json_resp(code, obj):
    """构造 Vercel Response 格式。"""
    body_str = json.dumps(obj, ensure_ascii=False)
    return {
        "statusCode": code,
        "headers": {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "*",
        },
        "body": body_str,
    }


def _process_xlsx(raw_bytes, fname):
    """解析 xlsx → 提交 GitHub → 返回结果字典。"""
    fd, tmp = tempfile.mkstemp(suffix=".xlsx")
    with os.fdopen(fd, "wb") as f:
        f.write(raw_bytes)
    try:
        data = parse_workbook(tmp)
    except Exception as e:
        return _json_resp(400, {"ok": False, "message": f"解析失败：{e}"})
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass

    m = re.search(r"(\d{8})", fname)
    data["version"] = m.group(1) if m else datetime.now().strftime("%Y%m%d")
    data["source_file"] = fname
    data["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    repo = _env("GITHUB_REPO", "")
    gh_token = _env("GITHUB_TOKEN", "")
    branch = _env("GITHUB_BRANCH", "main")
    if not repo or not gh_token:
        return _json_resp(500, {"ok": False, "message": "服务端配置缺失"})

    content = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    st, _ = _gh_upload_file(
        repo, gh_token, branch, "prices.json", content,
        message="update prices.json via public upload",
    )
    if st in (200, 201):
        ch = sum(len(v.get("channels", [])) for v in data.get("countries", {}).values())
        return _json_resp(200, {
            "ok": True,
            "version": data["version"],
            "channel_count": ch,
            "fba_count": len(data.get("fba_map", {})),
            "message": "价表已提交，公网约 1 分钟生效",
        })
    else:
        return _json_resp(500, {"ok": False, "message": f"提交失败（HTTP {st}）"})


# ── Vercel 入口函数 ──────────────────────────────────────────────
def handler(request):
    """
    Vercel Python 函数入口。
    request 是 Vercel Request 对象，有 method/body/headers 等属性。
    返回 dict（自动转为 HTTP Response）。
    """
    # OPTIONS 预检
    if request.method == "OPTIONS":
        return {
            "statusCode": 204,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "*",
            },
            "body": "",
        }

    # 只接受 POST
    if request.method != "POST":
        return _json_resp(405, {"ok": False, "message": "仅支持 POST"})

    admin_pw = _env("ADMIN_PW", "")
    content_type = request.headers.get("content-type", "")

    raw = b""
    fname = ""
    client_pw = ""

    # 方式 A：multipart/form-data（FormData）
    if "multipart/form-data" in content_type:
        body_raw = request.body
        if isinstance(body_raw, str):
            body_raw = body_raw.encode("latin-1")

        boundary = ""
        for part in content_type.split(";"):
            part = part.strip()
            if part.startswith("boundary="):
                boundary = part[len("boundary="):].strip('"')
                break

        if boundary and body_raw:
            parts = body_raw.split(f"--{boundary}".encode())
            for p in parts[1:-1]:  # skip first (preamble) and last (epilogue)
                header_end = p.find(b"\r\n\r\n")
                if header_end < 0:
                    continue
                part_headers = p[:header_end].decode("latin-1", errors="replace")
                part_data = p[header_end + 4:].rstrip(b"\r\n")

                # 跳过末尾的 -- 如果存在
                if part_data.endswith(b"--"):
                    part_data = part_data[:-2].rstrip(b"\r\n")

                cd_line = [l for l in part_headers.split("\r\n") if l.lower().startswith("content-disposition:")]
                if not cd_line:
                    continue
                cd = cd_line[0]

                if 'name="pw"' in cd or 'name="pw"' in cd:
                    client_pw = part_data.decode("utf-8", errors="replace")
                elif 'name="file"' in cd:
                    raw = part_data
                    fn_match = re.search(r'filename="(.+)"', cd)
                    if fn_match:
                        fname = fn_match.group(1)

    # 方式 B：原始字节流（降级 / 兼容旧前端）
    if not raw:
        body = request.body
        if isinstance(body, str):
            raw = body.encode("latin-1")
        elif isinstance(body, bytes):
            raw = body
        client_pw = request.headers.get("x-admin-pw", "")
        fname = request.headers.get("x-file-name", "") or ""

    # 密码校验
    if admin_pw and client_pw != admin_pw:
        return _json_resp(403, {"ok": False, "message": "密码错误或无权限"})

    if not raw:
        return _json_resp(400, {"ok": False, "message": "未收到文件内容"})

    return _process_xlsx(raw, fname)
