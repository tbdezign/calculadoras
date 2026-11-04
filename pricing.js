/* TBDezign apparel pricing — the ONE place the price formulas live.
 * Used by: Apparel Quotes (calculator), the workwear order page on tbdezign.com, and the quote agent.
 * Change a formula or a rate here and every place that prices apparel changes with it.
 * After any change: run the price tests (same orders, same prices) before publishing.
 */
(function (root) {
  "use strict";
  const ceil10 = n => Math.ceil(n * 10) / 10;    // Silk Screen + Embroidery: round UP to $0.10
  const round10 = n => Math.round(n * 10) / 10;  // DTF Vendor 1 + Vendor 2: round to the NEAREST $0.10

  // Rates and fixed amounts. (Later these can be edited from the database without touching code.)
  const CONFIG = {
    freeShipMin: 200,   // blanks from one supplier at this amount or more ship free
    silk: {
      rates: { 1: 1.10, 2: 1.30, 3: 1.50, 4: 1.50 },  // vendor price per piece, per spot
      mins:  { 1: 24, 2: 24, 3: 36, 4: 48 },           // vendor minimum (charged even if fewer pieces)
      screen: 15, shipIn: 30, shipOut: 25,
      minPieces: 10, tiers: [10, 15, 20, 25], days: [7, 12],
    },
    dtf: {
      placements: {
        lc:         { vendorCost: 3.5,  retail: 8 },
        front:      { vendorCost: 7,    retail: 15 },
        back:       { vendorCost: 7,    retail: 15 },
        front_back: { vendorCost: 14,   retail: 30 },
        lc_fb:      { vendorCost: 10.5, retail: 20 },
      },
      extra: { small: { vendorCost: 3.5, retail: 8 }, large: { vendorCost: 7, retail: 15 } },  // small = up to 4x4 in
      shipIn: 30, shipOut: 20,
      minPieces: 4, tiers: [4, 8, 16, 32], days: [7, 12],
    },
    emb: {
      rate: 4, digCost: 5, digRetail: 20, suppShip: 30, clientShip: 25,
      minPieces: 6, tiers: [6, 12, 24, 48], days: [7, 10],
    },
    v2: { blindShip: 10, shipping: 16, shipThreshold: 59, tiers: [2, 4, 8, 16] },
  };

  // ── Silk Screen: blank ÷ divisor + supplier shipping, print = vendor rate × spots × 2 (vendor minimum absorbed) + client shipping
  function silk(a, cfg) {
    const S = (cfg || CONFIG).silk;
    const tq = a.tq, shipQty = a.shipQty || tq, shipIn = a.shipIn == null ? S.shipIn : a.shipIn;
    const rate = S.rates[a.colors], minQ = S.mins[a.colors], totalSpots = a.spots;
    const divisor = a.blankCost < 3 ? 0.50 : 0.55;
    const blankRetail = ceil10(a.blankCost / divisor + shipIn / shipQty);
    const printCostVendor = tq < minQ ? (rate * minQ * totalSpots) / tq : rate * totalSpots;
    const printAddon = ceil10(printCostVendor * 2 + S.shipOut / tq);
    const perPiece = blankRetail + printAddon;
    const unitCost = a.blankCost + shipIn / shipQty + printCostVendor + S.shipOut / tq;
    return { perPiece, unitCost, divisor, shipQty, shipIn, blankRetail, printAddon };
  }
  function silkSetup(colors, spots, cfg) { return colors * spots * (cfg || CONFIG).silk.screen; }

  // ── DTF Vendor 1: blank ÷ divisor + supplier shipping + placement retail + extra spots + client shipping
  // a.pl = { vendorCost, retail }; a.extras = list of extra spot sizes ("small" | "large")
  function dtf(a, cfg) {
    const D = (cfg || CONFIG).dtf;
    const tq = a.tq, shipQty = a.shipQty || tq, shipIn = a.shipIn == null ? D.shipIn : a.shipIn;
    const extras = a.extras || [];
    const exRetail = extras.reduce((s, z) => s + D.extra[z || "small"].retail, 0);
    const exCost = extras.reduce((s, z) => s + D.extra[z || "small"].vendorCost, 0);
    const divisor = a.cost < 3 ? 0.5 : 0.55;
    const blankRetail = a.cost / divisor + shipIn / shipQty;
    const printAddon = a.pl.retail + exRetail + D.shipOut / tq;
    const totalRetail = round10(blankRetail + printAddon);
    const totalCost = a.cost + a.pl.vendorCost + exCost + shipIn / shipQty + D.shipOut / tq;
    return { perPiece: totalRetail, unitCost: totalCost, divisor, shipQty, shipIn };
  }

  // ── Embroidery: blank × 2 + rate × 2 per spot + (supplier + client shipping) ÷ pieces; shipping is pass-through
  function emb(a, cfg) {
    const E = (cfg || CONFIG).emb;
    const spots = 1 + (a.extra || 0);
    const rate = a.rate == null ? E.rate : a.rate;
    const suppShip = a.suppShip == null ? E.suppShip : a.suppShip, clientShip = a.clientShip == null ? E.clientShip : a.clientShip;
    const ship = (suppShip + clientShip) / a.tq;
    const rp = ceil10((a.blank * 2) + (rate * 2 * spots) + ship);
    const cp = a.blank + rate * spots + ship;
    return { perPiece: rp, unitCost: cp };
  }

  // ── DTF / Embroidery Vendor 2 (tier price from the vendor; fees split across pieces)
  function v2Tier(qty, cfg) { const T = (cfg || CONFIG).v2.tiers; for (let i = T.length - 1; i >= 0; i--) if (qty >= T[i]) return T[i]; return T[0]; }
  function v2Fees(vendorSub, protection, cfg) { const V = (cfg || CONFIG).v2; const ship = vendorSub < V.shipThreshold ? V.shipping : 0; return { ship, fees: ship + V.blindShip + (parseFloat(protection) || 0) }; }
  function v2Base(vp) { return vp >= 20 ? vp / 0.55 : vp * 2; }
  function v2Price(vp, feesPerUnit) { return round10(v2Base(vp) + feesPerUnit); }

  // ── Which method fits the order (Thamires's rule)
  // embroidered → Embroidery; printed + solid colors (≤3) + 10+ pieces → Silk Screen; anything else printed → DTF.
  function chooseMethod(o, cfg) {
    const C = cfg || CONFIG;
    if (o.deco === "emb") return "emb";
    if (o.logoType === "solid" && (o.colors || 1) <= 3 && o.total >= C.silk.minPieces) return "silk";
    return "dtf";
  }

  // ── Whole order, as the website and the agent send it ──
  // order = { method?, deco, logoType, colors, placement: lc|lcb|ff|bk|fb|other, otherSpots: ["small"|"large",…], sleeves: 0|1|2,
  //           items: [{ code, color, qty: { std, x2, x3 } }] }
  // products = { silk: {CODE: product}, dtf: {...}, emb: {...} } (from the database)
  const SITE_PLACE = {
    lc:  { sides: 1, dtf: "lc" },
    lcb: { sides: 2, dtf: "lc_fb" },
    ff:  { sides: 1, dtf: "front" },
    bk:  { sides: 1, dtf: "back" },
    fb:  { sides: 2, dtf: "front_back" },
  };
  const CAP_WORDS = /\b(cap|caps|bon[eé]s?|hat|hats|snapback|trucker|visor|beanie)\b/i;
  const SIZE_FIELDS = { silk: { std: "costStd", x2: "cost2xl", x3: "cost3xl" }, emb: { std: "cStd", x2: "c2xl", x3: "c3xl" } };
  function blankCost(method, p, size) {
    if (method === "dtf") return p.cost || 0;
    const f = SIZE_FIELDS[method]; return p[f[size || "std"]] || p[f.std] || 0;
  }
  function quoteOrder(order, products, cfg) {
    const C = cfg || CONFIG;
    const items = (order.items || []).map(it => ({ ...it, qty: { std: +((it.qty || {}).std) || 0, x2: +((it.qty || {}).x2) || 0, x3: +((it.qty || {}).x3) || 0 } }));
    const pcs = it => it.qty.std + it.qty.x2 + it.qty.x3;
    const total = items.reduce((s, it) => s + pcs(it), 0);
    const method = order.method || chooseMethod({ deco: order.deco, logoType: order.logoType, colors: order.colors, total }, C);
    const cat = (products || {})[method] || {};
    const missing = items.filter(it => !cat[String(it.code).toUpperCase()]).map(it => it.code);
    // Caps are priced differently in the calculator (side/back spots, no sleeves): not sold through this order flow yet.
    const caps = items.filter(it => { const p = cat[String(it.code).toUpperCase()]; return p && CAP_WORDS.test((p.name || "") + " " + (p.desc || "")); }).map(it => it.code);
    const out = { method, total, minPieces: C[method].minPieces, days: C[method].days, lines: [], subtotal: 0, setup: 0, setupLabel: "", total$: 0, cost: 0, errors: [] };
    if (missing.length) out.errors.push("unknown product: " + missing.join(", "));
    if (caps.length) out.errors.push("caps are quoted by hand: " + caps.join(", "));
    if (total < C[method].minPieces) out.errors.push("below minimum: " + C[method].minPieces + " pieces");
    if (!total || out.errors.length) return out;

    const sleeves = Math.max(0, Math.min(2, +order.sleeves || 0));
    const other = order.placement === "other";
    const otherSpots = other ? (order.otherSpots && order.otherSpots.length ? order.otherSpots.slice(0, 4) : ["small"]) : [];
    const place = other ? null : (SITE_PLACE[order.placement] || SITE_PLACE.lc);

    // Supplier shipping is free when all blanks together reach freeShipMin.
    const blanks = items.reduce((s, it) => { const p = cat[String(it.code).toUpperCase()]; return s + ["std", "x2", "x3"].reduce((a, z) => a + blankCost(method, p, z) * it.qty[z], 0); }, 0);
    const waived = blanks >= C.freeShipMin;

    let spotsForSetup = 0;
    items.forEach(it => {
      const p = cat[String(it.code).toUpperCase()];
      ["std", "x2", "x3"].forEach(size => {
        const q = it.qty[size]; if (!q) return;
        let r;
        if (method === "silk") {
          const spots = (other ? otherSpots.length : place.sides) + sleeves;
          spotsForSetup = spots;
          r = silk({ blankCost: blankCost("silk", p, size), tq: total, shipQty: total, shipIn: waived ? 0 : C.silk.shipIn, colors: Math.max(1, Math.min(3, +order.colors || 1)), spots }, C);
        } else if (method === "dtf") {
          let pl, extras;
          if (other) { pl = C.dtf.extra[otherSpots[0] || "small"]; extras = otherSpots.slice(1); }
          else { pl = C.dtf.placements[place.dtf]; extras = []; }
          for (let i = 0; i < sleeves; i++) extras.push("small");
          r = dtf({ cost: blankCost("dtf", p), pl, tq: total, shipQty: total, extras, shipIn: waived ? 0 : C.dtf.shipIn }, C);
        } else {
          const extra = (other ? otherSpots.length - 1 : 0) + sleeves;
          spotsForSetup = 1 + extra;
          r = emb({ blank: blankCost("emb", p, size), tq: total, extra, suppShip: waived ? 0 : C.emb.suppShip }, C);
        }
        out.lines.push({ code: p.code, name: p.name, color: it.color || "", size, q, unit: r.perPiece, amount: Math.round(r.perPiece * q * 100) / 100 });
        out.subtotal += r.perPiece * q; out.cost += r.unitCost * q;
      });
    });
    if (method === "silk") { const colors = Math.max(1, Math.min(3, +order.colors || 1)); out.setup = silkSetup(colors, spotsForSetup, C); out.setupLabel = "Screen setup"; }
    if (method === "emb") { out.setup = spotsForSetup * C.emb.digRetail; out.cost += spotsForSetup * C.emb.digCost; out.setupLabel = "Digitizing"; }
    out.subtotal = Math.round(out.subtotal * 100) / 100;
    out.total$ = Math.round((out.subtotal + out.setup) * 100) / 100;
    out.cost = Math.round(out.cost * 100) / 100;
    if (other) out.note = "Other placement: confirm the price difference with the client.";
    return out;
  }

  const api = { CONFIG, ceil10, round10, silk, silkSetup, dtf, emb, v2Tier, v2Fees, v2Base, v2Price, chooseMethod, quoteOrder, blankCost };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.TBDPricing = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
