/* 前晋四 · 内部报价工作台 前端逻辑（纯前端版：直接调用本地 Engine，不依赖后端 API） */
const FLAG = { US: "🇺🇸", UK: "🇬🇧", EU: "🇪🇺", CA: "🇨🇦" };
let COUNTRY = null;

const $ = (s) => document.querySelector(s);
let _lastClassifyDest = null;  // 记录上次分类用的邮编，用于判断邮编是否变化
const toast = (msg, err = false) => {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
  setTimeout(() => (t.className = "toast"), 2600);
};

/* ---------- 初始化 ---------- */
async function init() {
  // 纯前端：先从本地 JSON 载入价表到 Engine（内网版由后端注入，这里需自行加载）
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

  // 版本与统计（镜像 /api/version）
  const v = Engine.getVersionStats();
  if (v.ok) {
    $("#verPill").textContent = "价表 v" + v.version;
    $("#stCh").textContent = v.channel_count;
    $("#stCo").textContent = "4";
    $("#stFba").textContent = v.fba_count;
    $("#stVer").textContent = "v" + v.version;
  }
  // 国家（镜像 /api/countries）
  const c = { ok: true, countries: Engine.getCountries() };
  if (c.ok) {
    const box = $("#countryChips");
    box.innerHTML = "";
    c.countries.forEach((co) => {
      const el = document.createElement("div");
      el.className = "chip";
      el.dataset.code = co.code;
      el.innerHTML = `<span class="flag">${FLAG[co.code] || "🌐"}</span>${co.name}`;
      el.onclick = () => selectCountry(co.code, el);
      box.appendChild(el);
    });
  }
  loadNotice();
}

function selectCountry(code, el) {
  COUNTRY = code;
  document.querySelectorAll("#countryChips .chip").forEach((x) => x.classList.remove("active"));
  el.classList.add("active");
  loadChannels(code);
}

async function loadChannels(country, classify = true) {
  const sel = $("#channel");
  const prev = sel.value;
  sel.innerHTML = `<option value="">加载中…</option>`;
  const dest = classify ? ($("#dest").value.trim()) : "";
  // 镜像 /api/channels?country=&dest=
  const r = { ok: true, channels: Engine.getChannels(country, dest) };
  if (!r.ok) { sel.innerHTML = `<option value="">${r.message}</option>`; return; }
  const chs = r.channels;
  const optHtml = (c) => {
    const dis = c.reachable === false ? " disabled" : "";
    const tag = c.reachable === false ? "　⛔不可达" : "";
    const title = c.reach_reason ? ` title="${c.reach_reason}"` : "";
    return `<option value="${c.code}" data-scheme="${c.scheme || "tier"}"${dis}${title}>${c.name}　·　${c.transport || ""}${tag}</option>`;
  };
  let html = `<option value="">不选则自动匹配</option>`;
  if (dest) {
    const reach = chs.filter((c) => c.reachable !== false);
    const unreach = chs.filter((c) => c.reachable === false);
    if (reach.length) html += `<optgroup label="✅ 可送达此邮编 (${reach.length})">` + reach.map(optHtml).join("") + `</optgroup>`;
    if (unreach.length) html += `<optgroup label="⛔ 不可送达此邮编 (${unreach.length})">` + unreach.map(optHtml).join("") + `</optgroup>`;
    let hint = `📍 已按邮编筛选：${reach.length} 条可送达 / ${unreach.length} 条不可达`;
    if (unreach.length) hint += `（灰显项悬停可看不可达原因；海卡/FBA 类需填对应仓码方可匹配）`;
    else hint += `（全部可送达）`;
    $("#channelHint").textContent = hint;
  } else {
    html += chs.map(optHtml).join("");
    $("#channelHint").textContent = `共 ${chs.length} 条渠道可选 · 留空自动匹配 · 填 FBA 仓码也可直接匹配`;
  }
  sel.innerHTML = html;
  // 选择保持：优先保留用户已选（若仍可达）；已选但不可达则切到首个可达；未选则保持空白由用户选择
  const stillThere = [...sel.options].some((o) => o.value === prev && !o.disabled);
  if (prev && stillThere) {
    sel.value = prev;
  } else if (prev) {
    const firstReach = [...sel.options].find((o) => o.value && !o.disabled);
    if (firstReach) sel.value = firstReach.value;
  }
  // 邮编变化且该渠道已出过报价时，自动刷新报价（让结果与新邮编一致）；不自动抢改用户已选渠道
  const destChanged = dest && dest !== _lastClassifyDest;
  _lastClassifyDest = dest;
  if (destChanged && sel.value && $("#quoteBody").style.display === "block") {
    quote();
  }
}

