# 前晋四公网站 · 上传函数部署说明

本目录 `func/` 是公网站「外网上传价表」的云端函数（Vercel Python）。

## 文件
- `api/upload.py`：接收公网 admin 页 POST 的 xlsx（带 X-Admin-Pw 密码头），
  解析后把 prices.json 提交到 GitHub 仓库，Pages 自动重建。
- `parser_xlsx.py`：价表解析器（与内网站同一份逻辑）。
- `requirements.txt`：openpyxl 依赖。
- `vercel.json`：Vercel 构建配置。

## 部署（Vercel，免费 Hobby）
1. 打开 https://vercel.com ，用 GitHub 登录（同一账号 chen643396-star）。
2. New Project → Import 仓库 `aheadfour-quote`。
3. Root Directory 改为 `func`（默认是仓库根，必须改，否则找不到函数）。
4. Environment Variables 添加 4 条：
   - ADMIN_PW = aheadfour888
   - GITHUB_TOKEN = 现有 fine-grained PAT（github_pat_ 开头，需 Contents 读写）
   - GITHUB_REPO = chen643396-star/aheadfour-quote
   - GITHUB_BRANCH = main
5. Deploy。完成后函数地址形如 https://<project>.vercel.app/api/upload
6. 把该 /api/upload 完整地址发给 agent，注入 dist-customer/admin.js 的 UPLOAD_API 即完成。

## 数据流
公网 admin 页 → Vercel 函数（解析 xlsx）→ 提交 prices.json 到 GitHub
→ Pages 重建 → 公网站约 1 分钟生效。
内网站上传走原 Flask，同样提交该仓库，二者共用一份 prices.json。

## 注意
- 函数每次上传会向仓库提交 prices.json，可能触发 Vercel 对自身的一次冗余重建（无害）。
- 回滚 / 历史仍在内网站操作。
- PAT 存于 Vercel 环境变量，不进代码。
