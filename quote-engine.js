/* 前晋四报价引擎 · 纯前端移植（镜像 app/engine.py + app/intake.py）
   仅依赖浏览器/Node 原生能力，不发任何网络请求。
   浏览器：<script src="quote-engine.js"></script> 后使用全局 Engine。
   Node：const Engine = require('./quote-engine.js')。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function round1(x) { return Math.round(x * 10) / 10; }
  function round2(x) { return Math.round(x * 100) / 100; }
  function sumN(arr) { return arr.reduce((a, b) => a + b, 0); }

  const Engine = {
    _prices: null,

    /** 载入价表；schemes 为按国家分组的公式/代理渠道，合并进 countries。 */
    load(prices, schemes) {
      this._prices = JSON.parse(JSON.stringify(prices));
      this._mergeSchemes(schemes || {});
      return this;
    },

    /** 返回当前价表版本号（如 '20260810'） */
    getVersion() {
      return (this._prices && this._prices.version) || '—';
    },

    _mergeSchemes(schemes) {
      const P = this._prices;
      for (const country of Object.keys(schemes)) {
        const list = schemes[country] || [];
        if (!P.countries[country]) P.countries[country] = { name: country, channels: [] };
        if (!P.countries[country].channels) P.countries[country].channels = [];
        for (const ch of list) {
          if (!P.countries[country].channels.some((c) => (c.code || '') === (ch.code || ''))) {
            P.countries[country].channels.push(ch);
          }
        }
      }
    },

    _norm(s) {
      if (s == null) return '';
      return String(s).replace(/\s+/g, '').toUpperCase();
    },

    findChannel(country, channelCode) {
      if (!country || !channelCode) return null;
      const chs = (this._prices.countries[country] || {}).channels || [];
      const code = this._norm(channelCode);
      return chs.find((c) => this._norm(c.code) === code) || null;
    },

    findChannelByName(name) {
      for (const country of Object.keys(this._prices.countries)) {
        const hit = (this._prices.countries[country].channels || []).find((c) => c.name === name);
        if (hit) return [country, hit];
      }
      return [null, null];
    },

    /** 在渠道分区列表中匹配目的仓/邮编/FBA 码。 */
    matchZone(zones, dest) {
      const nd = this._norm(dest);
      if (!nd) return null;
      for (const z of zones) if (nd && nd.includes(this._norm(z.zone))) return z;
      if (/^\d+$/.test(nd)) {
        const v = parseInt(nd[0], 10);
        for (const z of zones) {
          const zm = /^(\d+)-(\d+)$/.exec(z.zone.trim());
          if (zm && !(zm[1] === '0' && zm[2] === '9') && parseInt(zm[1], 10) <= v && v <= parseInt(zm[2], 10)) return z;
        }
        for (const z of zones) if (z.zone.trim() === '0-9') return z;
      }
      for (const z of zones) if (z.zone.trim() === '全区' || z.zone.trim() === '1区') return z;
      return null;
    },

    _autoPickChannel(chs, weight, length, width, height) {
      const heavy = (weight || 0) > 30;
      const longest = Math.max(length || 0, width || 0, height || 0);
      const longItem = longest > 120;
      let pools;
      if (heavy || longItem) {
        pools = [
          (c) => (c.name || '').includes('海') || (c.name || '').includes('卡航'),
          (c) => ['海运', '卡航', '铁运'].includes(c.transport_class),
        ];
      } else {
        pools = [
          (c) => ['快递', '空运'].includes(c.transport_class),
          (c) => (c.name || '').includes('快递') || (c.name || '').includes('空'),
        ];
      }
      for (const pred of pools) {
        const withTiers = chs.filter((c) => pred(c) && c.zones && c.zones.some((z) => z.tiers));
        if (withTiers.length) return withTiers[0].code;
        const hit = chs.find(pred);
        if (hit) return hit.code;
      }
      const withTiers = chs.filter((c) => c.zones && c.zones.some((z) => z.tiers));
      if (withTiers.length) return withTiers[0].code;
      return chs[0].code;
    },

    resolve(country, channelCode, dest, weight, length, width, height) {
      let note = '';
      let singleQuote = false;
      const P = this._prices;
      const fbaList = dest ? (P.fba_map || {})[this._norm(dest)] : null;
      if (fbaList) {
        let entry = null;
        if (channelCode) {
          entry = fbaList.find((x) => this._norm(x.code) === this._norm(channelCode) || this._norm(x.channel) === this._norm(channelCode));
        }
        if (entry == null) entry = fbaList[0];
        const [fcountry, ch] = this.findChannelByName(entry.channel);
        if (ch == null) return [null, true, `FBA码 ${dest} 命中渠道「${entry.channel}」但未在国家价表中找到明细`];
        if (ch.scheme === 'formula') {
          return [{
            country: fcountry, country_name: (P.countries[fcountry] || {}).name || fcountry,
            channel: ch, matched_zone: null, tiers: {}, lead_sign: ch.sign_lead, scheme: 'formula',
          }, false, note];
        }
        country = fcountry;
        channelCode = ch.code;
        const tiers = entry.tiers || {};
        const leadSign = entry.lead;
        note = `已按 FBA 仓码 ${dest} 命中渠道 ${ch.name}`;
        if (fbaList.length > 1) {
          const names = fbaList.map((x) => x.channel).join(' / ');
          note += `；该仓码匹配多个渠道（${names}），已默认取「${ch.name}」，可在渠道下拉切换`;
        }
        const matchedZoneText = dest;
        if (!Object.keys(tiers).length) {
          singleQuote = true;
          note = (note + '；该渠道为「单询」价，无固定单价，请联系业务报价').replace(/^；/, '');
        }
        return [{
          country, country_name: (P.countries[country] || {}).name || country,
          channel: ch, matched_zone: matchedZoneText, tiers, lead_sign: leadSign,
        }, singleQuote, note];
      }

      if (!channelCode && country && P.countries[country]) {
        const chs = P.countries[country].channels || [];
        if (chs.length) {
          channelCode = this._autoPickChannel(chs, weight, length, width, height);
          note = '未指定渠道，系统已自动匹配默认渠道（请人工复核）';
        }
      }
      const ch = this.findChannel(country, channelCode);
      if (ch == null) return [null, true, `未找到渠道：国家=${country} 代码=${channelCode}`];
      if (ch.scheme === 'formula') {
        const fnote = note || '已按海卡公式方案报价（无分区匹配）';
        return [{
          country, country_name: (P.countries[country] || {}).name || country,
          channel: ch, matched_zone: null, tiers: {}, lead_sign: ch.sign_lead, scheme: 'formula',
        }, false, fnote];
      }
      const zones = ch.zones || [];
      let z = dest ? this.matchZone(zones, dest) : null;
      if (z == null) {
        z = zones[0] || null;
        if (dest) note = `未匹配到「${dest}」，已按基础价（${z ? z.zone : '全区'}）估算，请人工复核`;
      }
      const matchedZoneText = z ? z.zone : '全区';
      const tiers = (z || {}).tiers || {};
      const leadSign = (z || {}).lead_sign || ch.sign_lead;
      if (!note) note = `已匹配分区：${matchedZoneText}`;
      if (!Object.keys(tiers).length) {
        singleQuote = true;
        note = (note + '；该渠道为「单询」价，无固定单价，请联系业务报价').replace(/^；/, '');
      }
      return [{
        country, country_name: (P.countries[country] || {}).name || country,
        channel: ch, matched_zone: matchedZoneText, tiers, lead_sign: leadSign,
      }, singleQuote, note];
    },

    computeQuote(payload) {
      const { country, channel_code: channelCode, dest, actual_weight: actualWeight, pieces, length, width, height, items, attrs } = payload;
      const [res, singleQuote, note] = this.resolve(country, channelCode, dest, actualWeight, length, width, height);
      if (res == null) return { ok: false, single_quote: singleQuote, message: note };
      if (singleQuote) {
        const ch = res.channel;
        return {
          ok: false, single_quote: true, message: note,
          country: res.country, country_name: res.country_name,
          channel: { code: ch.code, name: ch.name, transport: ch.transport },
          matched_zone: res.matched_zone, remark: ch.remark, comp_penalty: ch.comp_penalty,
        };
      }
      if (res.scheme === 'formula') return this._computeFormula(res, note, payload);

      const ch = res.channel;
      const tiers = res.tiers;
      const mins = Object.keys(tiers).map(Number).sort((a, b) => a - b);
      const divisor = ch.vol_divisor || 6000;
      const pc = Math.max(1, parseInt(pieces || 1, 10));
      const perPieceVol = (length && width && height) ? (Number(length) * Number(width) * Number(height)) / divisor : 0;
      const volumetricTotal = perPieceVol * pc;
      const actualTotal = Number(actualWeight || 0);
      const chargeable = Math.max(actualTotal, volumetricTotal);
      const minTier = mins[0];
      const billableRaw = Math.max(chargeable, minTier);
      const billable = Math.ceil(billableRaw * 2) / 2;
      let tierUsed = mins[0];
      for (const mn of mins) if (billable >= mn) tierUsed = mn;
      const unitPrice = tiers[String(tierUsed)];
      const freight = unitPrice * billable;

      const sn = this._prices.shipping_notice || {};
      const sur = sn.surcharges || {};
      const oversizeTh = sur.oversize_threshold_cm || 265;
      const overweightTh = sur.overweight_threshold_kg || 30;

      const flags = [];
      let oversizeCount = 0, overweightCount = 0;
      if (length && width && height) {
        const longest = Math.max(length, width, height);
        const shorts = [length, width, height].map(Number).sort((a, b) => a - b);
        const girth = (shorts[0] + shorts[1]) * 2 + longest;
        const pieceW = actualTotal / pc;
        for (let i = 0; i < pc; i++) {
          if (girth > oversizeTh) oversizeCount++;
          if (pieceW > overweightTh) overweightCount++;
        }
        if (oversizeTh < girth && girth <= oversizeTh + 5) flags.push(`单件围长 ${oversizeTh + 1}–${oversizeTh + 5}CM，超长费需单询确认`);
        if (overweightTh < pieceW && pieceW <= 30) flags.push(`单件实重 ${overweightTh + 1}–30kg，超重费需单询确认`);
        if (pieceW < 12) flags.push(`单件实重不足 12kg（实际 ${pieceW.toFixed(1)}kg），按 12kg 进位计费`);
      }
      const oversizeFee = oversizeCount * (sn.oversize_fee ? (sn.oversize_fee[res.country] || 0) : 0);
      const overweightFee = overweightCount * (sn.overweight_fee ? (sn.overweight_fee[res.country] || 0) : 0);

      const [trigLines, trigPending] = this._triggerSurcharges(res.country, ch, chargeable, actualTotal, pc, dest, attrs);

      const lineItems = [
        { name: '运费', detail: `${billable} kg × ¥${unitPrice}/kg（${tierUsed}Kg+ 档）`, amount: round2(freight) },
      ];
      lineItems.push(...trigLines);
      if (oversizeFee) lineItems.push({ name: '超长费', detail: `${oversizeCount} 件 × ¥${sn.oversize_fee[res.country]}/箱（围长>${oversizeTh}CM）`, amount: round2(oversizeFee) });
      if (overweightFee) lineItems.push({ name: '超重费', detail: `${overweightCount} 件 × ¥${sn.overweight_fee[res.country]}/箱（单件>${overweightTh}kg）`, amount: round2(overweightFee) });

      const total = lineItems.reduce((s, li) => s + li.amount, 0);
      flags.push(...trigPending);
      return {
        ok: true, single_quote: false,
        country: res.country, country_name: res.country_name,
        channel: { code: ch.code, name: ch.name, transport: ch.transport, transport_class: ch.transport_class },
        matched_zone: res.matched_zone, match_note: note,
        weight: {
          actual_total: round2(actualTotal), pieces: pc, dims: [length, width, height],
          vol_divisor: divisor, volumetric_total: round2(volumetricTotal),
          chargeable: round2(chargeable), billable, min_tier: minTier, tier_used: tierUsed, unit_price: unitPrice,
        },
        line_items: lineItems, total: round2(total),
        lead: { pickup: ch.pickup_lead, sign: res.lead_sign },
        remark: ch.remark, comp_penalty: ch.comp_penalty, flags,
      };
    },

    _triggerSurcharges(country, ch, chargeable, actualTotal, pieces, dest, attrs) {
      const sn = this._prices.shipping_notice || {};
      const sur = sn.surcharges || {};
      const name = ch.name || '';
      const tclass = ch.transport_class;
      const pva = (name.toUpperCase().includes('PVA')) || name.includes('包税') || ch.pva;
      const isExpress = (tclass === '快递') || name.includes('快递');
      const mainland = !(name.includes('韩国') || name.includes('香港'));
      const isAir = (tclass === '空运') || name.includes('空派') || name.includes('空运');
      const destIsFba = dest ? !!((this._prices.fba_map || {})[this._norm(dest)]) : false;
      const a = attrs || {};
      const lines = [], pending = [];

      // 出口报关费（全类 350）
      const ecMap = (sn.export_customs_fee || {})[tclass] || {};
      const ec = ecMap[country] || 0;
      if (ec) lines.push({ name: '出口报关费', detail: `据发货须知·出口报关(${tclass})`, amount: round2(ec) });

      // 进口清关费：快递 vs PVA 包税
      if (pva) {
        const cf = (sur.pva_clearance_fee || {})[country] || 0;
        if (cf) lines.push({ name: 'PVA包税清关费', detail: '包税渠道 PVA 清关', amount: round2(cf) });
      } else if (isExpress) {
        const cf = (sur.express_clearance_fee || {})[country] || 0;
        if (cf) lines.push({ name: '快递清关费', detail: '快递渠道进口清关', amount: round2(cf) });
      }

      // 单票单件费（英/欧，1件+快递派送）
      if ((country === 'UK' || country === 'EU') && parseInt(pieces || 1, 10) === 1 && isExpress) {
        const sp = sur.single_piece_fee || 0;
        if (sp) lines.push({ name: '单票单件费', detail: '单票仅1件+快递派送', amount: round2(sp) });
      }

      // 磁检费（大陆空运 + 带磁）
      if (a.magnetic && isAir) {
        if (mainland) {
          const mf = sur.magnetic_fee || 0;
          if (mf) lines.push({ name: '磁检费', detail: '大陆空运+带磁', amount: round2(mf) });
        } else {
          pending.push('带磁货物但起飞地为香港/韩国，免磁检费');
        }
      }

      // 膏体 / 液体
      const baseW = chargeable || actualTotal || 0;
      if (a.paste) {
        const r = sur.paste_fee_per_kg || 4;
        lines.push({ name: '膏体附加费', detail: `${r}元/kg×${round1(baseW)}kg(3-5取中)`, amount: round2(r * baseW) });
      }
      if (a.liquid) {
        const r = sur.liquid_fee_per_kg || 4;
        lines.push({ name: '液体附加费', detail: `${r}元/kg×${round1(baseW)}kg(3-5取中)`, amount: round2(r * baseW) });
      }

      // 高货值 / 高税率 / 高查验率（仅包税 PVA 渠道）
      const HV = [['high_value', '高货值'], ['high_tax', '高税率'], ['high_check', '高查验率']];
      for (const [key, label] of HV) {
        if (a[key]) {
          if (pva) {
            const rate = (sur[key + '_fee'] || {})[country] || 0;
            if (rate) lines.push({ name: `${label}附加费`, detail: `包税渠道+${label}品类 ${rate}元/kg×${round1(baseW)}kg`, amount: round2(rate * baseW) });
          } else {
            pending.push(`检测到${label}品类，但当前渠道非包税(PVA)，该附加费不生效；如需计收请改选包税渠道`);
          }
        }
      }

      // 保险
      const val = a.value;
      if (val) {
        const ir = sur.insurance_rate || 0.003;
        lines.push({ name: '货运保险', detail: `货值${val}×${ir}`, amount: round2(Number(val) * ir) });
      } else {
        pending.push('可自愿认购货运保险（货值3‰），如需核算请提供申报货值');
      }

      // 缺信息项
      if (a.cert && a.cert.length) {
        pending.push(`涉及强制认证（${a.cert.join('/')}）：认证附加费需单询，请提供认证资料`);
      }
      if (a.ciq) {
        pending.push(`需商检品类：若买单报关将加收商检费 ${sur.ciq_fee || 800}元/票，请确认报关方式`);
      }
      const dn = a.declared_names;
      const freeN = sur.free_names || 1;
      if (dn && parseInt(dn, 10) > freeN) {
        const en = sur.extra_name_fee || 30;
        lines.push({ name: '超品名费', detail: `申报品名${dn}个(免费${freeN})×${en}元`, amount: round2((parseInt(dn, 10) - freeN) * en) });
      } else if (!dn) {
        pending.push(`超品名费：申报品名超免费数量(${freeN}个)部分 30元/个，请提供申报品名数`);
      }
      if (!a.box_mark_known) {
        pending.push(`箱唛贴标费 ${sur.box_mark_fee || 1}元/张，需确认到仓是否有箱唛及张数`);
      }

      // 地址附加费
      const at = a.address_type;
      if (!destIsFba) {
        if (at) {
          const af = sur.address_fee || {};
          if (at === 'commercial') {
            const r = (af.commercial_per_kg || {})[country] || 1;
            lines.push({ name: '商业地址附加费', detail: `${r}元/kg`, amount: round2(r * baseW) });
          } else if (at === 'residential') {
            const r = (af.residential_per_box || {})[country] || 30;
            lines.push({ name: '私人地址附加费', detail: `${r}元/箱`, amount: round2(r * parseInt(pieces || 1, 10)) });
          } else if (at === 'remote' || at === 'ultra_remote') {
            const key = at === 'remote' ? 'remote_per_box' : 'ultra_remote_per_box';
            const r = (af[key] || {})[country] || (at === 'remote' ? 35 : 45);
            lines.push({ name: (at === 'remote' ? '偏远' : '超偏远') + '地址附加费', detail: `${r}元/箱`, amount: round2(r * parseInt(pieces || 1, 10)) });
          }
        } else {
          pending.push('地址附加费需按收货地址类型核查：商业1元/kg、私人30元/箱、偏远(美35/英欧加450)元/箱、超偏远(美45/英欧加450)元/箱');
        }
      }

      return [lines, pending];
    },

    _computeFormula(res, note, payload) {
      const { dest, actual_weight: actualWeight, pieces, length, width, height, items, attrs } = payload;
      const ch = res.channel;
      const divisor = ch.vol_divisor || 6000;
      const rate = Number(ch.rate_per_kg || 0);
      let actualTotal, volumetricTotal, pieceCount;
      if (items && items.length) {
        actualTotal = items.reduce((s, it) => s + (Number(it.weight || 0) * (Number(it.pieces || 1))), 0);
        volumetricTotal = items.reduce((s, it) => s + ((Number(it.length) * Number(it.width) * Number(it.height) / divisor) * (Number(it.pieces || 1))), 0);
        pieceCount = items.reduce((s, it) => s + (Number(it.pieces || 1)), 0);
      } else {
        pieceCount = Math.max(1, parseInt(pieces || 1, 10));
        actualTotal = Number(actualWeight || 0);
        const perPieceVol = (length && width && height) ? (Number(length) * Number(width) * Number(height) / divisor) : 0;
        volumetricTotal = perPieceVol * pieceCount;
      }
      const chargeable = Math.max(actualTotal, volumetricTotal);
      const freight = rate * chargeable;
      const lineItems = [{ name: '运费', detail: `${chargeable.toFixed(1)} kg × ¥${rate}/kg（海卡公式价，÷${divisor}）`, amount: round2(freight) }];
      const pending = [];
      for (const s of (ch.surcharges || [])) {
        const amt = s.amount;
        if (amt == null || amt === '') { pending.push(s.name || '附加费'); continue; }
        const a = Number(amt);
        const basis = s.basis || 'shipment';
        let amtTotal, basisTxt;
        if (basis === 'piece') { amtTotal = a * pieceCount; basisTxt = `按件×${pieceCount}`; }
        else { amtTotal = a; basisTxt = '按票'; }
        lineItems.push({ name: s.name || '附加费', detail: `${basisTxt} ¥${a}`, amount: round2(amtTotal) });
      }
      const total = lineItems.reduce((s, li) => s + li.amount, 0);
      const flags = [];
      if (pending.length) flags.push('以下附加费金额待定，未计入总价，请人工补录：' + pending.join('、'));

      const [trigLines, trigPending] = this._triggerSurcharges(res.country, ch, chargeable, actualTotal, pieceCount, dest, attrs);
      lineItems.push(...trigLines);
      const totalFinal = lineItems.reduce((s, li) => s + li.amount, 0);
      flags.push(...trigPending);

      return {
        ok: true, single_quote: false,
        country: res.country, country_name: res.country_name,
        channel: { code: ch.code, name: ch.name, transport: ch.transport, transport_class: ch.transport_class, scheme: 'formula' },
        matched_zone: null, match_note: note,
        weight: {
          actual_total: round2(actualTotal), pieces: pieceCount, vol_divisor: divisor,
          volumetric_total: round2(volumetricTotal), chargeable: round2(chargeable),
          billable: round2(chargeable), rate_per_kg: rate,
        },
        line_items: lineItems, total: round2(totalFinal),
        lead: { pickup: ch.pickup_lead, sign: res.lead_sign },
        remark: ch.remark, comp_penalty: ch.comp_penalty, flags,
      };
    },

    // ---------- 整柜(FCL)报价（镜像 engine.compute_fcl_quote） ----------
    getFclMeta(country) {
      const fcl = (this._prices.fcl || {})[country];
      if (!fcl) return { ok: false, message: `未配置 ${country} 整柜费率` };
      return { ok: true, country, fcl };
    },

    computeFclQuote(payload) {
      const { country, container_type: ct, service_mode: mode, origin_port, dest_port,
        ocean_rate, cargo_weight_ton, pva, domestic_truck_fee, tax_fee, attrs,
        odd_port, pss, appointment, overtime, over_dim } = payload;
      const P = this._prices;
      const fcl = (P.fcl || {})[country];
      if (!fcl) return { ok: false, single_quote: true, message: `价表未配置 ${country} 整柜(FCL)费率，请联系管理员维护整柜价表` };
      const a = attrs || {};
      const lines = [], pending = [], flags = [];
      const containerType = ct || '40HQ';
      const serviceMode = mode || 'door';

      // 国内起运段
      const dom = fcl.domestic || {};
      const customs = dom.customs_fee != null ? dom.customs_fee : 350;
      lines.push({ name: '出口报关费', detail: '国内起运段·出口报关', amount: round2(customs) });
      const docs = (payload.docs_fee != null && payload.docs_fee !== '') ? payload.docs_fee : (dom.docs_fee != null ? dom.docs_fee : null);
      if (docs != null && docs !== '') lines.push({ name: '港杂/订舱/文件/封条费', detail: '国内起运段固定费', amount: round2(Number(docs)) });
      else pending.push('港杂/订舱/文件/封条费需按实际询价（未公示标准价）');
      const truck = (domestic_truck_fee != null && domestic_truck_fee !== '') ? domestic_truck_fee : (dom.truck_fee != null ? dom.truck_fee : null);
      if (truck != null && truck !== '') lines.push({ name: '国内拖车费', detail: `${origin_port || '起运地'}→码头`, amount: round2(Number(truck)) });
      else pending.push(`国内拖车费（${origin_port || '起运地'}→码头）需按实际距离单询`);

      // 国际海运段
      const rates = fcl.ocean_rates || {};
      let rate = (ocean_rate != null && ocean_rate !== '') ? Number(ocean_rate)
                 : ((rates[dest_port] && rates[dest_port][containerType]) || null);
      if (rate == null) return { ok: false, single_quote: true, message: `未查到 ${country} ${dest_port} ${containerType} 整柜海运费，请手动输入或维护整柜价表` };
      lines.push({ name: '海运费', detail: `${origin_port || '起运港'}→${dest_port} ${containerType}`, amount: round2(rate) });
      const sea = fcl.sea || {};
      const baf = (payload.ba_fee != null) ? payload.ba_fee : sea.baf;
      if (baf != null && baf !== '') lines.push({ name: '燃油附加费(BAF)', detail: '海运段', amount: round2(Number(baf)) });
      else pending.push('燃油附加费(BAF)需按船公司/航线单询');
      const thc = (payload.thc_fee != null) ? payload.thc_fee : sea.thc;
      if (thc != null && thc !== '') lines.push({ name: '码头操作费(THC)', detail: '海运段', amount: round2(Number(thc)) });
      else pending.push('码头操作费(THC)需按船公司单询');

      // 目的港段（整柜到门/到仓均为 DDP 全包，不再做到港CY）
      const trig = fcl.trig || {};
      {
        const ddp = fcl.dest_ddp || {};
        const ic = (payload.import_clearance != null) ? payload.import_clearance : ddp.import_clearance;
        if (ic != null && ic !== '') lines.push({ name: '进口清关费', detail: 'DDP·进口清关', amount: round2(Number(ic)) });
        else pending.push('进口清关费需按目的国单询');
        if (pva) {
          const pvc = ddp.pva_clearance || {};
          const pvf = (pvc && pvc[country] != null) ? pvc[country] : (typeof pvc === 'number' ? pvc : 0);
          if (pvf) lines.push({ name: 'PVA递延清关费', detail: 'DDP包税·PVA递延', amount: round2(Number(pvf)) });
        }
        if (serviceMode === 'warehouse') {
          // 整柜到仓：约仓费 + 海外仓操作费（卸货入库/贴标/拦截）
          if (appointment) {
            const apf = trig.appointment_fee;
            if (apf != null && apf !== '') lines.push({ name: '亚马逊送仓预约费', detail: '整柜直送FBA需预约', amount: round2(Number(apf)) });
            else pending.push('亚马逊送仓预约费(约仓费)爆仓期需单询');
          } else {
            pending.push('整柜到仓建议预约送仓，约仓费(appointment)未勾选');
          }
          const ow = ddp.overseas_wh_fee;
          if (ow != null && ow !== '') lines.push({ name: '海外仓操作费', detail: '卸货入库/贴标/拦截', amount: round2(Number(ow)) });
          else pending.push('海外仓操作费（卸货入库/贴标/拦截）需按仓库单询');
        } else {
          // 整柜到门：地址类附加费（商业/私人/偏远），尾程直送收件人地址
          const dt = (payload.dest_truck_fee != null) ? payload.dest_truck_fee : ddp.truck_fee;
          if (dt != null && dt !== '') lines.push({ name: '目的港拖车派送费', detail: '码头→收件人地址(到门)', amount: round2(Number(dt)) });
          else pending.push('目的港拖车派送费（码头→收件人地址）需单询');
        }
        if (tax_fee != null && tax_fee !== '') lines.push({ name: '关税/增值税', detail: 'DDP·实报实销/包税一口价', amount: round2(Number(tax_fee)) });
        else pending.push('关税/增值税需按HS编码/货值单询（或包税一口价）');
      }

      // 整柜专属触发附加费
      const wkg = (cargo_weight_ton || 0) * 1000;
      const lim = (trig.overweight_limit_kg || {})[containerType];
      if (lim && wkg > lim) {
        const owf = trig.overweight_fee;
        if (owf != null && owf !== '') lines.push({ name: '单柜超重费', detail: `货重${wkg.toFixed(0)}kg>柜型限重${lim}kg`, amount: round2(Number(owf)) });
        else pending.push(`单柜超重（货重${wkg.toFixed(0)}kg>限重${lim}kg）：吊柜/拖车附加费需单询`);
        flags.push(`单柜货重 ${wkg.toFixed(0)}kg 超出 ${containerType} 限重 ${lim}kg`);
      }
      if (over_dim) pending.push('超长/超宽/超高货物需开顶柜/框架柜，特殊柜型运价需单询');
      if (odd_port) {
        const opf = trig.odd_port_fee;
        if (opf != null && opf !== '') lines.push({ name: '异地提柜费', detail: '提柜地与起运港不在同区', amount: round2(Number(opf)) });
        else pending.push('异地提柜费需按堆场距离单询');
      }
      if (pss) {
        const psf = trig.pss_fee;
        if (psf != null && psf !== '') lines.push({ name: '旺季附加费(PSS/GRI)', detail: '航运旺季全航线普涨', amount: round2(Number(psf)) });
        else pending.push('旺季附加费(PSS/GRI)按船公司通知单询');
      }
      if (overtime) pending.push('滞港费(Demurrage)/滞箱费(Detention)按超期天数单询');

      // 复用 LCL 触发框架（超品名/膏液/包税品类/认证/商检/箱唛/保险/偏远）
      const sn = P.shipping_notice || {};
      const sur = sn.surcharges || {};
      const dn = a.declared_names;
      const freeN = sur.free_names || 1;
      if (dn && parseInt(dn, 10) > freeN) {
        const en = sur.extra_name_fee || 30;
        lines.push({ name: '超品名费', detail: `申报品名${dn}个(免费${freeN})×${en}元`, amount: round2((parseInt(dn, 10) - freeN) * en) });
      } else if (!dn) {
        pending.push(`超品名费：申报品名超免费数量(${freeN}个)部分 30元/个，请提供申报品名数`);
      }
      const cargoW = wkg || (cargo_weight_ton || 0) * 1000;
      if (a.paste) {
        const r = sur.paste_fee_per_kg || 4;
        lines.push({ name: '膏体附加费', detail: `${r}元/kg×${(cargoW / 1000).toFixed(2)}吨(整柜货重)`, amount: round2(r * cargoW) });
      }
      if (a.liquid) {
        const r = sur.liquid_fee_per_kg || 4;
        lines.push({ name: '液体附加费', detail: `${r}元/kg×${(cargoW / 1000).toFixed(2)}吨(整柜货重)`, amount: round2(r * cargoW) });
      }
      const catDefault = { US: 2, CA: 2, UK: 3, EU: 3 };
      for (const [key, label] of [['high_value', '高货值'], ['high_tax', '高税率'], ['high_check', '高查验率']]) {
        if (a[key]) {
          if (pva) {
            const rateMap = (trig.category_fee && trig.category_fee[country]) || catDefault[country] || 2;
            if (rateMap) lines.push({ name: `${label}附加费`, detail: `包税渠道+${label}品类 ${rateMap}元/kg×${(cargoW / 1000).toFixed(2)}吨`, amount: round2(rateMap * cargoW) });
          } else {
            pending.push(`检测到${label}品类，但当前非包税(DDP)模式，该附加费不生效；如需计收请选DDP包税`);
          }
        }
      }
      if (a.cert && a.cert.length) pending.push(`涉及强制认证（${a.cert.join('/')}）：认证附加费需单询`);
      if (a.ciq) pending.push(`需商检品类：若买单报关将加收商检费 ${sur.ciq_fee || 800}元/票`);
      if (!a.box_mark_known) pending.push(`箱唛贴标费 ${sur.box_mark_fee || 1}元/张，需确认到仓是否有箱唛及张数`);
      const val = a.value;
      if (val) {
        const ir = sur.insurance_rate || 0.003;
        lines.push({ name: '货运保险', detail: `货值${val}×${ir}`, amount: round2(Number(val) * ir) });
      } else {
        pending.push('可自愿认购货运保险（货值3‰）');
      }
      const at = a.address_type;
      if (serviceMode === 'door' && (at === 'remote' || at === 'ultra_remote')) {
        const rtf = trig.remote_truck_fee;
        if (rtf != null && rtf !== '') lines.push({ name: '偏远地址拖车附加费', detail: `${at === 'ultra_remote' ? '超偏远' : '偏远'}地址`, amount: round2(Number(rtf)) });
        else pending.push('偏远/超偏远地址拖车附加费需单询');
      }

      const total = lines.reduce((s, li) => s + li.amount, 0);
      flags.push(...pending);
      return {
        ok: true, single_quote: false, mode: 'fcl',
        country, country_name: (P.countries[country] || {}).name || country,
        container_type: containerType, service_mode: serviceMode,
        origin_port: origin_port, dest_port: dest_port,
        ocean_rate: rate, cargo_weight_ton, pva,
        line_items: lines, total: round2(total), flags,
      };
    },

    // ---------- 对外辅助 ----------
    getCountries() {
      return Object.keys(this._prices.countries).map((k) => ({ code: k, name: this._prices.countries[k].name || k }));
    },
    getChannels(country, dest) {
      const chs = (this._prices.countries[country] || {}).channels || [];
      dest = (dest || '').trim();
      const fbaList = dest ? (this._prices.fba_map || {})[this._norm(dest)] : null;
      return chs.map((c) => {
        const entry = { code: c.code, name: c.name, transport: c.transport, transport_class: c.transport_class, scheme: c.scheme || 'tier' };
        // 可达性分类：仅当填写了目的仓/邮编时计算
        if (dest) {
          if (c.scheme === 'formula') {
            entry.reachable = true;
            entry.reach_reason = '公式价·全境可达';
          } else {
            const z = this.matchZone(c.zones || [], dest);
            const fbaHit = !!fbaList && fbaList.some((x) => this._norm(x.code) === this._norm(c.code) || this._norm(x.channel) === this._norm(c.name));
            if (z || fbaHit) {
              entry.reachable = true;
              entry.reach_reason = z ? ('匹配分区 ' + z.zone) : '命中 FBA 仓码';
            } else {
              entry.reachable = false;
              entry.reach_reason = '该渠道不送达此邮编/仓库';
            }
          }
        }
        return entry;
      });
    },
    getNotice() {
      return this._prices.shipping_notice || {};
    },

    /** 返回与后端 /api/notice 同形的完整数据（须知 + 船期 + 公司/仓库），供前端页面渲染。 */
    getNoticeData() {
      return {
        ok: true,
        company: this._prices.company || {},
        notice: this._prices.shipping_notice || {},
        vessel: this._prices.vessel_schedule || [],
      };
    },

    /** 返回触发式附加费配置（镜像后端 shipping_notice.surcharges），供前端展示费率与提示。 */
    getSurcharges() {
      const sn = this._prices.shipping_notice || {};
      return sn.surcharges || {};
    },

    /** 返回与后端 /api/version 同形的统计信息。 */
    getVersionStats() {
      const countries = this._prices.countries || {};
      const channelCount = Object.keys(countries).reduce((s, k) => s + (countries[k].channels ? countries[k].channels.length : 0), 0);
      const fbaCount = Object.keys(this._prices.fba_map || {}).length;
      return {
        ok: true,
        version: this.getVersion(),
        channel_count: channelCount,
        fba_count: fbaCount,
      };
    },

    // ---------- 粘贴智能识别（镜像 app/intake.py） ----------
    parseIntake(text) {
      text = (text || '').trim();
      const res = {
        product: '', packaging: null, country: null, country_name: null,
        state: null, zip: null, terms: [], weight_kg: null,
        dims_cm: null, pieces: null, electromagnetic: null, flags: [], recommended_mode: null,
        items: [], is_sea_card: false,
        paste: false, liquid: false,
        high_value: false, high_tax: false, high_check: false,
        cert: [], ciq: false, magnetic: false, powered: false,
      };
      if (!text) return res;

      const COUNTRY_KEYWORDS = [
        [/美国|美國|u\.s\.a?\.?|united states|america/i, 'US'],
        [/英国|英國|u\.k\.?|united kingdom|britain|england/i, 'UK'],
        [/德国|deutschland|germany|欧洲|歐洲|\beu\b|europe/i, 'EU'],
        [/加拿大|canada|\bca\b/i, 'CA'],
      ];
      const COUNTRY_NAME = { US: '美国', UK: '英国', EU: '欧洲', CA: '加拿大' };
      const STATE_MAP = {
        '马里兰州': 'MD', '马里兰': 'MD', '加州': 'CA', '加利福尼亚': 'CA', '加尼福利亚': 'CA',
        '纽约': 'NY', '纽约州': 'NY', '新泽西': 'NJ', '纽泽西': 'NJ', '德克萨斯': 'TX', '德州': 'TX',
        '华盛顿州': 'WA', '佛州': 'FL', '佛罗里达': 'FL', '伊利诺伊': 'IL', '乔治亚': 'GA', '佐治亚': 'GA',
        '北卡罗来纳': 'NC', '南卡罗来纳': 'SC', '俄亥俄': 'OH', '宾夕法尼亚': 'PA', '宾州': 'PA',
        '密歇根': 'MI', '马萨诸塞': 'MA', '亚利桑那': 'AZ', '田纳西': 'TN', '华盛顿': 'WA',
        '加利福尼亚州': 'CA', '德克萨斯州': 'TX', '新墨西哥': 'NM', '俄勒冈': 'OR', '犹他': 'UT',
      };
      const TERMS = ['DDP', 'DAP', 'FOB', 'CIF', 'EXW', 'FBA', '双清包税', '双清', '包税'];
      const US_ZIP = /\b(\d{5}(?:-\d{4})?)\b/;
      const UK_ZIP = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
      const CA_ZIP = /\b([ABCEGHJ-NPRSTVXY]\d[A-Z]\s*\d[A-Z]\d)\b/i;

      const detectCountry = (t) => {
        for (const [pat, code] of COUNTRY_KEYWORDS) if (pat.test(t)) return code;
        if (US_ZIP.test(t)) return 'US';
        if (UK_ZIP.test(t)) return 'UK';
        if (CA_ZIP.test(t)) return 'CA';
        return null;
      };

      const m0 = text.match(/(木箱|木架|纸箱|卡板|托盘|木托|包装|尺寸|体积|重量|邮编|国家|州|区|province)/);
      let product = m0 ? text.slice(0, m0.index).trim() : (text.split('\n')[0] || '').trim();
      product = product.replace(/^产品[:：]?/, '').trim();
      res.product = product;

      for (const k of ['木箱', '木架', '纸箱', '卡板', '托盘', '木托', '编织袋']) {
        if (text.includes(k)) { res.packaging = k; break; }
      }
      const country = detectCountry(text);
      res.country = country;
      res.country_name = COUNTRY_NAME[country];
      for (const [name, code] of Object.entries(STATE_MAP)) {
        if (text.includes(name)) { res.state = code; break; }
      }
      if (country === 'UK') { const zm = text.match(UK_ZIP); if (zm) res.zip = zm[1].toUpperCase().replace(/\s+/g, ''); }
      else if (country === 'CA') { const zm = text.match(CA_ZIP); if (zm) res.zip = zm[1].toUpperCase().replace(/\s+/g, ''); }
      else { const zm = text.match(US_ZIP); if (zm) res.zip = zm[1]; }
      for (const t of TERMS) {
        const re = new RegExp('(?<![A-Za-z])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])', 'i');
        if (re.test(text)) res.terms.push(t);
      }

      const toCm = (val, unit) => val * ({ m: 100, '米': 100, cm: 1, '厘米': 1, mm: 0.1, '毫米': 0.1 }[unit] ?? 1);
      const girth = (l, w, h) => {
        const longest = Math.max(l, w, h);
        const shorts = [l, w, h].sort((a, b) => a - b);
        return (shorts[0] + shorts[1]) * 2 + longest;
      };

      const items = [];
      const segments = [];
      for (const raw of text.split('\n')) {
        const r = raw.trim();
        if (!r) continue;
        for (const seg of r.split(/\s*\/\s*/)) {
          const s = seg.trim();
          if (s) segments.push(s);
        }
      }
      for (const ln of segments) {
        const mCn = ln.match(/长\s*(\d+(?:\.\d+)?)\s*(m|米|cm|厘米|毫米|mm)?\s*宽\s*(\d+(?:\.\d+)?)\s*(m|米|cm|厘米|毫米|mm)?\s*高\s*(\d+(?:\.\d+)?)\s*(m|米|cm|厘米|毫米|mm)?/i);
        const mStar = ln.match(/(\d+(?:\.\d+)?)\s*[\*×xX]\s*(\d+(?:\.\d+)?)\s*[\*×xX]\s*(\d+(?:\.\d+)?)\s*(m|米|cm|厘米|毫米|mm)?/i);
        const wm = ln.match(/(\d+(?:\.\d+)?)\s*(吨|t|kg|kgs|公斤|千克)/i);
        if (mCn || mStar || wm) {
          let l = null, w = null, h = null;
          if (mCn) {
            l = toCm(parseFloat(mCn[1]), mCn[2]);
            w = toCm(parseFloat(mCn[3]), mCn[4]);
            h = toCm(parseFloat(mCn[5]), mCn[6]);
          } else if (mStar) {
            const u = mStar[4] || null;
            l = toCm(parseFloat(mStar[1]), u);
            w = toCm(parseFloat(mStar[2]), u);
            h = toCm(parseFloat(mStar[3]), u);
          }
          const wt = wm ? parseFloat(wm[1]) * (['吨', 't'].includes(wm[2].toLowerCase()) ? 1000 : 1) : null;
          items.push({ length: l != null ? round1(l) : null, width: w != null ? round1(w) : null, height: h != null ? round1(h) : null, weight: wt });
        }
      }
      const dimRows = items.filter((it) => it.length && it.width && it.height)
        .map((it) => [it.length, it.width, it.height, girth(it.length, it.width, it.height)]);
      const weights = items.filter((it) => it.weight != null).map((it) => it.weight);

      const pc = text.match(/(?:总|共)?\s*件数\s*[:：]?\s*(\d+)\s*件/);
      if (pc) res.pieces = parseInt(pc[1], 10);
      else if (items.length > 1) res.pieces = items.length;

      if (dimRows.length) {
        if (dimRows.length === 1) {
          const [l, w, h, g] = dimRows[0];
          res.dims_cm = { length: l, width: w, height: h };
          if (g > 265) res.flags.push(`超长件：围长约 ${g.toFixed(0)}cm（>265cm），将加收超长费。`);
        } else {
          const rep = dimRows.reduce((a, b) => (b[3] > a[3] ? b : a));
          res.dims_cm = { length: rep[0], width: rep[1], height: rep[2] };
          res.flags.push(`检测到 ${dimRows.length} 件不同尺寸货物，已按最大尺寸（围长 ${rep[3].toFixed(0)}cm）估算报价；如需逐件精确请分开报价。`);
        }
      }
      if (weights.length) {
        if (weights.length === 1) res.weight_kg = weights[0];
        else { res.weight_kg = sumN(weights); res.flags.push(`检测到多行重量，已取总和 ${sumN(weights).toFixed(0)}kg（共 ${weights.length} 行）。`); }
      }
      res.items = items;

      // ---- 快速识别触发条件（对应《费用触发规则手册》） ----
      // 膏体 / 液体
      if (/膏体|软膏|膏状|paste|cream|gel/i.test(text)) {
        res.paste = true;
        res.flags.push('检测到膏体类货物：将加收膏体附加费 3–5元/kg（按重量计）。');
      }
      if (/液体|液态|液状|liquid/i.test(text)) {
        res.liquid = true;
        res.flags.push('检测到液体类货物：将加收液体附加费 3–5元/kg（按重量计）。');
      }
      // 高货值 / 高税率 / 高查验率 品类（仅包税渠道加收附加费）
      const HIGH_VALUE = ['3c', '智能', '手机', '平板', '笔记本', '电脑', '蓝牙', '电子', '电器', '数码', '相机', '耳机', '智能设备'];
      const HIGH_TAX = ['纺织品', '纺织', '服装', '衣服', '服饰', '布料', '鞋', '箱包', '钢', '铝', '五金', '家具'];
      const HIGH_CHECK = ['玩具', '婴儿', '婴童', '母婴', '儿童', '宝宝'];
      const tl = text.toLowerCase();
      if (HIGH_VALUE.some((k) => tl.includes(k.toLowerCase()))) {
        res.high_value = true;
        res.flags.push('高货值品类（3C/智能设备等）：若选包税渠道将加收高货值附加费 2–4元/kg。');
      }
      if (HIGH_TAX.some((k) => tl.includes(k.toLowerCase()))) {
        res.high_tax = true;
        res.flags.push('高税率品类（纺织品/钢铝等）：若选包税渠道将加收高税率附加费 2–4元/kg。');
      }
      if (HIGH_CHECK.some((k) => tl.includes(k.toLowerCase()))) {
        res.high_check = true;
        res.flags.push('高查验率品类（玩具/婴儿用品等）：若选包税渠道将加收高查验率附加费 2–4元/kg。');
      }
      // 强制认证（FDA/CPSC/EPA/CE/UL 等）
      const CERT = ['fda', 'cpsc', 'epa', 'ce', 'ul', 'rohs', 'ccc', '认证'];
      const certHit = CERT.filter((c) => {
        const re = new RegExp('(?<![A-Za-z])' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])', 'i');
        return re.test(text);
      }).map((c) => c.toUpperCase()).sort();
      if (certHit.length) {
        res.cert = certHit;
        res.flags.push('涉及强制认证（' + certHit.join('/') + '）：认证附加费需单询，请提供认证资料。');
      }
      // 需商检品类（食品/化妆品/医械等，买单报关需商检费）
      if (/食品|化妆品|医疗器械|保健品|药品|试剂|消毒/.test(text)) {
        res.ciq = true;
        res.flags.push('需商检品类（食品/化妆品/医械等）：若采用买单报关将加收商检费 800元/票，请确认报关方式。');
      }

      const negMag = /不带电磁|无电磁|不含电磁|非电磁|没有电磁|无磁|不带磁/.test(text);
      const negPow = /不带电|非电|无电池|不含电池|不带电池|没电池/.test(text);
      const mag = /带磁|磁性|磁铁|磁钢|magnetic/i.test(text);
      const pow_ = /带电|电池|内置电|充电|电源|锂电|battery|干电池|纽扣电池/i.test(text);
      res.magnetic = !!mag && !negMag;
      res.powered = !!pow_ && !negPow;
      res.electromagnetic = !!res.magnetic || !!res.powered;

      const SEA_CARD_CAT = ['铝门窗', '门窗', '铝型材', '型材', '阳光房', '大件家具', '大件'];
      const catHit = SEA_CARD_CAT.some((k) => text.includes(k));
      const sizeHit = items.some((it) => it.length && (it.length >= 200 || girth(it.length, it.width, it.height) >= 330));
      if (catHit || sizeHit) {
        res.is_sea_card = true;
        res.recommended_mode = '该货型建议走海卡（休斯顿专线等）公式报价方案';
        res.flags.push('已识别为海卡类大件：将按海卡公式方案报价（计费重=max(实重, Σ逐件材积重)，加派送/超长等固定附加费）。');
      } else {
        const lengthM = res.dims_cm ? res.dims_cm.length / 100 : 0;
        const heavy = (res.weight_kg || 0) > 30;
        const longItem = lengthM > 1.2 || (res.dims_cm && res.dims_cm.length > 120);
        if (heavy || longItem) {
          res.recommended_mode = '建议走海运 / 卡航等大件渠道（非快递）';
          if (longItem) res.flags.push(`超长/大件：单件长度约 ${lengthM.toFixed(2)}m，部分快递渠道不接收超长件。`);
          if (heavy) res.flags.push(`超重：${res.weight_kg}kg，建议走海运/卡航等大件渠道。`);
        } else {
          res.recommended_mode = '可走快递 / 空运等快线渠道';
        }
      }
      if (res.magnetic) res.flags.push('带磁货物：若走大陆起飞的空运渠道将加收磁检费 500元/票（香港/韩国起飞不收）。');
      if (res.powered) res.flags.push('带电/含电池货物：部分渠道受限，请确认是否可收运及是否需要电池申报。');
      if (!res.magnetic && !res.powered && (negMag || negPow)) res.flags.push('已标注「不带电磁/电池」，可按普通货物处理。');

      // 渠道预选（镜像后端 api_parse_intake）
      const chs = (this._prices.countries[country] || {}).channels || [];
      let pref = null;
      if (res.is_sea_card) pref = chs.find((c) => c.scheme === 'formula') || null;
      if (!pref && res.recommended_mode && res.recommended_mode.includes('海运')) pref = chs.find((c) => (c.name || '').includes('海') || (c.name || '').includes('卡航')) || null;
      const sel = pref || chs[0] || null;
      res.suggested_channel_code = sel ? sel.code : null;
      res.suggested_channel_name = sel ? sel.name : null;

      return res;
    },
  };

  return Engine;
});
