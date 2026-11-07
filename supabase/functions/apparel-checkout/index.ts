// apparel-checkout: turns a website workwear order into a Shopify draft order and returns its checkout link.
// The price is recalculated here with pricing.js (the browser's numbers are never trusted).
// Logo files go to the private "photos" bucket (orders/…); the draft order carries a signed link to each one.
// Shopify access: Dev Dashboard app "TBDezign Apparel Checkout" (write_draft_orders, read_orders, write_products, write_publications), client credentials grant.
// Two ways out: mode "cart" returns cart lines (price variants on hidden products) for /cart/add.js; otherwise a draft-order checkout link.
// Secrets: SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET. The token lasts 24h and is renewed here.
import "https://cdn.jsdelivr.net/gh/tbdezign/calculadoras@653f057/pricing.js";
const P = (globalThis as any).TBDPricing;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOP = (Deno.env.get("SHOPIFY_SHOP") || "").trim();
const CID = (Deno.env.get("SHOPIFY_CLIENT_ID") || "").trim();
const CSECRET = (Deno.env.get("SHOPIFY_CLIENT_SECRET") || "").trim();
const API_VERSION = "2026-10";

let tok = { v: "", exp: 0 };
async function token() {
  if (tok.v && Date.now() < tok.exp - 5 * 60 * 1000) return tok.v;
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CID, client_secret: CSECRET }),
  });
  if (!r.ok) throw new Error("shopify token " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  tok = { v: j.access_token, exp: Date.now() + (+j.expires_in || 86000) * 1000 };
  return tok.v;
}
async function gql(query: string, variables?: unknown, retry = true): Promise<any> {
  const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await token() },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  // a permission added later only shows up in a NEW token: drop the cached one and try once more
  if (j.errors && retry && JSON.stringify(j.errors).includes("ACCESS_DENIED")) { tok = { v: "", exp: 0 }; return gql(query, variables, false); }
  if (j.errors) throw new Error("shopify " + JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

async function products(method: string) {
  const r = await fetch(`${SB_URL}/rest/v1/apparel_products?method=eq.${method}&select=code,data`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error("products " + r.status);
  const out: Record<string, unknown> = {};
  for (const row of await r.json()) out[row.code] = row.data;
  return out;
}

// logo files: data URL → private storage + a signed link (1 year)
async function saveFile(folder: string, f: any, i: number) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(f.data || ""));
  if (!m) return null;
  const bytes = m[2] ? Uint8Array.from(atob(m[3]), c => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
  if (bytes.length > 15 * 1024 * 1024) return null;
  const safe = String(f.name || "logo").replace(/[^\w.\-]+/g, "_").slice(-80);
  const path = `orders/${folder}/${i + 1}-${String(f.role || "logo").replace(/\W+/g, "")}-${safe}`;
  const up = await fetch(`${SB_URL}/storage/v1/object/photos/${path}`, {
    method: "POST", headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": m[1] || "application/octet-stream", "x-upsert": "true" }, body: bytes,
  });
  if (!up.ok) throw new Error("upload " + up.status);
  const sg = await fetch(`${SB_URL}/storage/v1/object/sign/photos/${path}`, {
    method: "POST", headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 365 }),
  });
  const s = sg.ok ? await sg.json() : {};
  return { role: f.role || "logo", name: f.name || "logo", url: `${SB_URL}/functions/v1/apparel-checkout?logo=${folder}/${i + 1}`, long: s.signedURL ? `${SB_URL}/storage/v1${s.signedURL}` : path };
}

