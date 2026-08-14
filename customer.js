/* 前晋四 · 客户自助查价 前端逻辑（纯前端版，无后端依赖）
   价表从同目录 prices.json / schemes.json 加载，报价与识别均由 quote-engine.js 在浏览器本地完成。 */
const FLAG = { US: "🇺🇸", UK: "🇬🇧", EU: "🇪🇺", CA: "🇨🇦" };
let COUNTRY = null;
const $ = (s) => document.querySelector(s);
const toast = (m, e = false) => { const t = $("#toast"); t.textContent = m; t.className = "toast show" + (e ? " err" : ""); setTimeout(() => (t.className = "toast"), 2600); };

async function init() {
  try {
    const [p, s] = await Promise.all([
      fetch('prices.json').then((r) => r.json()),
      fetch('schemes.json').then((r) => r.json()),
    ]);
    Engine.load(p, s);
  } catch (e) {
    toast('价表加载失败：' + e, true);
    return;
  }
  renderCountries();
  loadNotice();
}

function renderCountries() {
  const box = $('#countryChips'); box.innerHTML = '';
  Engine.getCountries().forEach((co) => {
    const el = document.createElement('div');
    el.className = 'chip';
    el.dataset.code = co.code;
    el.innerHTML = `<span class="flag">${FLAG[co.code] || "🌐"}</span>${co.name}`;
    el.onclick = () => { COUNTRY = co.code; document.querySelectorAll('#countryChips .chip').forEach((x) => x.classList.remove('active')); el.classList.add('active'); loadChannels(); };
    box.appendChild(el);
  });
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function loadChannels(classify = true) {
  const sel = $('#channel');
  const prev = sel.value;
  sel.innerHTML = `<option value="">加载中…</option>`;
  const dest = classify ? ($('#dest').value.trim()) : '';
  const chs = Engine.getChannels(COUNTRY, dest);
  const optHtml = (c) => {
    const dis = c.reachable === false ? ' disabled' : '';
    const tag = c.reachable === false ? '　⛔不可达' : '';
    return `<option value="${c.code}" data-scheme="${c.scheme || "tier"}"${dis}>${c.name}（${c.transport || ""}）${tag}</option>`;
  };
  let html = `<option value="">不选则自动匹配</option>`;
  if (dest) {
    const reach = chs.filter((c) => c.reachable !== false);
    const unreach = chs.filter((c) => c.reachable === false);
    if (reach.length) html += `<optgroup label="✅ 可送达此邮编 (${reach.length})">` + reach.map(optHtml).join("") + `</optgroup>`;
    if (unreach.length) html += `<optgroup label="⛔ 不可送达此邮编 (${unreach.length})">` + unreach.map(optHtml).join("") + `</optgroup>`;
    const hint = $('#channelHint'); if (hint) hint.textContent = `📍 已按邮编筛选：${reach.length} 条可送达 / ${unreach.length} 条不可达`;
  } else {
    html += chs.map(optHtml).join("");
    const hint = $('#channelHint'); if (hint) hint.textContent = `共 ${chs.length} 条渠道可选 · 留空自动匹配`;
  }
  sel.innerHTML = html;
  const stillThere = [...sel.options].some((o) => o.value === prev && !o.disabled);
  if (prev && stillThere) sel.value = prev;
  else { const fr = [...sel.options].find((o) => o.value && !o.disabled); if (fr && fr.value !== prev) { sel.value = fr.value; if ($('#quoteBody').style.display === 'block') quote(); } }
}

async function quote() {
  const btn = $('#quoteBtn');
  const sel = $('#channel');
  const scheme = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].dataset.scheme : "tier";
  const p = {
    country: COUNTRY, channel_code: sel.value || null, dest: $('#dest').value.trim() || null,
    actual_weight: parseFloat($('#weight').value) || 0, pieces: parseInt($('#pieces').value) || 1,
    length: parseFloat($('#len').value) || 0, width: parseFloat($('#wid').value) || 0, height: parseFloat($('#hei').value) || 0,
  };
  if (scheme === "formula" && window._intakeItems && window._intakeItems.length) {
    p.items = window._intakeItems;
  }
  if (!p.country && !p.dest) { toast("请选择国家，或填写目的仓 / FBA 仓码", true); return; }
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> 查询中…`;
  try {
    const q = Engine.computeQuote(p);
    render(q);
  } catch (e) { toast("报价计算失败：" + e, true); }
  finally { btn.disabled = false; btn.innerHTML = `<span>🔍 获取报价</span>`; }
}

function render(q) {
  $("#quoteEmpty").style.display = "none";
  const body = $("#quoteBody"); body.style.display = "block";
  if (!q.ok && q.single_quote) {
    body.innerHTML = `<div class="quote-head"><div class="quote-route">${q.channel ? q.channel.name : "该渠道"}<small>${q.country_name || ""}</small></div><span class="badge accent">单询</span></div>
      <div class="callout warn"><span class="ic">💬</span><div>${q.message}</div></div>`;
    return;
  }
  if (!q.ok) { body.innerHTML = `<div class="callout warn"><span class="ic">⚠️</span><div>${q.message || "暂无法报价"}</div></div>`; return; }
  const w = q.weight;
  const items = q.line_items.map((li) => `<li><span class="nm">${li.name}<small>${li.detail || ""}</small></span><span class="val">¥${li.amount.toFixed(2)}</span></li>`).join("");
  const flags = (q.flags || []).length ? `<ul class="flag-list">${q.flags.map((f) => `<li>⚠️ ${f}</li>`).join("")}</ul>` : "";
  const note = q.match_note ? `<div class="callout"><span class="ic">ℹ️</span><div>${q.match_note}</div></div>` : "";
  const lead = (q.lead && (q.lead.pickup || q.lead.sign)) ? `<div class="callout"><span class="ic">🚚</span><div><b>参考时效：</b>预提取 ${q.lead.pickup || "—"} ｜ 预签收 ${q.lead.sign || "—"}</div></div>` : "";
  body.innerHTML = `
    <div class="quote-head"><div class="quote-route">${q.channel.name}<small>${q.country_name} · ${q.matched_zone || ""} · ${q.channel.transport || ""}</small></div><span class="badge brand">${q.channel.transport_class}</span></div>
    ${note}
    <div class="total-box"><div><div class="lab">参考总价 (RMB)</div></div><div class="amt"><small>¥</small>${q.total.toFixed(2)}</div></div>
    <ul class="breakdown">${items}<li><span class="nm" style="font-weight:800;color:var(--ink)">合计</span><span class="val" style="font-size:16px;color:var(--brand-600)">¥${q.total.toFixed(2)}</span></li></ul>
    <div class="callout"><span class="ic">⚖️</span><div><b>计费重：</b>${w.billable} kg（实重 ${w.actual_total} / 材积重 ${w.volumetric_total}，取大）｜ <b>单价：</b>¥${(q.channel.scheme === "formula" ? w.rate_per_kg : w.unit_price)}/kg</div></div>
    ${lead}${flags}`;
}

async function loadNotice() {
  const sn = Engine.getNotice();
  const acc = $("#noticeAcc");
  const eff = sn.export_customs_fee || {}, ovs = sn.oversize_fee || {}, ovw = sn.overweight_fee || {};
  const rows = [["美国", "US"], ["英国", "UK"], ["欧洲", "EU"], ["加拿大", "CA"]].map(([cn, ck]) =>
    `<tr><td>${cn}</td><td>${eff.快递 ? "¥" + eff.快递.US : "—"}</td><td>¥${(ovs[ck] || "—")}</td><td>¥${(ovw[ck] || "—")}</td></tr>`).join("");
  const items = [
    ["🧮", "计费规则", `<p>计价单位：<b>${sn.currency || "RMB"}</b>。材积重 = 长×宽×高(cm) ÷ 5000(快递)或 ÷6000(专线/海运)，与实重取大计费。</p>`],
    ["💰", "常见附加费", `<table><thead><tr><th>国家</th><th>出口报关费</th><th>超长费/箱</th><th>超重费/箱</th></tr></thead><tbody>${rows}</tbody></table><p class="muted">超长：单件围长&gt;265cm；超重：单件&gt;30kg。</p>`],
  ];
  (sn.long_text || []).forEach((t) => items.push(["📜", t.title + (t.sub ? `（${t.sub}）` : ""), `<p>${t.text || ""}</p>`]));
  acc.innerHTML = items.map(([ic, title, body], i) => `
    <div class="acc-item ${i === 0 ? "open" : ""}"><button class="acc-head" onclick="toggleAcc(this)"><span class="ic">${ic}</span>${title}<span class="chev">▾</span></button><div class="acc-body">${body}</div></div>`).join("");
}
function toggleAcc(b) { b.parentElement.classList.toggle("open"); }

/* ---------- 智能识别（粘贴填单） ---------- */
function showIntakeResult(r) {
  const det = [];
  if (r.country_name) det.push(["目的国", r.country_name + (r.state ? " " + r.state : "")]);
  if (r.zip) det.push(["邮编", r.zip]);
  if (r.terms && r.terms.length) det.push(["条款", r.terms.join("/")]);
  if (r.weight_kg != null) det.push(["重量", r.weight_kg + " kg"]);
  if (r.pieces) det.push(["件数", r.pieces + " 件"]);
  if (r.dims_cm) det.push(["尺寸(cm)", `${r.dims_cm.length}×${r.dims_cm.width}×${r.dims_cm.height}`]);
  if (r.packaging) det.push(["包装", r.packaging]);
  if (r.electromagnetic === true) det.push(["电磁", "带电/带磁 ⚠"]);
  else if (r.electromagnetic === false) det.push(["电磁", "不带电磁"]);
  const detHtml = det.map(([k, v]) => `<span class="det-chip"><b>${k}</b>${v}</span>`).join("");
  const flagsHtml = (r.flags && r.flags.length)
    ? `<ul class="flag-list">${r.flags.map((f) => `<li>⚠️ ${f}</li>`).join("")}</ul>` : "";
  const rec = r.recommended_mode
    ? `<div class="callout ok"><span class="ic">🚢</span><div><b>推荐：</b>${r.recommended_mode}</div></div>` : "";
  const sug = r.suggested_channel_name
    ? `<div class="callout"><span class="ic">ℹ️</span><div>已预选渠道：<b>${r.suggested_channel_name}</b>（可在左侧调整）</div></div>`
    : `<div class="callout warn"><span class="ic">⚠️</span><div>未识别到国家，请手动选择目的国与渠道。</div></div>`;
  $("#intakeResult").innerHTML = `<div class="det-grid">${detHtml}</div>${rec}${sug}${flagsHtml}`;
}

async function applyIntake(r) {
  const chip = [...document.querySelectorAll("#countryChips .chip")].find((c) => c.dataset.code === r.country);
  if (chip) {
    COUNTRY = r.country;
    document.querySelectorAll("#countryChips .chip").forEach((x) => x.classList.remove("active"));
    chip.classList.add("active");
  } else if (r.country) {
    COUNTRY = r.country;
  }
  $("#dest").value = r.zip || "";
  $("#weight").value = r.weight_kg != null ? r.weight_kg : "";
  $("#pieces").value = r.pieces || 1;
  if (r.dims_cm) {
    $("#len").value = Math.round(r.dims_cm.length);
    $("#wid").value = Math.round(r.dims_cm.width);
    $("#hei").value = Math.round(r.dims_cm.height);
  }
  window._intakeItems = r.items || [];
  if (r.country) {
    await loadChannels();
    if (r.suggested_channel_code) $("#channel").value = r.suggested_channel_code;
  }
  showIntakeResult(r);
  toast("已自动填单，正在获取报价…");
  quote();
}

$("#intakeBtn").onclick = async () => {
  const text = $("#intakeText").value.trim();
  if (!text) return toast("请先粘贴需求描述", true);
  const btn = $("#intakeBtn");
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> 识别中…`;
  try {
    const r = Engine.parseIntake(text);
    await applyIntake(r);
  } catch (e) { toast("识别异常：" + e, true); }
  btn.disabled = false; btn.innerHTML = `<span>⚡ 自动识别并报价</span>`;
};
$("#intakeClear").onclick = () => { $("#intakeText").value = ""; $("#intakeResult").innerHTML = ""; };

$("#quoteBtn").onclick = quote;
// 渠道切换时自动重算报价
$("#channel").addEventListener("change", () => {
  const hasQuote = $("#quoteBody") && $("#quoteBody").style.display === "block";
  const hasParams = COUNTRY && (parseFloat($("#weight").value) > 0 || $("#dest").value.trim());
  if (hasQuote || hasParams) quote();
});
// 目的仓/邮编输入后实时按可达性重分类渠道（防抖）
$("#dest").addEventListener("input", debounce(() => { if (COUNTRY) loadChannels(); }, 400));
["weight", "pieces", "len", "wid", "hei", "dest"].forEach((id) => $("#" + id).addEventListener("keydown", (e) => { if (e.key === "Enter") quote(); }));

// 设置版本号（若页面有 #verPill 则填充）
function setVerPill() {
  const el = $('#verPill');
  if (el && window.Engine && Engine.getVersion) {
    el.textContent = '价表 v' + Engine.getVersion();
  }
}

/* 页面加载 */
window.addEventListener('DOMContentLoaded', () => { init(); setVerPill(); });
