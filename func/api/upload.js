/**
 * 前晋四公网站 · 上传价表 Serverless 函数（Vercel Node.js · ESM + fetch 格式）
 *
 * 接收公网 admin 页 POST 的 xlsx 文件（FormData），
 * 用 SheetJS 解析为 prices 结构后，通过 GitHub Contents API 提交 prices.json 到仓库，
 * GitHub Pages 检测到推送即自动重建，公网站约 1 分钟生效。
 *
 * 环境变量：
 *   ADMIN_PW      管理密码
 *   GITHUB_TOKEN  fine-grained PAT（Contents 读写）
 *   GITHUB_REPO   价表仓库
 *   GITHUB_BRANCH 分支（默认 main）
 */
import XLSX from "xlsx";

// ── 国家 sheet 映射 ──────────────────────────────────────────────
const COUNTRY_SHEETS = { US: "美国", UK: "英国", EU: "欧洲", CA: "加拿大" };
const VOL_RE = /(\d+)\s*[Kk][Gg]\s*\+/;
const HEADER_NAME = "渠道名称";

// ── 工具函数 ─────────────────────────────────────────────────────
function normCode(s) {
  if (s == null) return null;
  return String(s).replace(/\s+/g, "").toUpperCase();
}

function toNum(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (["", "/", "*", "-", "—"].includes(s)) return null;
  const n = Number(s);
  if (!isNaN(n)) return n;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function cellStr(v) {
  if (v == null) return null;
  return String(v).trim();
}

function transportClass(transport) {
  if (!transport) return "专线";
  const t = String(transport);
  if (/UPS|快递/.test(t)) return "快递";
  if (/卡航|铁路/.test(t)) return "卡航铁路";
  if (/空运|空飞|直飞|转飞/.test(t)) return "空运";
  if (/海运|美森|船/.test(t)) return "海运";
  return "专线";
}

function inferClassFromName(name) {
  if (!name) return "专线";
  if (/快递|UPS/.test(name)) return "快递";
  if (/卡航|铁路/.test(name)) return "卡航铁路";
  if (/空/.test(name)) return "空运";
  if (/海/.test(name)) return "海运";
  return "专线";
}

function volDivisor(transport) {
  return transportClass(transport) === "快递" ? 5000 : 6000;
}

// ── 找表头行 ─────────────────────────────────────────────────────
function findHeaderRow(ws, maxScan = 20) {
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  for (let r = 0; r < Math.min(maxScan, range.e.r); r++) {
    const val = ws[XLSX.utils.encode_cell({ r, c: 1 })];
    if (val && val.v === HEADER_NAME) return r;
  }
  return null;
}

// ── 读取单元格值辅助 ────────────────────────────────────────────
function cellVal(ws, r, c) {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = ws[addr];
  return cell ? cell.v : undefined;
}

// ── 解析单个国家价表 sheet ───────────────────────────────────────
function parseCountry(ws) {
  const hdr = findHeaderRow(ws);
  if (hdr === null) return [];

  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  const lastCol = range.e.c;
  const maxRow = range.e.r;

  const channels = [];
  let cur = null;
  let tierCols = [];
  let r = hdr;

  function readZoneFields(rr, inherit) {
    return {
      transport: cellStr(cellVal(ws, rr, 8)) || (inherit || {}).transport,
      pickup_lead: cellStr(cellVal(ws, rr, 9)) || (inherit || {}).pickup_lead,
      sign_lead: cellStr(cellVal(ws, rr, 10)) || (inherit || {}).sign_lead,
      comp_penalty: cellStr(cellVal(ws, rr, 11)) || (inherit || {}).comp_penalty,
      remark: cellStr(cellVal(ws, rr, 12)) || (inherit || {}).remark,
    };
  }

  while (r <= maxRow) {
    const name = cellVal(ws, r, 1);
    const code = cellVal(ws, r, 2);

    if (name === HEADER_NAME) {
      tierCols = [];
      for (let c = 3; c <= lastCol; c++) {
        const hv = cellVal(ws, r, c);
        if (hv != null) {
          const match = String(hv).match(VOL_RE);
          if (match) tierCols.push({ col: c, minW: parseInt(match[1], 10) });
        }
      }
      r++;
      continue;
    }

    const zone = cellVal(ws, r, 3);

    if (name) {
      const transport = cellStr(cellVal(ws, r, 8));
      const f = readZoneFields(r, null);
      const tiers = {};
      for (const tc of tierCols) {
        const p = toNum(cellVal(ws, r, tc.col));
        if (p !== null) tiers[tc.minW] = p;
      }

      cur = {
        code: code ? String(code).trim() : null,
        name: String(name).trim(),
        transport: f.transport,
        transport_class: transport ? transportClass(transport) : inferClassFromName(name),
        vol_divisor: volDivisor(transport),
        clearance_fee: toNum(cellVal(ws, r, 7)) || 0,
        pickup_lead: f.pickup_lead,
        sign_lead: f.sign_lead,
        comp_penalty: f.comp_penalty,
        remark: f.remark,
        zones: [],
        tier_cols: tierCols.map((tc) => tc.minW),
      };
      channels.push(cur);

      if (zone) {
        cur.zones.push({
          zone: String(zone).trim(),
          tiers,
          transport: f.transport,
          pickup_lead: f.pickup_lead,
          sign_lead: f.sign_lead,
          comp_penalty: f.comp_penalty,
          remark: f.remark,
        });
      }
    } else if (zone && cur) {
      const tiers = {};
      let hasPrice = false;
      for (const tc of tierCols) {
        const p = toNum(cellVal(ws, r, tc.col));
        if (p !== null) { tiers[tc.minW] = p; hasPrice = true; }
      }
      if (!hasPrice && cur.zones.length > 0) {
        Object.assign(tiers, cur.zones[cur.zones.length - 1].tiers);
      }
      const f = readZoneFields(r, cur);
      cur.zones.push({
        zone: String(zone).trim(),
        tiers,
        transport: f.transport,
        pickup_lead: f.pickup_lead,
        sign_lead: f.sign_lead,
        comp_penalty: f.comp_penalty,
        remark: f.remark,
      });
    }
    r++;
  }
  return channels;
}

// ── 解析 FBA 映射 sheet ─────────────────────────────────────────
function parseFba(ws) {
  const out = {};
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  for (let r = 1; r <= range.e.r; r++) {
    const channel = cellVal(ws, r, 0);
    const codeRaw = cellVal(ws, r, 1);
    if (!channel && !codeRaw) continue;
    const code = normCode(codeRaw);
    const tiers = {};
    [[2, 12], [3, 75], [4, 100]].forEach(([c, mn]) => {
      const p = toNum(cellVal(ws, r, c));
      if (p !== null) tiers[mn] = p;
    });
    const lead = cellStr(cellVal(ws, r, 5));
    const entry = { channel: String(channel).trim(), tiers, lead };
    if (!out[code]) out[code] = [];
    out[code].push(entry);
  }
  return out;
}

// ── 解析船期表 ───────────────────────────────────────────────────
function parseVessel(ws) {
  const out = [];
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  for (let r = 3; r <= range.e.r; r++) {
    const channel = cellVal(ws, r, 1);
    if (!channel) continue;
    function fmtDate(v) {
      if (v instanceof Date && !isNaN(v)) {
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, "0");
        const d = String(v.getDate()).padStart(2, "0");
        return `${y}/${m}/${d}`;
      }
      return cellStr(v);
    }
    out.push({
      channel: String(channel).trim().replace(/\n/g, " / "),
      carrier: cellStr(cellVal(ws, r, 2)),
      vessel: cellStr(cellVal(ws, r, 3)),
      etd: fmtDate(cellVal(ws, r, 4)),
      eta: fmtDate(cellVal(ws, r, 5)),
      port: cellStr(cellVal(ws, r, 6)),
      cut_off: cellStr(cellVal(ws, r, 7)),
    });
  }
  return out;
}

