# apparel-quote (Supabase Edge Function)

Prices a workwear order for the website and the agent. Deployed with **a copy of `/pricing.js`** next to `index.ts`:
when `pricing.js` changes, redeploy this function with the new copy so the site and the calculator stay identical.

POST body: `{ deco, logoType, colors, placement, otherSpots, sleeves, items: [{ code, color, qty: { std, x2, x3 } }] }`
Answer: method, lines (unit price per size), subtotal, setup, `total$`, production days, errors. Never costs or vendor data.
