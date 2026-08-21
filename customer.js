/* 前晋四 · 客户自助查价 前端逻辑（纯前端版，无后端依赖）
   价表从同目录 prices.json / schemes.json 加载，报价与识别均由 quote-engine.js 在浏览器本地完成。 */
const FLAG = { US: "🇺🇸", UK: "🇬🇧", EU: "🇪🇺", CA: "🇨🇦" };
let COUNTRY = null;
let QUOTE_MODE = "lcl";
const $ = (s) => document.querySelector(s);
const toast = (m, e = false) => { const t = $("#toast"); t.textContent = m; t.className = "toast show" + (e ? " err" : ""); setTimeout(() => (t.className = "toast"), 2600); };

async function init() {
  try {
    const t = Date.now();
    const [p, s] = await Promise.all([
      fetch('prices.json?t=' + t).then((r) => r.json()),
      fetch('schemes.json?t=' + t).then((r) => r.json()),
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
    el.onclick = () => { COUNTRY = co.code; document.querySelectorAll('#countryChips .chip').forEach((x) => x.classList.remove('active')); el.classList.add('active'); loadChannels(); if (QUOTE_MODE === "fcl") loadFclMeta(COUNTRY); };
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

async function loadFclMeta(country) {
  if (!country) return;
  const m = Engine.getFclMeta(country);
  if (!m.ok) { toast(m.message || "整柜配置加载失败", true); return; }
  const fcl = m.fcl || {};
  const fill = (id, arr, ph) => {
    const sel = $("#" + id); if (!sel) return;
    if (!arr || !arr.length) { sel.innerHTML = `<option value="">${ph}</option>`; return; }
    sel.innerHTML = `<option value="">请选择</option>` + arr.map((x) => `<option value="${x}">${x}</option>`).join("");
  };
  fill("fclContainer", fcl.container_types, "该国家暂未配置柜型");
  fill("fclOrigin", fcl.origin_ports, "请选择起运港");
  fill("fclDest", fcl.dest_ports, "请选择目的港");
}

async function quote() {
  if (QUOTE_MODE === "fcl") return quoteFcl();
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

function collectAttrs() {
  const cert = [];
  if ($("#at_magnetic") && $("#at_magnetic").checked) cert.push("带磁");
  if ($("#at_powered") && $("#at_powered").checked) cert.push("带电");
  return {
    paste: $("#at_paste") && $("#at_paste").checked,
    liquid: $("#at_liquid") && $("#at_liquid").checked,
    high_value: $("#at_high_value") && $("#at_high_value").checked,
    high_tax: $("#at_high_tax") && $("#at_high_tax").checked,
    high_check: $("#at_high_check") && $("#at_high_check").checked,
    ciq: $("#at_ciq") && $("#at_ciq").checked,
    declared_names: parseInt($("#at_names") && $("#at_names").value) || 1,
    value: parseFloat($("#at_value") && $("#at_value").value) || 0,
    address_type: $("#at_addr") ? $("#at_addr").value || null : null,
    cert,
  };
}

async function quoteFcl() {
  const btn = $("#quoteBtnFcl");
  if (!COUNTRY) { toast("请先选择目的国家", true); return; }
  const payload = {
    quote_mode: "fcl",
    country: COUNTRY,
    container_type: $("#fclContainer").value || null,
    service_mode: $("#fclMode").value || "door",
    origin_port: $("#fclOrigin").value || null,
    dest_port: $("#fclDest").value || null,
    ocean_rate: $("#fclOcean").value || null,
    cargo_weight_ton: parseFloat($("#fclWeight").value) || 0,
    pva: $("#fclPva").checked,
    domestic_truck_fee: $("#fclTruck").value || null,
    tax_fee: $("#fclTax").value || null,
    odd_port: $("#fclOdd").checked,
    pss: $("#fclPss").checked,
    appointment: $("#fclAppt").checked,
    overtime: $("#fclOvertime").checked,
    over_dim: $("#fclOverDim").checked,
    attrs: collectAttrs(),
  };
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> 整柜报价中…`;
  try {
    const q = Engine.computeFclQuote(payload);
    render(q);
  } catch (e) { toast("整柜报价计算失败：" + e, true); }
  finally { btn.disabled = false; btn.innerHTML = `<span>⚡ 整柜报价 (FCL)</span>`; }
}

function renderFclQuote(q) {
  $("#quoteEmpty").style.display = "none";
  const body = $("#quoteBody"); body.style.display = "block";
  if (!q.ok && q.single_quote) {
    body.innerHTML = `<div class="quote-head"><div class="quote-route">${q.container_type || "整柜"}<small>${q.country_name || ""}·${q.dest_port || ""}</small></div><span class="badge accent">单询</span></div>
      <div class="callout warn"><span class="ic">💬</span><div>${q.message}</div></div>`;
    return;
  }
  if (!q.ok) { body.innerHTML = `<div class="callout warn"><span class="ic">⚠️</span><div>${q.message || "暂无法报价"}</div></div>`; return; }
  const modeName = { door: "整柜到门 (DDP)", warehouse: "整柜到仓 (DDP)", cy: "到港(CY-CY)", ddp: "DDP到仓" }[q.service_mode] || q.service_mode;
  const items = q.line_items.map((li) => `<li><span class="nm">${li.name}<small>${li.detail || ""}</small></span><span class="val">¥${li.amount.toFixed(2)}</span></li>`).join("");
  const flags = (q.flags || []).length ? `<ul class="flag-list">${q.flags.map((f) => `<li>⚠️ ${f}</li>`).join("")}</ul>` : "";
  body.innerHTML = `
    <div class="quote-head"><div class="quote-route">${q.container_type} · ${modeName}<small>${q.country_name} · ${q.origin_port || ""} → ${q.dest_port || ""}</small></div><span class="badge brand">整柜 FCL</span></div>
    <div class="total-box"><div class="lab">参考总价 (RMB)</div><div class="amt"><small>¥</small>${q.total.toFixed(2)}</div></div>
    <ul class="breakdown">${items}<li><span class="nm" style="font-weight:800;color:var(--ink)">合计</span><span class="val" style="font-size:16px;color:var(--brand-600)">¥${q.total.toFixed(2)}</span></li></ul>
    <div class="callout"><span class="ic">🚢</span><div><b>柜型：</b>${q.container_type}　<b>服务模式：</b>${modeName}　<b>货重：</b>${(q.cargo_weight_ton || 0)} 吨</div></div>
    ${flags}`;
}

function render(q) {
  if (q.mode === "fcl") { renderFclQuote(q); return; }
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
  if (r.is_fcl) {
    QUOTE_MODE = "fcl";
    document.querySelectorAll("#transportChips .chip").forEach((x) => x.classList.toggle("active", x.dataset.mode === "fcl"));
    $("#lclFields").style.display = "none";
    $("#fclFields").style.display = "";
    await loadFclMeta(r.country);
    if (r.container_type) {
      const sel = $("#fclContainer");
      if ([...sel.options].some((o) => o.value === r.container_type)) sel.value = r.container_type;
    }
    // 整柜到港(CY-CY)已不做，识别到 CY 关键词默认落到「整柜到门(DDP)」
    $("#fclMode").value = "door";
    showIntakeResult(r);
    toast("已识别为整柜业务，已切换到整柜(FCL)表单，请补全柜型/目的港后报价");
    return;
  }
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
$("#quoteBtnFcl").onclick = quoteFcl;
// 渠道切换时自动重算报价
$("#channel").addEventListener("change", () => {
  const hasQuote = $("#quoteBody") && $("#quoteBody").style.display === "block";
  const hasParams = COUNTRY && (parseFloat($("#weight").value) > 0 || $("#dest").value.trim());
  if (hasQuote || hasParams) quote();
});
// 运输类型切换（散货/整柜）
document.querySelectorAll("#transportChips .chip").forEach((chip) => {
  chip.onclick = () => {
    QUOTE_MODE = chip.dataset.mode;
    document.querySelectorAll("#transportChips .chip").forEach((x) => x.classList.toggle("active", x === chip));
    const isFcl = QUOTE_MODE === "fcl";
    $("#lclFields").style.display = isFcl ? "none" : "";
    $("#fclFields").style.display = isFcl ? "" : "none";
    $("#quoteBody").style.display = "none";
    $("#quoteEmpty").style.display = "block";
    if (isFcl && COUNTRY) loadFclMeta(COUNTRY);
  };
});
// 整柜到门模式隐藏「亚马逊约仓」勾选（仅到仓适用）
$("#fclMode").addEventListener("change", () => {
  const isWh = $("#fclMode").value === "warehouse";
  const appt = $("#fclAppt");
  if (appt) appt.closest(".attr-chk").style.display = isWh ? "" : "none";
});
// 目的仓/邮编输入后实时按可达性重分类渠道（防抖）
$("#dest").addEventListener("input", debounce(() => { if (COUNTRY && QUOTE_MODE === "lcl") loadChannels(); }, 400));
["weight", "pieces", "len", "wid", "hei", "dest"].forEach((id) => $("#" + id).addEventListener("keydown", (e) => { if (e.key === "Enter" && QUOTE_MODE === "lcl") quote(); }));

// 设置版本号（若页面有 #verPill 则填充）
function setVerPill() {
  const el = $('#verPill');
  if (el && window.Engine && Engine.getVersion) {
    el.textContent = '价表 v' + Engine.getVersion();
  }
}

/* 页面加载 */
window.addEventListener('DOMContentLoaded', () => { init(); setVerPill(); });
