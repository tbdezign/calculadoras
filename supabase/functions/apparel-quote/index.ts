// apparel-quote: prices a workwear order with the SAME pricing.js the calculators use.
// Public (the website calls it). Returns retail prices only — never costs, vendors or memos.
import "./pricing.js";
const P = (globalThis as any).TBDPricing;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
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
