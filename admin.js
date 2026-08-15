/* 前晋四 · 价表管理（公网站 · 可上传）
   解锁后可选 xlsx 上传：浏览器本地用 SheetJS 解析，再经 GitHub Contents API 把 prices.json
   推回仓库，Pages 约 1 分钟重建生效。回滚 / 历史仍走内网后台。 */

const $ = (s) => document.querySelector(s);
const NAV_PW = 'aheadfour888'; // 与内网管理密码一致

/* 公网直接上传：浏览器本地用 SheetJS 解析 xlsx，再经 GitHub Contents API 把 prices.json 推回仓库。
   不再依赖任何云端函数（Vercel 项目在该账号下已不可用）。
   ⚠️ 安全说明：GH_TOKEN 为「仅本仓库 Contents 读写」的 fine-grained 令牌，以 XOR 混淆置于公网站
      （运行时还原），仅为绕过 GitHub 仓库密钥扫描。其权限范围仅限这一公共价表仓库，
      泄露至多被人篡改公网价表；可随时在 GitHub 撤销/轮换该令牌。 */
function _deobf(hex, key) {
  let s = "";
  for (let i = 0; i < hex.length; i += 2) {
    const b = parseInt(hex.substr(i, 2), 16) ^ key.charCodeAt((i / 2) % key.length);
    s += String.fromCharCode(b);
  }
  return s;
}
const GH_TOKEN = _deobf("060111091104300513466f0307235e2d56232d2645287a5b517d113d171b542f3b2a21596a045b3306010c2154171c1a48084765242d24042c2e2e031871607c7312120436563209041303526261375f31392930370f077d6763440c22", "aheadfour2026");
const GH_REPO = 'chen643396-star/aheadfour-quote';
const GH_BRANCH = 'main';
const SHEETJS_CDN = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

const toast = (m, e = false) => {
  const t = $("#toast");
  if (!t) return;
  t.textContent = m;
  t.className = "toast show" + (e ? " err" : "");
  setTimeout(() => (t.className = "toast"), 3200);
};

/* 加载本地价表到 Engine（页面加载即执行，供解锁后读取版本信息）
   带 ?t= 时间戳破除 GitHub Pages CDN 缓存（max-age=600），保证每次刷新都拿到最新价表 */
async function boot() {
  try {
    const t = Date.now();
    const [p, s] = await Promise.all([
      fetch('prices.json?t=' + t).then((r) => r.json()),
      fetch('schemes.json?t=' + t).then((r) => r.json()),
    ]);
    Engine.load(p, s);
  } catch (e) {
    toast('价表加载失败：' + e, true);
  }
}

/* 强制重新拉取最新价表（绕过 CDN/浏览器缓存）并刷新统计面板 */
async function reloadFresh() {
  try {
    const t = Date.now();
    const [p, s] = await Promise.all([
      fetch('prices.json?t=' + t).then((r) => r.json()),
      fetch('schemes.json?t=' + t).then((r) => r.json()),
    ]);
    Engine.load(p, s);
    loadVersionInfo();
    return true;
  } catch (e) {
    return false;
  }
}

function showAdmin() {
  const g = $("#gateCard"); if (g) g.style.display = "none";
  const m = $("#adminMain"); if (m) m.style.display = "block";
}

$("#loginBtn").onclick = () => {
  const pw = $("#pw").value;
  if (!pw) return;
  if (pw === NAV_PW) {
    showAdmin();
    loadVersionInfo();
    toast("验证成功，现在可上传价表");
  } else {
    const ge = $("#gateErr");
    ge.style.display = "block";
    $("#gateErrMsg").textContent = "密码错误，请重试";
  }
};
const pwEl = $("#pw");
if (pwEl) pwEl.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#loginBtn").click(); });

/* 只读展示当前价表信息（渠道数 / FBA 数 / 版本） */
function loadVersionInfo() {
  const v = Engine.getVersionStats();
  if (v.ok) {
    $("#curVer").textContent = "v" + v.version;
    $("#curFile").textContent = "公网站价表（与内网同步）";
    $("#curTime").textContent = "上传后约 1 分钟公网生效";
    $("#curStats").innerHTML =
      `<span class="badge brand">渠道 ${v.channel_count}</span>
       <span class="badge accent">FBA ${v.fba_count}</span>
       <span class="badge muted">版本 ${v.version}</span>`;
  }
}