// ── 解析发货须知 ─────────────────────────────────────────────────
function parseNotice(ws) {
  const notice = {
    currency: "RMB",
    volumetric: { 快递: 5000, 专线: 6000 },
    girth_formula: null,
    piece_girth_range: null,
    piece_weight_range: null,
    oversize_fee: {},
    overweight_fee: {},
    export_customs_fee: {},
    import_clears_fee: {},
    rules: [],
    long_text: [],
  };

  const longTextNodes = ["时效免赔说明", "签收免赔情况说明", "赔偿标准", "索赔程序", "保险索赔流程"];
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");

  let lastNode = null;
  let lastCharge = null;

  for (let r = 2; r <= range.e.r; r++) {
    const rawNode = cellStr(cellVal(ws, r, 1));
    const node = rawNode || lastNode;
    if (rawNode) lastNode = rawNode;

    const rawCharge = cellStr(cellVal(ws, r, 2));
    const charge = rawCharge || lastCharge;
    if (rawCharge && !longTextNodes.includes(node)) lastCharge = rawCharge;

    const ctype = cellStr(cellVal(ws, r, 3));
    const us = cellStr(cellVal(ws, r, 4));
    const uk = cellStr(cellVal(ws, r, 5));
    const eu = cellStr(cellVal(ws, r, 6));
    const ca = cellStr(cellVal(ws, r, 7));
    const note = cellStr(cellVal(ws, r, 8));

    if (!node) continue;

    if (longTextNodes.includes(node)) {
      notice.long_text.push({ title: node, text: (charge || "").replace(/\\n/g, "\n").trim(), note });
      continue;
    }

    const byCountry = {};
    [["US", us], ["UK", uk], ["EU", eu], ["CA", ca]].forEach(([k, v]) => {
      if (v != null && v !== "" && v !== "/") byCountry[k] = v;
    });

    if (node === "计费重" && charge === "围长公式") notice.girth_formula = us;
    else if (node === "计费重" && charge === "单件围长范围") notice.piece_girth_range = `${us || ""}；${note || ""}`.replace(/；$/, "");
    else if (node === "计费重" && charge === "单件实重范围") notice.piece_weight_range = `${us || ""}；${note || ""}`.replace(/；$/, "");
    else if (node === "计费重" && charge === "超长收费") {
      for (const [k, v] of Object.entries(byCountry)) { const n = toNum(v); if (n != null) notice.oversize_fee[k] = n; }
    } else if (node === "计费重" && charge === "超重收费") {
      for (const [k, v] of Object.entries(byCountry)) { const n = toNum(v); if (n != null) notice.overweight_fee[k] = n; }
    } else if (node === "出口报关" && charge === "报关费") {
      if (!notice.export_customs_fee[ctype]) notice.export_customs_fee[ctype] = {};
      for (const [k, v] of Object.entries(byCountry)) { const n = toNum(v); if (n != null) notice.export_customs_fee[ctype][k] = n; }
    } else if (node === "进口清关" && charge === "清关费") {
      if (!notice.import_clears_fee[ctype]) notice.import_clears_fee[ctype] = {};
      for (const [k, v] of Object.entries(byCountry)) { const n = toNum(v); if (n != null) notice.import_clears_fee[ctype][k] = n; }
    } else {
      notice.rules.push({ node, charge, ctype, by_country: byCountry, note });
    }
  }
  return notice;
}

