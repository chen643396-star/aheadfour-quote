/* 前晋四 · 价表管理（纯前端只读镜像）
   公网站无后端，不能实际上传/回滚；此处仅做：
   1) 密码门（与内网管理密码一致 aheadfour888）
   2) 解锁后展示当前价表只读信息（来自本地 Engine）
   3) 引导前往内网后台进行实际上传 */
const $ = (s) => document.querySelector(s);
const NAV_PW = 'aheadfour888'; // 与内网管理密码一致
const toast = (m, e = false) => { const t = $("#toast"); if (!t) return; t.textContent = m; t.className = "toast show" + (e ? " err" : ""); setTimeout(() => (t.className = "toast"), 2800); };

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
    toast("验证成功（公网站为只读镜像）");
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
    $("#curFile").textContent = "公网站只读镜像 · 与内网同步";
    $("#curTime").textContent = "更新时间详见内网后台";
    $("#curStats").innerHTML =
      `<span class="badge brand">渠道 ${v.channel_count}</span>
       <span class="badge accent">FBA ${v.fba_count}</span>
       <span class="badge muted">版本 ${v.version}</span>`;
  }
}

window.addEventListener('DOMContentLoaded', boot);
