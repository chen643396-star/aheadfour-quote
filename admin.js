/* 前晋四 · 价表管理（公网站 · 可上传）
   解锁后可选 xlsx 上传，POST 到 Vercel 云端函数；函数解析后写回 GitHub 仓库，
   Pages 约 1 分钟重建生效。回滚 / 历史仍走内网后台。 */

const $ = (s) => document.querySelector(s);
const NAV_PW = 'aheadfour888'; // 与内网管理密码一致

// ⚠️ 部署后由 agent 替换为真实 Vercel 函数地址（形如 https://xxx.vercel.app/api/upload）
const UPLOAD_API = 'https://aheadfour-quote.vercel.app/api/upload';

const toast = (m, e = false) => {
  const t = $("#toast");
  if (!t) return;
  t.textContent = m;
  t.className = "toast show" + (e ? " err" : "");
  setTimeout(() => (t.className = "toast"), 3200);
};

/* 加载本地价表到 Engine（页面加载即执行，供解锁后读取版本信息） */
async function boot() {
  try {
    const [p, s] = await Promise.all([
      fetch('prices.json').then((r) => r.json()),
      fetch('schemes.json').then((r) => r.json()),
    ]);
    Engine.load(p, s);
  } catch (e) {
    toast('价表加载失败：' + e, true);
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

/* 上传价表到云端函数 */
async function doUpload(file) {
  const btn = $("#uploadBtn");
  btn.disabled = true;
  toast("上传中，解析并同步公网，请稍候…");
  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("pw", $("#pw").value);
    const res = await fetch(UPLOAD_API, {
      method: "POST",
      body: fd,  // FormData 自动设 Content-Type（含 boundary），不手动设头
    });
    let j = {};
    try { j = await res.json(); } catch (_) {}
    if (j.ok) {
      toast(`上传成功 · ${j.channel_count} 渠道 / ${j.fba_count} FBA，公网约 1 分钟生效`);
      setTimeout(loadVersionInfo, 1000);
    } else {
      toast("上传失败：" + (j.message || ("HTTP " + res.status)), true);
    }
  } catch (e) {
    toast("网络错误：" + e, true);
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