// ── 解析目录 ─────────────────────────────────────────────────────
function parseDirectory(ws) {
  const warehouses = [];
  for (let r = 4; r <= 6; r++) {
    const v = cellVal(ws, r, 1);
    if (v) {
      const s = String(v).trim();
      const idx = s.indexOf("：");
      if (idx > 0) warehouses.push({ name: s.slice(0, idx).trim(), addr: s.slice(idx + 1).trim() });
      else warehouses.push({ name: s, addr: "" });
    }
  }
  let website = null;
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  for (let r = 0; r < Math.min(9, range.e.r); r++) {
    const v = cellVal(ws, r, 1);
    if (v && /aheadfour/i.test(String(v))) { website = String(v).trim(); break; }
  }
  return { warehouses, website };
}

// ── 主解析入口 ───────────────────────────────────────────────────
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });

  const countries = {};
  for (const [key, sheet] of Object.entries(COUNTRY_SHEETS)) {
    const ws = wb.Sheets[sheet];
    if (!ws) continue;
    countries[key] = { name: sheet, channels: parseCountry(ws) };
  }

  const fbaMap = parseFba(wb.Sheets["参考"] || {});
  const nameToCode = {};
  for (const cobj of Object.values(countries)) {
    for (const ch of cobj.channels) { nameToCode[ch.name] = ch.code; }
  }
  for (const [code, entries] of Object.entries(fbaMap)) {
    for (const entry of entries) { entry.code = nameToCode[entry.channel] || null; }
  }

  return {
    version: null,
    updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    source_file: null,
    company: parseDirectory(wb.Sheets["目录"] || {}),
    countries,
    fba_map: fbaMap,
    shipping_notice: parseNotice(wb.Sheets["发货须知"] || {}),
    vessel_schedule: parseVessel(wb.Sheets["船期表"] || {}),
  };
}

