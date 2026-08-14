"""
前晋四公网站 · 上传价表 Serverless 函数（Vercel Python）

接收公网 admin 页 POST 的 xlsx 原始字节（带 X-Admin-Pw 密码头），
解析为 prices 结构后，通过 GitHub Contents API 把 prices.json 提交到价表仓库，
GitHub Pages 检测到推送即自动重建，公网站约 1 分钟生效。

仅提交 prices.json；schemes.json（海卡/代理公式渠道）保持仓库现状，
满足「代理报价表不与主表混用」约束。

环境变量（在 Vercel 后台加密填写，不进代码）：
  ADMIN_PW      管理密码，与内网站一致
  GITHUB_TOKEN  fine-grained PAT，需 Contents 读写
  GITHUB_REPO   价表仓库，如 chen643396-star/aheadfour-quote
  GITHUB_BRANCH 发布分支，默认 main
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

# 确保 func/ 根目录在 sys.path，便于 import parser_xlsx
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from parser_xlsx import parse_workbook  # noqa: E402


def _env(name, default=None):
    return os.environ.get(name, default)


def _gh_api(method, path, token, data=None):
    """GitHub REST API 调用（urllib，自带 SSL，不依赖 git 协议）。"""
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
    """创建/更新仓库内单个文件（Contents API）。"""
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
        # 1) 解析 FormData（兼容性最好，不再依赖自定义请求头）
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self._send(400, {"ok": False, "message": "请使用 FormData 格式上传"})
            return

        try:
            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": content_type,
                },
            )
        except Exception as e:
            self._send(400, {"ok": False, "message": f"解析上传数据失败：{e}"})
            return

        # 2) 密码校验（从 FormData 字段 pw 读取）
        admin_pw = _env("ADMIN_PW", "")
        client_pw = form.getvalue("pw", "")
        if not admin_pw or client_pw != admin_pw:
            self._send(403, {"ok": False, "message": "密码错误或无权限"})
            return

        # 3) 读取 xlsx 文件
        file_item = form["file"]
        if not file_item or not file_item.file:
            self._send(400, {"ok": False, "message": "未收到文件"})
            return
        raw = file_item.file.read()
        if not raw:
            self._send(400, {"ok": False, "message": "文件内容为空"})
            return
        fname = file_item.filename or ""

        # 4) 暂存并解析（与内网站 reparse_and_save 逻辑一致）
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

        # 5) 版本/来源/时间（与内网站保持一致）
        m = re.search(r"(\d{8})", fname)
        data["version"] = m.group(1) if m else datetime.now().strftime("%Y%m%d")
        data["source_file"] = fname
        data["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # 6) 提交 prices.json 到 GitHub 仓库
        repo = _env("GITHUB_REPO", "")
        gh_token = _env("GITHUB_TOKEN", "")
        branch = _env("GITHUB_BRANCH", "main")
        if not repo or not gh_token:
            self._send(500, {"ok": False, "message": "GitHub 配置缺失（环境变量未设置）"})
            return

        content = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        st, _ = _gh_upload_file(
            repo, gh_token, branch, "prices.json", content,
            message="update prices.json via public upload",
        )
        if st in (200, 201):
            ch = sum(len(v["channels"]) for v in data["countries"].values())
            self._send(200, {
                "ok": True,
                "version": data["version"],
                "channel_count": ch,
                "fba_count": len(data.get("fba_map", {})),
                "message": "价表已提交，公网约 1 分钟生效",
            })
        else:
            self._send(500, {"ok": False, "message": f"提交 GitHub 失败（HTTP {st}）"})


# Vercel 旧版 Python 运行时也兼容 __main__ 直接执行（本地调试用）
if __name__ == "__main__":
    from http.server import HTTPServer
    HTTPServer(("127.0.0.1", 3000), handler).serve_forever()