/* ---------- 工具 ---------- */
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ---------- 报价 ---------- */
/* 收集「货物属性·触发式计费」面板的勾选与填写，供报价引擎计收附加费 */
function collectAttrs() {
  const v = (id) => document.getElementById(id);
  return {
    paste: v("at_paste").checked,
    liquid: v("at_liquid").checked,
    high_value: v("at_high_value").checked,
    high_tax: v("at_high_tax").checked,
    high_check: v("at_high_check").checked,
    magnetic: v("at_magnetic").checked,
    powered: v("at_powered").checked,
    ciq: v("at_ciq").checked,
    declared_names: parseInt(v("at_names").value) || null,
    value: parseFloat(v("at_value").value) || null,
    address_type: v("at_addr").value || null,
    box_mark_known: false,
  };
}

async function quote() {
  const btn = $("#quoteBtn");
  const sel = $("#channel");
  const scheme = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].dataset.scheme : "tier";
  const payload = {
    country: COUNTRY,
    channel_code: sel.value || null,
    dest: $("#dest").value.trim() || null,
    actual_weight: parseFloat($("#weight").value) || 0,
    pieces: parseInt($("#pieces").value) || 1,
    length: parseFloat($("#len").value) || 0,
    width: parseFloat($("#wid").value) || 0,
    height: parseFloat($("#hei").value) || 0,
  };
  // 公式方案（海卡/代理）：携带逐件 items 以精确算材积重
  if (scheme === "formula" && window._intakeItems && window._intakeItems.length) {
    payload.items = window._intakeItems;
  }
  // 触发式附加费所需货物属性（勾选/填写后由引擎自动计收或单询）
  payload.attrs = collectAttrs();
  if (!payload.country && !payload.dest) { toast("请选择国家，或填写目的仓 / FBA 仓码", true); return; }
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> 计算中…`;
  try {
    // 镜像 /api/quote
    const q = Engine.computeQuote(payload);
    renderQuote(q);
  } catch (e) { toast("报价计算失败：" + e, true); }
  finally { btn.disabled = false; btn.innerHTML = `<span>⚡ 立即报价</span>`; }
}

function renderQuote(q) {
  $("#quoteEmpty").style.display = "none";
  const body = $("#quoteBody"); body.style.display = "block";
  if (!q.ok && q.single_quote) {
    body.innerHTML = `
      <div class="quote-head"><div class="quote-route">${q.channel ? q.channel.name : "单询渠道"}
        <small>${q.country_name || ""} · 分区 ${q.matched_zone || "—"}</small></div>
        <span class="badge accent">单询</span></div>
      <div class="callout warn"><span class="ic">💬</span><div>${q.message}</div></div>
      ${q.remark ? `<div class="callout"><span class="ic">📝</span><div><b>备注：</b>${q.remark}</div></div>` : ""}`;
    return;
  }
  if (!q.ok) {
    body.innerHTML = `<div class="callout warn"><span class="ic">⚠️</span><div>${q.message || "无法报价"}</div></div>`;
    return;
  }
  const w = q.weight;
  const cls = { "快递": "brand", "海运": "brand", "空运": "brand" }[q.channel.transport_class] || "muted";
  const items = q.line_items.map((li) =>
    `<li><span class="nm">${li.name}<small>${li.detail || ""}</small></span><span class="val">¥${li.amount.toFixed(2)}</span></li>`
  ).join("");
  const flags = (q.flags || []).length
    ? `<ul class="flag-list">${q.flags.map((f) => `<li>⚠️ ${f}</li>`).join("")}</ul>` : "";
  const note = q.match_note ? `<div class="callout"><span class="ic">ℹ️</span><div>${q.match_note}</div></div>` : "";
  const remark = q.remark ? `<div class="callout"><span class="ic">📝</span><div><b>渠道备注：</b>${q.remark}</div></div>` : "";
  const penalty = q.comp_penalty ? `<div class="callout ok"><span class="ic">⏱️</span><div><b>时效 / 赔偿：</b>${q.comp_penalty}</div></div>` : "";
  const lead = (q.lead && (q.lead.pickup || q.lead.sign))
    ? `<div class="callout"><span class="ic">🚚</span><div><b>预提取：</b>${q.lead.pickup || "—"}　｜　<b>预签收：</b>${q.lead.sign || "—"}</div></div>` : "";

  const weightDetail = q.channel.scheme === "formula"
    ? `<b>计费重：</b>${w.billable} kg（实重 ${w.actual_total} / 材积重 ${w.volumetric_total}，取大）　·　<b>单价：</b>¥${w.rate_per_kg}/kg（海卡公式价，÷${w.vol_divisor}）`
    : `<b>计费重：</b>${w.billable} kg（实重 ${w.actual_total} / 材积重 ${w.volumetric_total}，取大）　·　<b>单价：</b>¥${w.unit_price}/kg（${w.tier_used}Kg+ 档，÷${w.vol_divisor}）`;

  body.innerHTML = `
    <div class="quote-head">
      <div class="quote-route">${q.channel.name}<small>${q.country_name} · 分区 ${q.matched_zone || "—"} · ${q.channel.transport || ""}</small></div>
      <span class="badge ${cls}">${q.channel.transport_class}</span>
    </div>
    ${note}
    <div class="total-box">
      <div><div class="lab">预估总价 (RMB)</div></div>
      <div class="amt"><small>¥</small>${q.total.toFixed(2)}</div>
    </div>
    <ul class="breakdown">
      ${items}
      <li><span class="nm" style="font-weight:800;color:var(--ink)">合计</span><span class="val" style="font-size:16px;color:var(--brand-600)">¥${q.total.toFixed(2)}</span></li>
    </ul>
    <div class="callout"><span class="ic">⚖️</span><div>${weightDetail}</div></div>
    ${lead}${remark}${penalty}${flags}
    <button class="btn btn-ghost btn-block mt" onclick="copyQuote()">📋 复制报价摘要</button>`;
  window._lastQuote = q;
}

function copyQuote() {
  const q = window._lastQuote; if (!q || !q.ok) return;
  const w = q.weight;
  const lines = [
    `【前晋四 AHEADFOUR 报价】`,
    `渠道：${q.channel.name}（${q.country_name} · ${q.matched_zone || ""}）`,
    `计费重：${w.billable}kg × ¥${(q.channel.scheme === "formula" ? w.rate_per_kg : w.unit_price)}/kg`,
    q.line_items.map((li) => `  - ${li.name}：¥${li.amount.toFixed(2)}`).join("\n"),
    `合计：¥${q.total.toFixed(2)}`,
    q.remark ? `备注：${q.remark}` : "",
  ].filter(Boolean).join("\n");
  navigator.clipboard.writeText(lines).then(() => toast("报价摘要已复制"), () => toast("复制失败", true));
}

/* ---------- 发货须知 / 船期 / 仓库 ---------- */
async function loadNotice() {
  // 镜像 /api/notice（返回 {ok, company, notice, vessel}）
  const n = Engine.getNoticeData();
  if (!n.ok) return;
  const sn = n.notice || {};
  const acc = $("#noticeAcc");
  const items = [];

  // 计费单位 & 材积重
  items.push(["🧮", "计费规则", `
    <p>计价单位：<b>${sn.currency || "RMB（元）"}</b>；重量以 kg 计。</p>
    <p>材积重公式：<b>长×宽×高(cm) ÷ ${sn.girth_formula ? "见下" : "5000/6000"}</b>；快递 ÷5000，专线/海运 ÷6000，与实重取大计费。</p>
    ${sn.girth_formula ? `<p>围长公式：<b>${sn.girth_formula}</b></p>` : ""}`]);

  // 附加费表
  const eff = sn.export_customs_fee || {};
  const ovs = sn.oversize_fee || {};
  const ovw = sn.overweight_fee || {};
  const rows = [["美国", "US"], ["英国", "UK"], ["欧洲", "EU"], ["加拿大", "CA"]].map(([cn, ck]) => `
    <tr><td>${cn}</td>
      <td>${eff.快递 ? "¥" + eff.快递.US : "—"}</td>
      <td>${eff.海运 ? "¥" + (eff.海运[ck] || "—") : "—"}</td>
      <td>¥${(ovs[ck] || "—")}</td>
      <td>¥${(ovw[ck] || "—")}</td></tr>`).join("");
  items.push(["💰", "附加费一览（报关 / 超长 / 超重）", `
    <table><thead><tr><th>国家</th><th>出口报关费</th><th>清关费另计</th><th>超长费/箱</th><th>超重费/箱</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="muted">超长：单件围长 &gt;265cm；超重：单件实重 &gt;30kg。灰色区间（围长 261–265 / 实重 22–30kg）需单询。</p>`]);

  // 免赔 / 赔偿 / 索赔（长文）
  (sn.long_text || []).forEach((t) => {
    items.push(["📜", t.title + (t.sub ? `（${t.sub}）` : ""), `<p>${t.text || ""}</p>${t.note ? `<p class="muted">${t.note}</p>` : ""}`]);
  });

  acc.innerHTML = items.map(([ic, title, body], i) => `
    <div class="acc-item ${i === 0 ? "open" : ""}">
      <button class="acc-head" onclick="toggleAcc(this)">
        <span class="ic">${ic}</span>${title}
        <span class="chev">▾</span>
      </button>
      <div class="acc-body">${body}</div>
    </div>`).join("");

  // 船期
  const vt = $("#vesselTbl tbody");
  vt.innerHTML = (n.vessel || []).map((v) => `
    <tr><td>${v.carrier || ""}</td><td>${v.vessel || ""}</td><td>${v.port || ""}</td>
      <td class="mono">${v.etd || ""}</td><td class="mono">${v.eta || ""}</td><td class="mono">${v.cutoff || ""}</td></tr>`).join("");

  // 仓库（兼容字符串和对象两种格式）
  const wh = (n.company && n.company.warehouses) || [];
  $("#warehouses").innerHTML = wh.map((w) => {
    if (typeof w === "string") {
      const idx = w.indexOf("：");
      const name = idx > 0 ? w.slice(0, idx) : w;
      const addr = idx > 0 ? w.slice(idx + 1) : "";
      return `<div class="callout" style="margin-top:0;margin-bottom:10px"><span class="ic">🏭</span><div><b>${name}</b><br><span class="muted">${addr}</span></div></div>`;
    }
    return `<div class="callout" style="margin-top:0;margin-bottom:10px"><span class="ic">🏭</span><div><b>${w.name || ""}</b><br><span class="muted">${w.addr || ""}</span></div></div>`;
  }).join("");
}

function toggleAcc(btn) { btn.parentElement.classList.toggle("open"); }

/* ---------- 智能识别（粘贴填单） ---------- */
function showIntakeResult(r) {
  const det = [];
  if (r.product) det.push(["品名", r.product]);
  if (r.country_name) det.push(["目的国", r.country_name + (r.state ? " " + r.state : "")]);
  if (r.zip) det.push(["邮编", r.zip]);
  if (r.terms && r.terms.length) det.push(["条款", r.terms.join("/")]);
  if (r.weight_kg != null) det.push(["重量", r.weight_kg + " kg"]);
  if (r.pieces) det.push(["件数", r.pieces + " 件"]);
  if (r.dims_cm) det.push(["尺寸(cm)", `${r.dims_cm.length}×${r.dims_cm.width}×${r.dims_cm.height}`]);
  if (r.packaging) det.push(["包装", r.packaging]);
  if (r.electromagnetic === true) det.push(["电磁", "带电/带磁 ⚠"]);
  else if (r.electromagnetic === false) det.push(["电磁", "不带电磁"]);
  if (r.cert && r.cert.length) det.push(["认证", r.cert.join("/") + "（需单询附加费）"]);
  if (r.ciq) det.push(["商检", "需商检 ⚠"]);
  const detHtml = det.map(([k, v]) => `<span class="det-chip"><b>${k}</b>${v}</span>`).join("");
  const flagsHtml = (r.flags && r.flags.length)
    ? `<ul class="flag-list">${r.flags.map((f) => `<li>⚠️ ${f}</li>`).join("")}</ul>` : "";
  const rec = r.recommended_mode
    ? `<div class="callout ok"><span class="ic">🚢</span><div><b>推荐：</b>${r.recommended_mode}</div></div>` : "";
  const sug = r.suggested_channel_name
    ? `<div class="callout"><span class="ic">ℹ️</span><div>已预选渠道：<b>${r.suggested_channel_name}</b>（可在下方调整）</div></div>`
    : `<div class="callout warn"><span class="ic">⚠️</span><div>未识别到国家，请手动选择目的国与渠道。</div></div>`;
  $("#intakeResult").innerHTML =
    `<div class="det-grid">${detHtml}</div>${rec}${sug}${flagsHtml}`;
}

async function applyIntake(r) {
  // 选择国家
  const chip = [...document.querySelectorAll("#countryChips .chip")].find((c) => c.dataset.code === r.country);
  if (chip) {
    COUNTRY = r.country;
    document.querySelectorAll("#countryChips .chip").forEach((x) => x.classList.remove("active"));
    chip.classList.add("active");
  } else if (r.country) {
    COUNTRY = r.country;
  }
  // 填充参数
  $("#dest").value = r.zip || "";
  $("#weight").value = r.weight_kg != null ? r.weight_kg : "";
  $("#pieces").value = r.pieces || 1;
  if (r.dims_cm) {
    $("#len").value = Math.round(r.dims_cm.length);
    $("#wid").value = Math.round(r.dims_cm.width);
    $("#hei").value = Math.round(r.dims_cm.height);
  }
  window._intakeItems = r.items || [];
  // 将识别到的触发属性预填到「货物属性」面板
  const setChk = (id, on) => { const el = document.getElementById(id); if (el) el.checked = !!on; };
  setChk("at_paste", r.paste);
  setChk("at_liquid", r.liquid);
  setChk("at_high_value", r.high_value);
  setChk("at_high_tax", r.high_tax);
  setChk("at_high_check", r.high_check);
  setChk("at_magnetic", r.magnetic);
  setChk("at_powered", r.powered);
  setChk("at_ciq", r.ciq);
  if (r.declared_names) document.getElementById("at_names").value = r.declared_names;
  if (r.country) {
    await loadChannels(r.country);
    if (r.suggested_channel_code) {
      $("#channel").value = r.suggested_channel_code;
      $("#channelHint").textContent = "已按识别结果预选：" + (r.suggested_channel_name || "");
    }
  }
  showIntakeResult(r);
  toast("已自动识别并填充，请核对后报价");
}

$("#intakeBtn").onclick = async () => {
  const text = $("#intakeText").value.trim();
  if (!text) return toast("请先粘贴产品描述", true);
  const btn = $("#intakeBtn");
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> 识别中…`;
  try {
    // 镜像 /api/parse_intake
    const r = Engine.parseIntake(text);
    if (r && r.country) await applyIntake(r);
    else toast("识别失败：未找到国家或邮编", true);
  } catch (e) { toast("识别异常：" + e, true); }
  btn.disabled = false; btn.innerHTML = `<span>⚡ 自动识别并填充</span>`;
};
$("#intakeClear").onclick = () => { $("#intakeText").value = ""; $("#intakeResult").innerHTML = ""; };

