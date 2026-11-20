// spec-reader: reads vendor screenshots (product page, price table, quote) and returns the Pricing calculator fields.
// Staff only (logged in to the calculators). Uses the Claude API — secret ANTHROPIC_API_KEY.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AI_KEY = (Deno.env.get("ANTHROPIC_API_KEY") || "").trim();
const MODEL = Deno.env.get("SPEC_MODEL") || "claude-sonnet-5-5";

async function isStaff(req: Request) {
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!auth) return false;
  const who = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${auth}` } });
  return who.ok;
}

const S = (d: string) => ({ type: "string", description: d });
const TOOL = {
  name: "fill_product",
  description: "Fill the TBDezign pricing calculator for this product, from the vendor screenshots.",
  input_schema: {
    type: "object",
    properties: {
      title: S("Product name for the website, in English, short and clean, like 'Glossy Flyers', 'Foil Business Cards', 'Vinyl Banner', 'Circle Clear Labels'. No vendor name, no size, no quantity."),
      cat: S("Main category. Use one of the given categories when it fits; otherwise a short new one."),
      sub: S("Subcategory (optional). Use one of the given subcategories of that category when it fits; empty if none fits."),
      size: S("Size as the vendor shows it, e.g. 3.5\" x 2\", 8.5\" x 11\", 10 ft. x 7 ft. Empty if not shown."),
      stock: S("Paper / material, keeping the vendor's trade terms, e.g. 16pt, 100# Gloss Text, 13 oz. Matte Scrim Vinyl, White Gloss BOPP."),
      printing: S("Printing sides/colors in Brazilian Portuguese, e.g. 'Frente e verso', 'Somente frente', 'Colorido', 'Frente colorida, verso preto e branco'."),
      finish: S("Finish/coating/extra (spot UV, foil, rounded corners, hems & grommets…), in Brazilian Portuguese but keeping trade terms (Spot UV, Foil, Suede). Empty if none."),
      lamination: S("Lamination in Brazilian Portuguese (Fosca, Brilhosa, Velvet, Silk…). Empty if none."),
      qtyNote: S("Leave empty unless the vendor states something special about quantity."),
      turnaround: S("Production time in business days as 'min-max' numbers only, e.g. '3-5'. Empty if not shown."),
      custom: { type: "array", description: "Other specs a client cares about that don't fit the fields above (adhesive, corners, shape, resistance, capacity…). Label and value in Brazilian Portuguese, short. At most 6.",
        items: { type: "object", properties: { label: S("e.g. Cantos, Adesivo, Formato"), value: S("e.g. Arredondados, Permanente") }, required: ["label", "value"] } },
      lines: { type: "array", description: "One line per quantity (and per option group when the vendor shows different prices for an option, e.g. 1 side vs 2 sides). Only prices that are visible in the screenshots.",
        items: { type: "object", properties: {
          group: S("Option group label in Brazilian Portuguese when there are several price groups (e.g. 'Frente e verso', 'Com laminação'); empty when there is only one group."),
          qty: S("Quantity as a number, e.g. '250'."),
          vc: { type: "number", description: "Vendor cost for this quantity (TOTAL price for the whole quantity, not per unit; multiply when the vendor shows only a unit price). Before shipping." },
          sh: { type: "number", description: "Shipping cost for this quantity if the screenshot shows it; otherwise omit." },
        }, required: ["qty", "vc"] } },
      notes: S("Anything uncertain or worth checking (e.g. 'price shown is per unit, multiplied'), in Portuguese, one short sentence. Empty if nothing."),
    },
    required: ["title", "lines"],
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  if (!await isStaff(req)) return json({ error: "Log in to the calculator first." }, 401);
  if (!AI_KEY) return json({ error: "The AI key is not set up yet (ANTHROPIC_API_KEY)." }, 503);
  let body: any; try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const imgs = (Array.isArray(body.images) ? body.images : []).slice(0, 6).map((d: string) => /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(String(d || ""))).filter(Boolean);
  const text = String(body.text || "").slice(0, 8000).trim();
  if (!imgs.length && !text) return json({ error: "Paste a screenshot first." }, 400);
  const cats = body.categories && typeof body.categories === "object" ? JSON.stringify(body.categories).slice(0, 3000) : "{}";
  const content: any[] = imgs.map((m: any) => ({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }));
  content.push({ type: "text", text:
    "These are screenshots from a trade printer / vendor (product page, price table or quote). TBDezign resells this product. " +
    "Fill the pricing calculator with fill_product. Read prices exactly as shown; never invent prices or quantities that are not visible. " +
    "If the screenshots show selected options (e.g. a dropdown set to a stock or size), use the selected ones.\n" +
    "Existing categories (main → subcategories): " + cats + (text ? "\n\nExtra text pasted by the user:\n" + text : "") });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": AI_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, tools: [TOOL], tool_choice: { type: "tool", name: "fill_product" }, messages: [{ role: "user", content }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: "AI " + r.status + ": " + String((j.error && j.error.message) || "").slice(0, 200) }, 502);
  const use = (j.content || []).find((c: any) => c.type === "tool_use");
  if (!use) return json({ error: "Couldn't read the screenshot." }, 502);
  return json({ ok: true, fields: use.input });
});
