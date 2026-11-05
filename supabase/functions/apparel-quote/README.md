# apparel-quote (Supabase Edge Function)

Prices workwear orders and serves the website catalog. Public; never returns costs, vendors or memos.

`index.ts` imports `/pricing.js` from this repo through jsDelivr, **pinned to a commit**, so the function runs the exact
file the calculators run. When `pricing.js` changes: commit + push, put the new commit in the import line, redeploy.

- `GET`  → catalog: styles marked "Show on site" in Apparel Quotes, colors marked "On site", photos (signed links, 24 h), "from" price.
- `POST` → quote. Body: `{ deco, logoType, colors, mixedShades, placement, otherSpots, sleeves, items: [{ code, color, qty: { std, x2, x3 } }] }`
  Answer: method, lines (unit price per size), subtotal, setup, `total$`, production days, errors.