/* 报价配置区一键清空 */
$("#quoteClear").onclick = () => {
  // 清空表单字段
  ["weight", "len", "wid", "hei", "dest", "cw"].forEach((id) => { const el = $("#" + id); if (el) el.value = ""; });
  const piecesEl = $("#pieces");
  if (piecesEl) piecesEl.value = "1";
  // 重置渠道
  const sel = $("#channel");
  if (sel) sel.selectedIndex = 0;
  // 清除国家选中
  COUNTRY = null;
  document.querySelectorAll("#countryChips .chip").forEach((x) => x.classList.remove("active"));
  // 清空报价结果
  const qb = $("#quoteBody");
  const qe = $("#quoteEmpty");
  const rc = $("#resultCard");
  if (qb) { qb.innerHTML = ""; qb.style.display = "none"; }
  if (qe) qe.style.display = "";
  if (rc) rc.classList.remove("has-quote");
  // 清除识别缓存
  window._intakeItems = [];
  toast("已清空全部");
};

/* ---------- 绑定 ---------- */
$("#quoteBtn").onclick = quote;
// 目的仓/邮编输入后实时按可达性重分类渠道（防抖）
$("#dest").addEventListener("input", debounce(() => { if (COUNTRY) loadChannels(COUNTRY); }, 400));
// 渠道切换时自动重算报价（已有报价结果或已填参数时）
$("#channel").addEventListener("change", () => {
  const hasQuote = $("#quoteBody") && $("#quoteBody").style.display === "block";
  const hasParams = COUNTRY && (parseFloat($("#weight").value) > 0 || $("#dest").value.trim());
  if (hasQuote || hasParams) quote();
});
["weight", "pieces", "len", "wid", "hei", "dest"].forEach((id) =>
  $("#" + id).addEventListener("keydown", (e) => { if (e.key === "Enter") quote(); }));

/* ---------- 页面加载 ---------- */
window.addEventListener('DOMContentLoaded', init);
