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
import sys
import json
import base64
import cgi
import tempfile
import urllib.request
import urllib.error
from datetime import datetime
from http.server import BaseHTTPRequestHandler

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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


CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
}


class handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        admin_pw = _env("ADMIN_PW", "")
        content_type = self.headers.get("Content-Type", "")

        # ---- 尝试方式 A：multipart/form-data（FormData）----
        if "multipart/form-data" in content_type:
            try:
                form = cgi.FieldStorage(
                    fp=self.rfile,
                    headers=self.headers,
                    environ={
                        "REQUEST_METHOD": "POST",
                        "CONTENT_TYPE": content_type,
                    },
                )
                client_pw = form.getvalue("pw", "")
                if not client_pw:
                    client_pw = self.headers.get("X-Admin-Pw", "")
                if admin_pw and client_pw != admin_pw:
                    self._send(403, {"ok": False, "message": "密码错误"})
                    return

                file_item = form.getfirst("file") if "file" in form else None
                if not file_item or not hasattr(file_item, "file"):
                    self._send(400, {"ok": False, "message": "未收到文件"})
                    return
                raw = file_item.file.read()
                fname = getattr(file_item, "filename", "") or ""
                if raw:
                    return self._process(raw, fname)
            except Exception as e:
                # FormData 解析失败不直接报错，降级到方式 B
                pass

        # ---- 尝试方式 B：原始字节流 + 头部密码 ----
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw:
            self._send(400, {"ok": False, "message": "未收到文件内容"})
            return

        client_pw = self.headers.get("X-Admin-Pw", "")
        if admin_pw and client_pw != admin_pw:
            self._send(403, {"ok": False, "message": "密码错误"})
            return
        fname = self.headers.get("X-File-Name", "") or ""

        return self._process(raw, fname)

    def _process(self, raw, fname):
        """解析 xlsx → 提交 GitHub → 返回结果。"""
        # 暂存并解析
        fd, tmp = tempfile.mkstemp(suffix=".xlsx")
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        try:
            data = parse_workbook(tmp)
        except Exception as e:
            self._send(400, {"ok": False, "message": f"解析失败：{e}"})
            return
        finally:
            try:
                os.remove(tmp)
            except Exception:
                pass

        # 版本/来源/时间
        m = re.search(r"(\d{8})", fname)
        data["version"] = m.group(1) if m else datetime.now().strftime("%Y%m%d")
        data["source_file"] = fname
        data["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # 提交到 GitHub
        repo = _env("GITHUB_REPO", "")
        gh_token = _env("GITHUB_TOKEN", "")
        branch = _env("GITHUB_BRANCH", "main")
        if not repo or not gh_token:
            self._send(500, {"ok": False, "message": "服务端配置缺失"})
            return

        content = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        st, _ = _gh_upload_file(
            repo, gh_token, branch, "prices.json", content,
            message="update prices.json via public upload",
        )
        if st in (200, 201):
            ch = sum(len(v.get("channels", [])) for v in data.get("countries", {}).values())
            self._send(200, {
                "ok": True,
                "version": data["version"],
                "channel_count": ch,
                "fba_count": len(data.get("fba_map", {})),
                "message": "价表已提交，公网约 1 分钟生效",
            })
        else:
            self._send(500, {"ok": False, "message": f"提交失败（HTTP {st}）"})


if __name__ == "__main__":
    from http.server import HTTPServer
    HTTPServer(("127.0.0.1", 3000), handler).serve_forever()
