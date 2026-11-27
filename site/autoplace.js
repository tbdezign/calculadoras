/* Auto placement: finds the shirt in a garment photo and returns where each print spot goes.
 * Shared by the workwear page (site/tbd-workwear.liquid) and Apparel Quotes (apparel.html): keep both copies the same.
 * Result: { cx, cy, maxW, maxH } as fractions of the photo (same shape as the placements saved in Apparel Quotes), or null.
 * How: the shirt is the color at the middle of the garment (so a model's face or the background don't count);
 * its length from the high shoulder point to the hem is ~29 in. Spots are measured in inches from the shoulder and the center line. */
var TBDAutoPlace = (function () {
  var cache = {};
  function analyze(img) {
    var key = img.currentSrc || img.src;
    if (cache[key] !== undefined) return cache[key];
    var W = 200, H = Math.max(1, Math.round(W * img.naturalHeight / img.naturalWidth));
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d'); x.drawImage(img, 0, 0, W, H);
    var d = x.getImageData(0, 0, W, H).data, n = W * H, i, px, py;
    // background: transparent (cut-out photos) or near-white (studio photos)
    var transparent = 0;
    for (i = 0; i < n; i += 7) if (d[i * 4 + 3] < 20) transparent++;
    var cut = transparent > n / 7 * 0.05;
    var solid = new Uint8Array(n);
    for (i = 0; i < n; i++) { var o = i * 4; solid[i] = cut ? d[o + 3] > 60 : (d[o + 3] > 60 && !(d[o] > 238 && d[o + 1] > 238 && d[o + 2] > 238)); }
    // garment box
    var x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (py = 0; py < H; py++) for (px = 0; px < W; px++) if (solid[py * W + px]) { if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
    if (x1 < 0 || x1 - x0 < W * 0.2 || y1 - y0 < H * 0.2) return (cache[key] = null);
    // shirt color: median of the middle of the garment (chest / belly)
    var rs = [], gs = [], bs = [];
    for (py = Math.round(y0 + (y1 - y0) * 0.45); py < y0 + (y1 - y0) * 0.75; py += 2)
      for (px = Math.round(x0 + (x1 - x0) * 0.38); px < x0 + (x1 - x0) * 0.62; px += 2) { i = py * W + px; if (solid[i]) { rs.push(d[i * 4]); gs.push(d[i * 4 + 1]); bs.push(d[i * 4 + 2]); } }
    if (rs.length < 20) return (cache[key] = null);
    var med = function (a) { a.sort(function (p, q) { return p - q; }); return a[a.length >> 1]; };
    var R = med(rs), G = med(gs), B = med(bs), light = R * .3 + G * .59 + B * .11 > 200;
    var T = light ? 75 : 95;   // shading tolerance (white shirts: keep skin out)
    var m = new Uint8Array(n);
    for (i = 0; i < n; i++) if (solid[i]) { var dr = d[i * 4] - R, dg = d[i * 4 + 1] - G, db = d[i * 4 + 2] - B; m[i] = dr * dr + dg * dg + db * db < T * T; }
    var row = function (y) { var k = 0; for (var xx = 0; xx < W; xx++) k += m[y * W + xx]; return k; };
    // shirt rows
    var sy0 = -1, sy1 = -1;
    for (py = 0; py < H; py++) if (row(py) >= 3) { if (sy0 < 0) sy0 = py; sy1 = py; }
    if (sy0 < 0) return (cache[key] = null);
    // center line: middle of the shirt across the belly rows
    var sx = 0, sk = 0;
    for (py = Math.round(sy0 + (sy1 - sy0) * .55); py < sy0 + (sy1 - sy0) * .8; py++) for (px = 0; px < W; px++) if (m[py * W + px]) { sx += px; sk++; }
    if (!sk) return (cache[key] = null);
    var cx = sx / sk;
    // a person wearing the shirt (skin showing): head and crop make the measures unreliable → use the saved / default spots
    var skin = 0, body = 0;
    for (i = 0; i < n; i++) if (solid[i]) { body++; if (!m[i]) { var r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2]; if (r > 95 && g > 40 && b > 20 && r > g + 12 && r > b + 25 && r - b < 150) skin++; } }
    if (skin > body * 0.006) return (cache[key] = null);
    return (cache[key] = { W: W, H: H, cx: cx, top: sy0, bottom: sy1, m: m });
  }
  // inches → fractions of the photo. Scale: shirt length (high shoulder point to hem) ≈ 29 in.
  function spot(img, s) {
    var a; try { a = analyze(img); } catch (e) { return null; }
    if (!a) return null;
    var L = (a.bottom - a.top) / 29;                       // pixels per inch
    if (L * 14 > a.W) return null;                          // not a shirt-shaped photo
    var inX = L / a.W, inY = L / a.H, cx = a.cx / a.W, top = a.top / a.H;
    var box = function (x, y, w, h) { return { cx: +x.toFixed(4), cy: +y.toFixed(4), maxW: +(w * inX).toFixed(4), maxH: +(h * inY).toFixed(4) }; };
    if (s === 'lc') return box(cx + 4 * inX, top + 8.5 * inY, 3.6, 3.6);
    if (s === 'cc') return box(cx, top + 7 * inY, 6, 3);
    if (s === 'ff') return box(cx, top + 11.5 * inY, 11, 9);
    if (s === 'mf') return box(cx, top + 10.5 * inY, 8, 8);
    if (s === 'fb') return box(cx, top + 8 * inY, 12, 10);
    if (s === 'bn') return box(cx, top + 3.5 * inY, 4, 2);
    if (s === 'sl' || s === 'sr') {
      // side photo: sleeve logo ≈ 7.5 in below the top of the shoulder, centered on the sleeve
      var y = a.top + 7.5 * L, yy = Math.round(y), xs = 0, k = 0, xx;
      for (xx = 0; xx < a.W; xx++) if (a.m[yy * a.W + xx]) { xs += xx; k++; }
      return box((k ? xs / k : a.cx) / a.W, y / a.H, 3, 2.5);
    }
    return null;
  }
  return { spot: spot, analyze: analyze };
})();
