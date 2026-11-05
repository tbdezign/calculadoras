// apparel-quote: prices a workwear order with the SAME pricing.js the calculators use.
// Public (the website calls it). Returns retail prices only — never costs, vendors or memos.
import "./pricing.js";
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

async function products(method: string) {
  const r = await fetch(`${SB_URL}/rest/v1/apparel_products?method=eq.${method}&select=code,data`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error("products " + r.status);
  const rows = await r.json();
  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.code] = row.data;
  return out;
}

async function rest(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!r.ok) throw new Error(path.split("?")[0] + " " + r.status);
  return r.json();
}
const inList = (codes: string[]) => "(" + codes.map(c => '"' + c.replace(/"/g, "") + '"').join(",") + ")";
const cleanName = (n: string) => String(n || "").replace(/\s*[®™]/g, "").replace(/\s+/g, " ").trim();

// GET: the website catalog. Only styles marked "Show on site" in the calculator, only colors marked "On site".
// Prices are the "from" price (25 pcs, 1-color left chest, Silk Screen) — no costs.
async function catalog() {
  const site = await rest("site_products?show=eq.true&select=key,data");
  const codes = site.map((r: any) => r.key);
  if (!codes.length) return { styles: [] };
  const [prods, photos] = await Promise.all([
    rest(`apparel_products?code=in.${inList(codes)}&method=in.(silk,dtf,emb)&select=method,code,data`),
    rest(`garment_photos?select=key,meta`),
  ]);
  const by: Record<string, Record<string, any>> = {};
  for (const r of prods) (by[r.code] ||= {})[r.method] = r.data;
  const pics = photos.filter((p: any) => p.meta && codes.includes(p.meta.code));
  let signed: Record<string, string> = {};
  if (pics.length) {
    const r = await fetch(`${SB_URL}/storage/v1/object/sign/photos`, {
      method: "POST", headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 60 * 60 * 24, paths: pics.map((p: any) => p.key + ".img") }),
    });
    if (r.ok) for (const x of await r.json()) if (x.signedURL) signed[x.path] = `${SB_URL}/storage/v1${x.signedURL}`;
  }
  const styles = site.map((s: any) => {
    const m = by[s.key] || {};
    const base = m.silk || m.dtf || m.emb;
    if (!base) return null;
    let from = null;
    const meth = m.silk ? "silk" : m.dtf ? "dtf" : "emb";
    try {
      const q = P.quoteOrder({ method: meth, colors: 1, placement: "lc", items: [{ code: s.key, qty: { std: 25 } }] }, { [meth]: { [s.key]: base } });
      from = q.lines[0] ? q.lines[0].unit : null;
    } catch { /* leave empty */ }
    const d = s.data || {};
    return {
      code: s.key, name: cleanName(base.name), type: d.type || "", fit: d.fit || "", material: d.material || "",
      description: base.desc_en || "",
      methods: ["silk", "dtf", "emb"].filter(k => m[k]),
      colors: (d.colors || []).filter((c: any) => c && c.on && c.name).map((c: any) => ({ name: c.name, hex: c.hex })),
      photos: pics.filter((p: any) => p.meta.code === s.key && signed[p.key + ".img"])
        .map((p: any) => ({ color: p.meta.color, side: p.meta.side, url: signed[p.key + ".img"], place: p.meta.place || {} })),
      from,
    };
  }).filter(Boolean);
  return { styles, minimums: { silk: P.CONFIG.silk.minPieces, dtf: P.CONFIG.dtf.minPieces, emb: P.CONFIG.emb.minPieces },
    days: { silk: P.CONFIG.silk.days, dtf: P.CONFIG.dtf.days, emb: P.CONFIG.emb.days } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") {
    try {
      const body = await catalog();
      return new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } });
    } catch (e) { return json({ error: "catalog failed", detail: String((e as Error).message || e) }, 500); }
  }
  if (req.method !== "POST") return json({ error: "use GET or POST" }, 405);
  let order: any;
  try { order = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  if (!order || !Array.isArray(order.items) || order.items.length > 50) return json({ error: "items required (max 50)" }, 400);
  // The website never picks Vendor 2; the method comes from the rule unless it is one of the 3 site methods.
  if (order.method && !["silk", "dtf", "emb"].includes(order.method)) return json({ error: "unknown method" }, 400);
  try {
    const total = order.items.reduce((s: number, it: any) => s + (+it?.qty?.std || 0) + (+it?.qty?.x2 || 0) + (+it?.qty?.x3 || 0), 0);
    const method = order.method || P.chooseMethod({ deco: order.deco, logoType: order.logoType, colors: order.colors, total });
    const q = P.quoteOrder({ ...order, method }, { [method]: await products(method) });
    // Public answer: no cost, no vendor data.
    const { cost, ...pub } = q;
    pub.lines = q.lines.map((l: any) => ({ code: l.code, name: l.name, color: l.color, size: l.size, q: l.q, unit: l.unit, amount: l.amount }));
    return json(pub);
  } catch (e) {
    return json({ error: "pricing failed", detail: String((e as Error).message || e) }, 500);
  }
});
