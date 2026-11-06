// apparel-checkout: turns a website workwear order into a Shopify draft order and returns its checkout link.
// The price is recalculated here with pricing.js (the browser's numbers are never trusted).
// Logo files go to the private "photos" bucket (orders/…); the draft order carries a signed link to each one.
// Shopify access: Dev Dashboard app "TBDezign Apparel Checkout" (write_draft_orders, read_orders), client credentials grant.
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
  return { role: f.role || "logo", name: f.name || "logo", url: s.signedURL ? `${SB_URL}/storage/v1${s.signedURL}` : path };
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
  const bytes = new Uint8Array(await r.arrayBuffer());
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
async function ensureStyle(code: string, name: string, orderColors: string[]) {
  const [site] = await rest(`site_products?key=eq.${encodeURIComponent(code)}&select=data`);
  const colors = [...new Set([...((site && site.data && site.data.colors) || []).filter((c: any) => c && c.on && c.name).map((c: any) => c.name), ...orderColors])];
  const photos = (await rest(`garment_photos?select=key,meta,updated_at`)).filter((p: any) => p.meta && p.meta.code === code && (p.meta.side || "front") === "front");
  const photoOf = (c: string) => photos.find((p: any) => String(p.meta.color || "").toLowerCase() === c.toLowerCase());
  const sig = JSON.stringify(colors.map(c => [c, (photoOf(c) || {}).key || "", (photoOf(c) || {}).updated_at || ""]));
  const [row] = await rest(`shopify_styles?code=eq.${encodeURIComponent(code)}&select=sig,variants`);
  if (row && row.sig === sig && orderColors.every(c => row.variants[c])) return row.variants;
  // photos: download from storage, upload to Shopify (staged upload), then attach by the staged URL
  const staged: Record<string, string> = {};
  for (const c of colors.filter(c => photoOf(c))) {
    try { const u = await stagePhoto(photoOf(c).key + ".img", `${code}-${c}`.replace(/[^\w\-]+/g, "_")); if (u) staged[c] = u; }
    catch (e) { console.log("photo upload failed", code, c, String((e as Error).message || e)); }
  }
  const fileOf = (c: string) => staged[c] ? { originalSource: staged[c], contentType: "IMAGE", alt: `${name} — ${c}` } : null;
  const files = colors.map(fileOf).filter(Boolean);
  const d = await gql(`mutation($identifier: ProductSetIdentifiers, $input: ProductSetInput!) { productSet(synchronous: true, identifier: $identifier, input: $input) {
      product { id variants(first: 250) { nodes { id selectedOptions { name value } } } } userErrors { field message } } }`, {
    identifier: { handle: "ww-" + code.toLowerCase() },
    input: {
      handle: "ww-" + code.toLowerCase(), title: name, status: "ACTIVE", vendor: "TBDezign", productType: "Custom workwear (checkout only)",
      tags: ["workwear-checkout"], files,
      productOptions: [{ name: "Color", values: colors.map(c => ({ name: c })) }],
      variants: colors.map(c => {
        const f = fileOf(c);
        return { optionValues: [{ optionName: "Color", name: c }], price: "0.00", sku: code, taxable: true, inventoryPolicy: "CONTINUE", inventoryItem: { tracked: false }, ...(f ? { file: f } : {}) };
      }),
    },
  });
  const ps = d.productSet;
  if (ps.userErrors && ps.userErrors.length) throw new Error("productSet " + JSON.stringify(ps.userErrors).slice(0, 300));
  const variants: Record<string, string> = {};
  for (const v of ps.product.variants.nodes) { const o = v.selectedOptions.find((x: any) => x.name === "Color"); if (o) variants[o.value] = v.id; }
  await rest(`shopify_styles?on_conflict=code`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ code, sig, product_id: ps.product.id, variants, updated_at: new Date().toISOString() }) });
  return variants;
}

const cleanName = (n: string) => String(n || "").replace(/\s*[®™]/g, "").replace(/\s+/g, " ").trim();
const SIZE_LABEL: Record<string, string> = { std: "", x2: "2XL", x3: "3XL" };
const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const clip = (s: unknown, n = 500) => String(s ?? "").slice(0, n);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") {
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
      ...(Array.isArray(d.lineNotes) ? d.lineNotes.slice(0, 3).filter((x: any) => Array.isArray(x) && x[0] && x[1]).map((x: any) => [clip(x[0], 30), clip(x[1], 120)]) : []),
      ["Price per piece", "$" + money(l.unit)],
    ].filter(([, v]) => v).map(([key, value]) => ({ key, value }));
    // hidden products for the photos (best effort)
    const vmap: Record<string, Record<string, string>> = {};
    for (const code of [...new Set(q.lines.map((l: any) => l.code))] as string[]) {
      const ls = q.lines.filter((l: any) => l.code === code);
      try { vmap[code] = await ensureStyle(code, cleanName(ls[0].name), [...new Set(ls.map((l: any) => l.color).filter(Boolean))] as string[]); }
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
      ...files.map((f, i) => [`File ${i + 1} (${f.role})`, f.url] as [string, string]),
    ];
    const note = [
      "Website workwear order — " + NAMES[method] + ", " + total + " pcs.",
      d.placement ? "Placement: " + clip(d.placement, 200) : "",
      d.logo ? "Logo: " + clip(d.logo, 300) : "",
      d.notes ? "Notes: " + clip(d.notes, 1000) : "",
      files.length ? "Files:\n" + files.map(f => `- ${f.role}: ${f.name}\n  ${f.url}`).join("\n") : "No logo file attached.",
    ].filter(Boolean).join("\n");
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