// ── GitHub API 工具 ──────────────────────────────────────────────
async function ghApi(method, path, token, data) {
  const url = `https://api.github.com${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "aheadfour-upload-fn",
    },
  };
  if (data) opts.body = JSON.stringify(data);

  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function ghUploadFile(repo, token, branch, pathRel, contentBytes, message) {
  const { status: st, body: cur } = await ghApi("GET", `/repos/${repo}/contents/${pathRel}?ref=${branch}`, token);
  const sha = st === 200 ? cur.sha : undefined;

  const putData = {
    message: message || `sync: ${pathRel}`,
    content: Buffer.from(contentBytes).toString("base64"),
    branch,
  };
  if (sha) putData.sha = sha;

  return ghApi("PUT", `/repos/${repo}/contents/${pathRel}`, token, putData);
}

// ── CORS 工具 ────────────────────────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

// ── Vercel 入口（fetch Web Standard 格式）────────────────────────
export default async function handler(request) {
  // OPTIONS 预检
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (request.method !== "POST") {
    return Response.json(
      { ok: false, message: "仅支持 POST" },
      { status: 405, headers: corsHeaders() }
    );
  }

  const adminPw = process.env.ADMIN_PW || "";

  let pw = "";
  let fileBuffer = null;
  let fileName = "";

  try {
    const formData = await request.formData();
    pw = formData.get("pw") || "";
    const file = formData.get("file");
    if (file && typeof file !== "string" && file.name) {
      fileName = file.name;
      fileBuffer = Buffer.from(await file.arrayBuffer());
    }
  } catch (e) {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/octet-stream") || ct.includes("application/vnd.openxmlformats-officedocument")) {
      fileBuffer = Buffer.from(await request.arrayBuffer());
      pw = request.headers.get("x-admin-pw") || "";
      fileName = request.headers.get("x-file-name") || "";
    } else {
      return Response.json(
        { ok: false, message: `无法解析请求：${e.message}` },
        { status: 400, headers: corsHeaders() }
      );
    }
  }

  if (adminPw && pw !== adminPw) {
    return Response.json(
      { ok: false, message: "密码错误或无权限" },
      { status: 403, headers: corsHeaders() }
    );
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    return Response.json(
      { ok: false, message: "未收到文件内容" },
      { status: 400, headers: corsHeaders() }
    );
  }

  let data;
  try {
    data = parseWorkbook(fileBuffer);
  } catch (e) {
    console.error("Parse error:", e);
    return Response.json(
      { ok: false, message: `解析失败：${e.message}` },
      { status: 400, headers: corsHeaders() }
    );
  }

  const verMatch = fileName.match(/(\d{8})/);
  data.version = verMatch ? verMatch[1] : new Date().toISOString().slice(0, 10).replace(/-/g, "");
  data.source_file = fileName;
  data.updated_at = new Date().toISOString().slice(0, 19).replace("T", " ");

  const repo = process.env.GITHUB_REPO || "";
  const ghToken = process.env.GITHUB_TOKEN || "";
  const branch = process.env.GITHUB_BRANCH || "main";

  if (!repo || !ghToken) {
    return Response.json(
      { ok: false, message: "服务端配置缺失" },
      { status: 500, headers: corsHeaders() }
    );
  }

  const jsonContent = JSON.stringify(data, null, 2);
  const { status: pushStatus } = await ghUploadFile(
    repo, ghToken, branch, "prices.json",
    Buffer.from(jsonContent, "utf-8"),
    "update prices.json via public upload",
  );

  if (pushStatus === 200 || pushStatus === 201) {
    const chCount = Object.values(data.countries || {})
      .reduce((sum, c) => sum + (c.channels || []).length, 0);
    return Response.json({
      ok: true,
      version: data.version,
      channel_count: chCount,
      fba_count: Object.keys(data.fba_map || {}).length,
      message: "价表已提交，公网约 1 分钟生效",
    }, { headers: corsHeaders() });
  } else {
    return Response.json({
      ok: false,
      message: `提交失败（HTTP ${pushStatus}）`,
    }, { status: 500, headers: corsHeaders() });
  }
}