// ── Hidden products (one per style, one variant per color with its photo) so the checkout shows pictures.
// Rebuilt only when the style's colors or photos change (signature kept in shopify_styles). Any failure → plain line items.
async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  if (!r.ok) throw new Error(path.split("?")[0] + " " + r.status);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function stagePhoto(path: string, base: string) {
  const r = await fetch(`${SB_URL}/storage/v1/object/photos/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!r.ok) return null;
  return stageBytes(new Uint8Array(await r.arrayBuffer()), base);
}
// A color with no photo yet gets a plain shirt drawn in that color (so the cart never shows another color's picture).
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
async function shirtPng(hex: string) {
  const W = 480, H = 480, S = 8;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  const rgb = m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : [200, 205, 214];
  const light = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 200;
  const edge = rgb.map(v => Math.round(v * (light ? 0.78 : 0.8)));
  const bg = [243, 244, 246];
  // the cart's shirt outline (60×60 units), collar curve flattened
  const poly = [[20, 6], [6, 14], [11, 25], [17, 22], [17, 54], [43, 54], [43, 22], [49, 25], [54, 14], [40, 6], [38.5, 9], [35, 11.3], [30, 12], [25, 11.3], [21.5, 9]].map(([x, y]) => [x * S, y * S + 2 * S]);
  const inside = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const xs: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      if ((y1 <= y + 0.5 && y2 > y + 0.5) || (y2 <= y + 0.5 && y1 > y + 0.5)) xs.push(x1 + (y + 0.5 - y1) * (x2 - x1) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x < Math.min(W, xs[k + 1]); x++) inside[y * W + x] = 1;
  }
  const raw = new Uint8Array(H * (1 + W * 3)), T = 4;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && inside[y * W + x] === 1;
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    for (let x = 0; x < W; x++) {
      const isIn = inside[y * W + x] === 1, rim = isIn && !(at(x - T, y) && at(x + T, y) && at(x, y - T) && at(x, y + T));
      const c = !isIn ? bg : rim ? edge : rgb, o = y * (1 + W * 3) + 1 + x * 3;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer); dv.setUint32(0, W); dv.setUint32(4, H); ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let off = 0; for (const p of parts) { png.set(p, off); off += p.length; }
  return png;
}
async function stageBytes(bytes: Uint8Array, base: string) {
  const png = bytes[0] === 0x89 && bytes[1] === 0x50, webp = bytes[8] === 0x57 && bytes[9] === 0x45;
  const mime = png ? "image/png" : webp ? "image/webp" : "image/jpeg", filename = base + (png ? ".png" : webp ? ".webp" : ".jpg");
  const d = await gql(`mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`,
    { input: [{ filename, mimeType: mime, resource: "IMAGE", httpMethod: "POST", fileSize: String(bytes.length) }] });
  const t = d.stagedUploadsCreate.stagedTargets && d.stagedUploadsCreate.stagedTargets[0];
  if (!t) throw new Error("staged " + JSON.stringify(d.stagedUploadsCreate.userErrors).slice(0, 200));
  const form = new FormData();
  for (const p of t.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([bytes], { type: mime }), filename);
  const up = await fetch(t.url, { method: "POST", body: form });
  if (!up.ok) throw new Error("staged upload " + up.status);
  return t.resourceUrl;
}
// The cart needs the product published on the Online Store (app scope write_publications).
const ONLINE_STORE = "gid://shopify/Publication/167263797436";
async function publish(id: string) {
  try {
    const d = await gql(`mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`, { id, input: [{ publicationId: ONLINE_STORE }] });
    const e = d.publishablePublish.userErrors; if (e && e.length) { console.log("publish", JSON.stringify(e)); return false; }
    return true;
  } catch (e) { console.log("publish failed", String((e as Error).message || e)); return false; }
}
const patchStyle = (code: string, body: unknown) => rest(`shopify_styles?code=eq.${encodeURIComponent(code)}`, { method: "PATCH", body: JSON.stringify(body) });
const HIDDEN_SEO = [{ namespace: "seo", key: "hidden", type: "number_integer", value: "1" }];

// Options: Color + Unit. "Custom" variants (price 0) carry the photos for the draft-order checkout (priceOverride);
// "$12.40 each" variants are made on demand for the cart and reused by every order at that price.
async function ensureStyle(code: string, name: string, orderColors: string[]) {
  const [site] = await rest(`site_products?key=eq.${encodeURIComponent(code)}&select=data`);
  const [row] = await rest(`shopify_styles?code=eq.${encodeURIComponent(code)}&select=sig,variants,product_id,media,prices,published`);
  const prices: Record<string, any> = (row && row.prices) || {};
  const kept = Object.entries(prices).map(([k, v]) => ({ color: k.split("|")[0], label: k.split("|")[1], ...(v as any) }));
  const colors = [...new Set([...((site && site.data && site.data.colors) || []).filter((c: any) => c && c.on && c.name).map((c: any) => c.name), ...orderColors, ...kept.map(k => k.color)])];
  const photos = (await rest(`garment_photos?select=key,meta,updated_at`)).filter((p: any) => p.meta && p.meta.code === code && (p.meta.side || "front") === "front");
  const photoOf = (c: string) => photos.find((p: any) => String(p.meta.color || "").toLowerCase() === c.toLowerCase());
  const hexOf = (c: string) => (((site && site.data && site.data.colors) || []).find((x: any) => x && x.name === c) || {}).hex || "";
  const sig = "v3" + JSON.stringify(colors.map(c => [c, (photoOf(c) || {}).key || "", (photoOf(c) || {}).updated_at || "", photoOf(c) ? "" : hexOf(c)]));
  if (row && row.sig === sig) {
    if (!row.published && await publish(row.product_id)) { row.published = true; await patchStyle(code, { published: true }); }
    return row;
  }
  // photos: download from storage, upload to Shopify (staged upload), then attach by the staged URL
  const staged: Record<string, string> = {};
  for (const c of colors.filter(c => photoOf(c))) {
    try { const u = await stagePhoto(photoOf(c).key + ".img", `${code}-${c}`.replace(/[^\w\-]+/g, "_")); if (u) staged[c] = u; }
    catch (e) { console.log("photo upload failed", code, c, String((e as Error).message || e)); }
  }
  for (const c of colors.filter(c => !staged[c])) {
    try { const u = await stageBytes(await shirtPng(hexOf(c)), `${code}-${c}-plain`.replace(/[^\w\-]+/g, "_")); if (u) staged[c] = u; }
    catch (e) { console.log("plain shirt failed", code, c, String((e as Error).message || e)); }
  }
  const fileOf = (c: string) => staged[c] ? { originalSource: staged[c], contentType: "IMAGE", alt: `${name} — ${c}` } : null;
  const files = colors.map(fileOf).filter(Boolean);
  const units = ["Custom", ...new Set(kept.map(k => k.label))];
  const base = { taxable: true, inventoryPolicy: "CONTINUE", inventoryItem: { tracked: false, sku: code } };
  const d = await gql(`mutation($identifier: ProductSetIdentifiers, $input: ProductSetInput!) { productSet(synchronous: true, identifier: $identifier, input: $input) {
      product { id media(first: 100) { nodes { id alt } } variants(first: 250) { nodes { id selectedOptions { name value } } } } userErrors { field message } } }`, {
    identifier: { handle: "ww-" + code.toLowerCase() },
    input: {
      handle: "ww-" + code.toLowerCase(), title: name, status: "ACTIVE", vendor: "TBDezign", productType: "Custom workwear (checkout only)",
      tags: ["workwear-checkout"], files, metafields: HIDDEN_SEO,
      productOptions: [{ name: "Color", values: colors.map(c => ({ name: c })) }, { name: "Unit", values: units.map(u => ({ name: u })) }],
      variants: [
        ...colors.map(c => { const f = fileOf(c); return { optionValues: [{ optionName: "Color", name: c }, { optionName: "Unit", name: "Custom" }], price: "0.00", ...base, ...(f ? { file: f } : {}) }; }),
        // the price variants already in customers' carts stay (same id)
        ...kept.filter(k => k.id).map(k => ({ id: k.id, optionValues: [{ optionName: "Color", name: k.color }, { optionName: "Unit", name: k.label }], price: k.price, ...base })),
      ],
    },
  });
  const ps = d.productSet;
  if (ps.userErrors && ps.userErrors.length) throw new Error("productSet " + JSON.stringify(ps.userErrors).slice(0, 300));
  const media: Record<string, string> = {};
  for (const m of ps.product.media.nodes) for (const c of colors) if (staged[c] && m.alt === `${name} — ${c}`) media[c] = m.id;
  const variants: Record<string, string> = {};
  for (const v of ps.product.variants.nodes) {
    const o = Object.fromEntries(v.selectedOptions.map((x: any) => [x.name, x.value]));
    if (o.Unit === "Custom" && staged[o.Color]) variants[o.Color] = v.id;
    else if (o.Unit !== "Custom" && prices[o.Color + "|" + o.Unit]) prices[o.Color + "|" + o.Unit].id = v.id;
  }
  // price variants show the color's photo too
  const withPic = kept.filter(k => media[k.color] && prices[k.color + "|" + k.label] && prices[k.color + "|" + k.label].id);
  if (withPic.length) await gql(`mutation($p: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $p, variants: $v) { userErrors { field message } } }`,
    { p: ps.product.id, v: withPic.map(k => ({ id: prices[k.color + "|" + k.label].id, mediaId: media[k.color] })) }).catch(e => console.log("variant media", String(e)));
  const published = await publish(ps.product.id);
  const out = { code, sig, product_id: ps.product.id, variants, media, prices, published, updated_at: new Date().toISOString() };
  await rest(`shopify_styles?on_conflict=code`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(out) });
  return out;
}
// one variant per color + price, made the first time that price is needed
async function priceVariant(st: any, code: string, color: string, unit: number, label: string, opt = "Color", extra: Record<string, unknown> = {}) {
  const key = color + "|" + label;
  if (st.prices && st.prices[key] && st.prices[key].id) return st.prices[key].id;
  const optionValues = opt === "Color" ? [{ optionName: "Color", name: color }, { optionName: "Unit", name: label }] : [{ optionName: opt, name: label }];
  const make = (withPic: boolean) => gql(`mutation($p: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkCreate(productId: $p, variants: $v) { productVariants { id } userErrors { field message } } }`, {
    p: st.product_id,
    v: [{ optionValues, price: money(unit), taxable: true, inventoryPolicy: "CONTINUE", inventoryItem: { tracked: false, sku: code, ...extra }, ...(withPic && st.media && st.media[color] ? { mediaId: st.media[color] } : {}) }],
  });
  let r = (await make(true)).productVariantsBulkCreate;
  if (r.userErrors && r.userErrors.length && st.media && st.media[color]) { console.log("variant with photo failed, retry without", JSON.stringify(r.userErrors).slice(0, 200)); r = (await make(false)).productVariantsBulkCreate; }
  if (r.userErrors && r.userErrors.length) throw new Error("variant " + JSON.stringify(r.userErrors).slice(0, 300));
  const id = r.productVariants[0].id;
  st.prices = { ...(st.prices || {}), [key]: { id, price: money(unit), at: new Date().toISOString() } };
  await patchStyle(st.code || code, { prices: st.prices });
  return id;
}
// the one-time fee (screen setup / digitizing) as its own hidden product, no shipping
async function ensureSetup() {
  const [row] = await rest(`shopify_styles?code=eq._setup&select=code,sig,product_id,media,prices,published`);
  if (row && row.sig === "setup-v1") {
    if (!row.published && await publish(row.product_id)) { row.published = true; await patchStyle("_setup", { published: true }); }
    return row;
  }
  const d = await gql(`mutation($identifier: ProductSetIdentifiers, $input: ProductSetInput!) { productSet(synchronous: true, identifier: $identifier, input: $input) { product { id } userErrors { field message } } }`, {
    identifier: { handle: "ww-setup" },
    input: { handle: "ww-setup", title: "One-time setup", status: "ACTIVE", vendor: "TBDezign", productType: "Custom workwear (checkout only)", tags: ["workwear-checkout"], metafields: HIDDEN_SEO,
      productOptions: [{ name: "Type", values: [{ name: "One-time" }] }],
      variants: [{ optionValues: [{ optionName: "Type", name: "One-time" }], price: "0.00", taxable: true, inventoryPolicy: "CONTINUE", inventoryItem: { tracked: false, requiresShipping: false } }] },
  });
  const ps = d.productSet;
  if (ps.userErrors && ps.userErrors.length) throw new Error("setup " + JSON.stringify(ps.userErrors).slice(0, 300));
  const out = { code: "_setup", sig: "setup-v1", product_id: ps.product.id, variants: {}, media: {}, prices: {}, published: await publish(ps.product.id), updated_at: new Date().toISOString() };
  await rest(`shopify_styles?on_conflict=code`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(out) });
  return out;
}

const cleanName = (n: string) => String(n || "").replace(/\s*[®™]/g, "").replace(/\s+/g, " ").trim();
const SIZE_LABEL: Record<string, string> = { std: "", x2: "2XL", x3: "3XL" };
const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const clip = (s: unknown, n = 500) => String(s ?? "").slice(0, n);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") {
    // short link to an order's logo file: ?logo=<folder>/<n> → fresh signed link (the order notes stay readable)
    const lg = new URL(req.url).searchParams.get("logo");
    if (lg) {
      const m = /^(\d{4}-\d{2}-\d{2}-[0-9a-f]{8})\/(\d{1,2})$/.exec(lg);
      if (!m) return json({ error: "not found" }, 404);
      const ls = await fetch(`${SB_URL}/storage/v1/object/list/photos`, { method: "POST", headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ prefix: `orders/${m[1]}/`, limit: 20 }) });
      const f = ls.ok ? (await ls.json()).find((x: any) => String(x.name).startsWith(m[2] + "-")) : null;
      if (!f) return json({ error: "not found" }, 404);
      const sg = await fetch(`${SB_URL}/storage/v1/object/sign/photos/orders/${m[1]}/${f.name}`, { method: "POST", headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 600 }) });
      const s = sg.ok ? await sg.json() : null;
      if (!s || !s.signedURL) return json({ error: "not found" }, 404);
      return new Response(null, { status: 302, headers: { ...CORS, Location: `${SB_URL}/storage/v1${s.signedURL}` } });
    }
    // an order that is in a cart: the page reopens it for editing (?order=<ref>)
    const ref = new URL(req.url).searchParams.get("order");
    if (ref) {
      if (!/^[0-9a-f]{10}$/.test(ref)) return json({ error: "not found" }, 404);
      const [o] = await rest(`cart_orders?ref=eq.${ref}&select=state,files`);
      return o ? json(o) : json({ error: "not found" }, 404);
    }
    // health check: are the Shopify credentials working? (shows only the store name)
    try { const d = await gql("{ shop { name } }"); return json({ ok: true, shop: d.shop.name }); }
    catch (e) { return json({ ok: false, error: String((e as Error).message || e) }, 500); }
  }
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const order = body && body.order, d = (body && body.details) || {};
  if (!order || !Array.isArray(order.items) || !order.items.length || order.items.length > 50) return json({ error: "items required" }, 400);
  if (order.method && !["silk", "dtf", "emb"].includes(order.method)) return json({ error: "unknown method" }, 400);
  try {
    // 1. price again on the server
    const total = order.items.reduce((s: number, it: any) => s + (+it?.qty?.std || 0) + (+it?.qty?.x2 || 0) + (+it?.qty?.x3 || 0), 0);
    const method = order.method || P.chooseMethod({ deco: order.deco, logoType: order.logoType, colors: order.colors, mixedShades: !!order.mixedShades, total });
    const q = P.quoteOrder({ ...order, method }, { [method]: await products(method) });
    if (q.errors.length) return json({ error: "pricing", detail: q.errors }, 400);

    // 2. logo files
    const folder = new Date().toISOString().slice(0, 10) + "-" + crypto.randomUUID().slice(0, 8);
    const files = [];
    for (const [i, f] of (Array.isArray(body.files) ? body.files.slice(0, 6) : []).entries()) { const s = await saveFile(folder, f, i); if (s) files.push(s); }
    // editing an order from the cart: files already uploaded are kept (only our own short links are accepted)
    if (Array.isArray(body.keep)) for (const k of body.keep.slice(0, 6)) {
      if (k && typeof k.url === "string" && k.url.startsWith(`${SB_URL}/functions/v1/apparel-checkout?logo=`) && !files.some((f: any) => f.role === k.role))
        files.push({ role: clip(k.role, 40), name: clip(k.name, 120), url: k.url, long: "" });
    }

    // 3. draft order
    const sizesOf = (code: string, color: string, size: string) => {
      const it = (d.items || []).find((x: any) => x && x.code === code && x.color === color);
      if (!it || !it.sizes) return "";
      const pick = Object.entries(it.sizes).filter(([k, v]) => +(v as number) > 0 && (size === "std" ? !/^(2XL|3XL|4XL|5XL)$/.test(k) : size === "x2" ? k === "2XL" : /^(3XL|4XL|5XL)$/.test(k)));
      return pick.map(([k, v]) => k + " × " + v).join(", ");
    };
    const NAMES: Record<string, string> = { silk: "Silk Screen", dtf: "DTF print", emb: "Embroidery" };
    // what the customer (and the supplier order) needs to see under each shirt
    const lineProps = (l: any, sz: string) => [
      ["Sizes", sz || SIZE_LABEL[l.size] || ""],
      ["Decoration", NAMES[method]],
      ["Logo", clip(d.placement, 120)],
      ...((d.colorNotes && Array.isArray(d.colorNotes[l.color])) ? d.colorNotes[l.color].slice(0, 2).filter((x: any) => Array.isArray(x) && x[0] && x[1]).map((x: any) => [clip(x[0], 30), clip(x[1], 120)]) : []),
      ...(Array.isArray(d.lineNotes) ? d.lineNotes.slice(0, 3).filter((x: any) => Array.isArray(x) && x[0] && x[1]).map((x: any) => [clip(x[0], 30), clip(x[1], 120)]) : []),
      ["Price per piece", "$" + money(l.unit)],
    ].filter(([, v]) => v).map(([key, value]) => ({ key, value }));
    // ── cart: one variant per color + price on the hidden product, the page adds them with /cart/add.js ──
    if (body.mode === "cart") try {
      const ref = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
      const sts: Record<string, any> = {};
      for (const code of [...new Set(q.lines.map((l: any) => l.code))] as string[]) {
        const ls = q.lines.filter((l: any) => l.code === code);
        sts[code] = await ensureStyle(code, cleanName(ls[0].name), [...new Set(ls.map((l: any) => l.color).filter(Boolean))] as string[]);
      }
      const setup = q.setup > 0 ? await ensureSetup() : null;
      // not on the Online Store yet (missing app permission): the page falls back to the direct checkout
      if (Object.values(sts).some((st: any) => !st.published) || (setup && !setup.published)) return json({ fallback: true, reason: "not published" });
      const num = (gid: string) => +String(gid).split("/").pop()!;
      const items: any[] = [];
      for (const l of q.lines) {
        const vid = await priceVariant(sts[l.code], l.code, l.color, l.unit, "$" + money(l.unit) + " each");
        const props: Record<string, string> = {};
        for (const p of lineProps(l, sizesOf(l.code, l.color, l.size))) if (p.key !== "Price per piece") props[p.key as string] = p.value as string;
        const it = (d.items || []).find((x: any) => x && x.code === l.code && x.color === l.color);
        props._ww = ref; if (it && it.hex) props._hex = clip(it.hex, 9);
        items.push({ id: num(vid), quantity: l.q, properties: props });
      }
      if (setup) {
        const label = (method === "emb" ? "Digitizing" : "Screen setup") + " · $" + money(q.setup);
        const vid = await priceVariant(setup, "SETUP", "", q.setup, label, "Type", { requiresShipping: false });
        items.push({ id: num(vid), quantity: 1, properties: { _ww: ref, _fee: "1" } });
      }
      const info = [
        "Method: " + NAMES[method], "Placement: " + clip(d.placement, 200), "Logo: " + clip(d.logo, 300),
        "Reorder: " + (order.reorder ? "Yes" + (order.reorderNo ? " — previous order " + clip(order.reorderNo, 40) : "") : "No"),
        ...(d.notes ? ["Notes: " + clip(d.notes, 1000)] : []),
        ...(files.length ? files.map((f: any) => `Logo file (${f.role}): ${f.url}`) : ["No logo file attached — ask the customer for it."]),
      ].join("\n");
      await rest(`cart_orders`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ ref, state: body.state && typeof body.state === "object" ? body.state : null, files: files.map((f: any) => ({ role: f.role, name: f.name, url: f.url })), total: q.total$ }) });
      return json({ ok: true, ref, items, attributes: { ["Custom shirts " + ref]: info }, total: q.total$ });
    } catch (e) {
      // anything wrong on the cart side: the page falls back to the direct checkout
      console.log("cart failed", String((e as Error).message || e));
      return json({ fallback: true, reason: String((e as Error).message || e).slice(0, 200) });
    }
    // hidden products for the photos (best effort)
    const vmap: Record<string, Record<string, string>> = {};
    for (const code of [...new Set(q.lines.map((l: any) => l.code))] as string[]) {
      const ls = q.lines.filter((l: any) => l.code === code);
      try { vmap[code] = (await ensureStyle(code, cleanName(ls[0].name), [...new Set(ls.map((l: any) => l.color).filter(Boolean))] as string[])).variants; }
      catch (e) { console.log("no photo product for", code, String((e as Error).message || e)); }
    }
    const lineItems: any[] = q.lines.map((l: any) => {
      const sz = sizesOf(l.code, l.color, l.size), vid = vmap[l.code] && vmap[l.code][l.color];
      if (vid) return {
        variantId: vid, quantity: l.q,
        priceOverride: { amount: money(l.unit), currencyCode: "USD" },
        customAttributes: lineProps(l, sz),
      };
      return {
        title: `${cleanName(l.name)} — ${l.color || ""}${SIZE_LABEL[l.size] ? " (" + SIZE_LABEL[l.size] + ")" : ""} · ${NAMES[method]}`,
        sku: l.code, quantity: l.q, requiresShipping: true, taxable: true,
        originalUnitPriceWithCurrency: { amount: money(l.unit), currencyCode: "USD" },
        customAttributes: lineProps(l, sz),
      };
    });
    if (q.setup > 0) lineItems.push({
      title: (method === "emb" ? "Digitizing" : "Screen setup") + " (one-time)", quantity: 1, requiresShipping: false, taxable: true,
      originalUnitPriceWithCurrency: { amount: money(q.setup), currencyCode: "USD" },
    });
    const attrs: [string, string][] = [
      ["Method", NAMES[method]],
      ["Logo placement", clip(d.placement, 200)],
      ["Logo", clip(d.logo, 300)],
      ["Reorder", order.reorder ? "Yes" + (order.reorderNo ? " — previous order " + clip(order.reorderNo, 40) : "") : "No"],
      ["Notes", clip(d.notes, 1000)],
      ...files.map(f => [`Logo file (${f.role})`, f.url] as [string, string]),
    ];
    // short note (details are under Additional details): the logo files to download
    const note = files.length ? files.map(f => `Logo (${f.role}): ${f.name}\n${f.url}`).join("\n") : "No logo file attached — ask the customer for it.";
    const res = await gql(`mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id name invoiceUrl totalPriceSet { shopMoney { amount } } } userErrors { field message } } }`, {
      input: {
        lineItems, note, tags: ["workwear-site", NAMES[method]],
        customAttributes: attrs.filter(([, v]) => v).map(([key, value]) => ({ key, value })),
        shippingLine: { title: "Free shipping", priceWithCurrency: { amount: "0.00", currencyCode: "USD" } },
      },
    });
    const r = res.draftOrderCreate;
    if (r.userErrors && r.userErrors.length) return json({ error: "shopify", detail: r.userErrors }, 400);
    return json({ ok: true, name: r.draftOrder.name, invoiceUrl: r.draftOrder.invoiceUrl, total: q.total$ });
  } catch (e) {
    return json({ error: "checkout failed", detail: String((e as Error).message || e) }, 500);
  }
});