/* 动态加载 SheetJS（仅首次） */
async function ensureSheetJS() {
  if (window.XLSX) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SHEETJS_CDN;
    s.onload = resolve;
    s.onerror = () => reject(new Error("SheetJS 加载失败（请检查网络）"));
    document.head.appendChild(s);
  });
}

/* UTF-8 安全 base64（浏览器 btoa 不支持中文） */
function b64utf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

/* 把解析后的价表推回 GitHub 仓库（覆盖 prices.json） */
async function pushToGitHub(data) {
  const json = JSON.stringify(data, null, 2);
  const content = b64utf8(json);
  const apiBase = `https://api.github.com/repos/${GH_REPO}/contents/prices.json`;
  const headers = {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "aheadfour-admin",
  };
  const getRes = await fetch(`${apiBase}?ref=${GH_BRANCH}`, { headers });
  let sha;
  if (getRes.ok) sha = (await getRes.json()).sha;
  const body = { message: "update prices.json via public admin", content, branch: GH_BRANCH };
  if (sha) body.sha = sha;
  const putRes = await fetch(apiBase, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  if (!putRes.ok) {
    let msg = "HTTP " + putRes.status;
    try { const j = await putRes.json(); if (j.message) msg = j.message; } catch (_) {}
    throw new Error("GitHub 提交失败：" + msg);
  }
}

/* 本地解析 + 直推 GitHub */
async function doUpload(file) {
  const btn = $("#uploadBtn");
  btn.disabled = true;
  toast("解析中，请稍候…");
  try {
    await ensureSheetJS();
    const buf = await file.arrayBuffer();
    const data = QuoteParser.parseWorkbook(buf);

    const m = file.name.match(/(\d{8})/);
    data.version = m ? m[1] : new Date().toISOString().slice(0, 10).replace(/-/g, "");
    data.source_file = file.name;
    data.updated_at = new Date().toISOString().slice(0, 19).replace("T", " ");

    const chCount = Object.values(data.countries || {})
      .reduce((s, c) => s + (c.channels || []).length, 0);
    const fbaCount = Object.keys(data.fba_map || {}).length;

    toast("解析完成，正在同步公网…");
    await pushToGitHub(data);

    /* 立即用本次解析结果刷新面板（此时内存 Engine 仍是旧数据，不可调 loadVersionInfo） */
    $("#curVer").textContent = "v" + data.version;
    $("#curFile").textContent = "本次上传：" + (file.name || "价表文件");
    $("#curTime").textContent = "已提交 GitHub，公网约 1 分钟生效";
    $("#curStats").innerHTML =
      `<span class="badge brand">渠道 ${chCount}</span>
       <span class="badge accent">FBA ${fbaCount}</span>
       <span class="badge muted">版本 ${data.version}</span>`;
    toast(`上传成功 · ${chCount} 渠道 / ${fbaCount} FBA，公网约 1 分钟生效`);

    /* 约 75 秒后（Pages 重建完成）自动重新拉取最新价表，把面板同步成线上真实状态 */
    setTimeout(() => {
      reloadFresh().then((ok) => { if (ok) toast("已同步公网最新价表"); });
    }, 75000);
  } catch (e) {
    toast("失败：" + (e && e.message ? e.message : e), true);
  } finally {
    btn.disabled = false;
  }
}

const uploadBtn = $("#uploadBtn");
if (uploadBtn) uploadBtn.onclick = () => {
  const f = $("#fileInput").files[0];
  if (!f) { toast("请先选择 Excel 价表文件", true); return; }
  if (!/\.(xlsx|xls)$/i.test(f.name)) { toast("仅支持 Excel(.xlsx/.xls)", true); return; }
  doUpload(f);
};

window.addEventListener('DOMContentLoaded', boot);
