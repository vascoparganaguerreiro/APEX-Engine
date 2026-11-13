// Phase 3B: PWA identity. The manifest, the icon design and its sizes, the maskable safe zone, the favicon and the head metadata stay consistent.
// The icons are RENDERED here with the same library the route uses (next/og) from the same element (iconElement), decoded and inspected pixel by pixel:
// no build output is read, so the result is the same locally and in CI, and never stale.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { ImageResponse } from "next/og.js";
import manifest from "../app/manifest.ts";
import { ICONS, ICON_BG, ICON_KEYS, MARK_COUNTER, MARK_OUTLINE, MARK_PATH, MARK_RADIUS, MASKABLE_SAFE_RADIUS, iconElement, isIconKey, markReach, markSize, type IconKey } from "../lib/appIcon.ts";
import { APP_DESCRIPTION } from "../lib/appMeta.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const layout = read("app/layout.tsx"), route = read("app/icons/[size]/route.tsx"), appIcon = read("lib/appIcon.ts");
const points = (d: string) => [...d.matchAll(/[ML]\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
const keyOf = (src: string) => src.replace("/icons/", "");

test("manifest: stable identity, language, categories, no orientation lock, same colours", () => {
  const m = manifest();
  assert.equal(m.id, "/", "the install identity does not depend on the name or the start page");
  assert.equal(m.lang, "en"); assert.deepEqual(m.categories, ["health", "fitness", "sports"]);
  assert.ok(!("orientation" in m), "the app rotates with the device (no portrait-only lock)");
  assert.equal(m.name, "APEX Engine"); assert.equal(m.short_name, "APEX"); assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/today"); assert.equal(m.scope, "/");
  assert.ok(existsSync(new URL("../app/(app)/today/page.tsx", import.meta.url)), "the start page exists");
  assert.equal(m.background_color, ICON_BG); assert.equal(m.theme_color, ICON_BG);
  assert.match(layout, new RegExp(`themeColor: "${ICON_BG}"`), "the browser theme colour matches the manifest and the icon background");
  assert.match(layout, /colorScheme: "dark"/);
});

test("manifest icons: 192 and 512 for any purpose, plus a SEPARATE 512 maskable file; every src is a real icon route of the right size", () => {
  const icons = manifest().icons ?? [];
  assert.equal(icons.length, 3);
  const any = icons.filter((i) => i.purpose === "any"), mask = icons.filter((i) => i.purpose === "maskable");
  assert.deepEqual(any.map((i) => i.sizes), ["192x192", "512x512"]); assert.equal(mask.length, 1); assert.equal(mask[0].sizes, "512x512");
  assert.notEqual(mask[0].src, any[1].src, "the maskable icon is its own file, so the 'any' icons are never cropped");
  assert.ok(!icons.some((i) => (i.purpose as string)?.includes(" ")), "no combined 'any maskable' purpose");
  for (const i of icons) {
    assert.equal(i.type, "image/png"); const k = keyOf(i.src);
    assert.ok(isIconKey(k), `${i.src} is served by the icon route`); assert.equal(`${ICONS[k as IconKey].px}x${ICONS[k as IconKey].px}`, i.sizes, `${i.src} really is ${i.sizes}`);
    assert.equal(ICONS[k as IconKey].purpose, i.purpose, `${i.src} was drawn for its purpose`);
  }
});

test("head metadata: favicon 32 and 192, iOS 180, app name and status bar unchanged, pinch-zoom still allowed, no service worker", () => {
  assert.match(layout, /icon: \[\{ url: "\/icons\/32", sizes: "32x32", type: "image\/png" \}, \{ url: "\/icons\/192", sizes: "192x192", type: "image\/png" \}\]/);
  assert.match(layout, /apple: "\/icons\/180"/);
  assert.match(layout, /appleWebApp: \{ capable: true, title: "APEX", statusBarStyle: "black" \}/);
  assert.match(layout, /applicationName: "APEX Engine"/); assert.ok(!/maximumScale|userScalable/.test(layout));
  for (const m of layout.matchAll(/"\/icons\/([a-z0-9]+)"/g)) assert.ok(isIconKey(m[1]), `/icons/${m[1]} exists`);
  assert.ok(!/serviceWorker/.test(layout));
});

test("icon set: 32, 180, 192, 512 and a separate maskable 512, all square, in a fixed purpose", () => {
  assert.deepEqual(ICON_KEYS, ["32", "180", "192", "512", "maskable"]);
  assert.deepEqual(ICON_KEYS.map((k) => ICONS[k].px), [32, 180, 192, 512, 512]);
  assert.deepEqual(ICON_KEYS.map((k) => ICONS[k].purpose), ["favicon", "any", "any", "any", "maskable"]);
  for (const bad of ["", "64", "constructor", "__proto__", "toString", "MASKABLE", "512x512"]) assert.equal(isIconKey(bad), false, `${bad || "(empty)"} is not an icon`);
});

test("the mark: a bold geometric A that is symmetric, centred, inside its grid, with a closed counter above the crossbar", () => {
  const out = points(MARK_OUTLINE), counter = points(MARK_COUNTER);
  assert.equal(out.length, 7); assert.equal(counter.length, 3); assert.match(MARK_OUTLINE, /Z$/); assert.match(MARK_COUNTER, /Z$/); assert.equal(MARK_PATH, `${MARK_OUTLINE} ${MARK_COUNTER}`);
  for (const [x, y] of [...out, ...counter]) assert.ok(x >= 10 && x <= 90 && y >= 10 && y <= 90, `(${x}, ${y}) is inside the mark's 10..90 box`);
  // symmetric about x = 50: every outline point has its mirror image
  for (const [x, y] of out) assert.ok(out.some(([a, b]) => b === y && a === 100 - x), `(${x}, ${y}) has a mirror`);
  for (const [x, y] of counter) assert.ok(counter.some(([a, b]) => b === y && a === 100 - x));
  assert.deepEqual([Math.min(...out.map((p) => p[0])), Math.max(...out.map((p) => p[0])), Math.min(...out.map((p) => p[1])), Math.max(...out.map((p) => p[1]))], [10, 90, 10, 90], "centred on (50, 50)");
  // the counter sits strictly between the apex and the top of the crossbar (y 72 is the crossbar's lower edge), and inside the legs
  const crossbarTop = Math.max(...counter.map((p) => p[1]));
  assert.ok(Math.min(...counter.map((p) => p[1])) > 10 && crossbarTop < 72, "the crossbar is solid: the counter is above it");
  assert.ok(72 - crossbarTop >= 10, "the crossbar is at least 10 units thick (bold)");
  const legInner = (y: number) => [72 - (90 - y) * 0.5, 28 + (90 - y) * 0.5];
  for (const [x, y] of counter) assert.ok(x >= legInner(y)[1] - 1e-9 && x <= legInner(y)[0] + 1e-9, `counter point (${x}, ${y}) is between the legs`);
  assert.equal(MARK_RADIUS, Math.hypot(40, 40));
});

test("sizes and safe zone: the mark is large enough to read at every size, and the maskable one stays inside the 80% circle with margin", () => {
  for (const k of ICON_KEYS) { assert.ok(Number.isInteger(markSize(k)) && markSize(k) <= ICONS[k].px, `${k}: whole pixels, fits the canvas`); assert.ok((40 / 100) * (markSize(k) / ICONS[k].px) < 0.5, `${k}: the mark stays inside the square canvas on both axes`); }
  assert.ok(markReach("maskable") <= MASKABLE_SAFE_RADIUS - 0.05, `maskable: farthest point at ${markReach("maskable").toFixed(3)} of the canvas, safe radius ${MASKABLE_SAFE_RADIUS}`);
  assert.equal(MASKABLE_SAFE_RADIUS, 0.4, "80% of the canvas is guaranteed on every device");
  for (const k of ["180", "192", "512"] as const) assert.ok(markSize(k) * 0.8 >= ICONS[k].px * 0.55, `${k}: the A is at least 55% of the icon width`);
  assert.ok(markSize("maskable") < markSize("512"), "the maskable mark is smaller than the 'any' mark");
  assert.ok(markSize("32") * 0.8 >= 24, "the favicon A is at least 24 of 32 px wide");
});

test("icon route: static, one route for all sizes, unknown sizes are 404, and it draws nothing itself (one shared element built from MARK_PATH)", () => {
  assert.match(route, /export const dynamic = "force-static"/); assert.match(route, /generateStaticParams\(\) \{ return ICON_KEYS\.map\(\(s\) => \(\{ size: s \}\)\); \}/);
  assert.match(route, /if \(!isIconKey\(key\)\) return new Response\("Not found", \{ status: 404 \}\)/);
  assert.match(route, /new ImageResponse\(iconElement\(key\), \{ width: px, height: px \}\)/);
  assert.ok(!/MARK_OUTLINE|MARK_COUNTER|<svg|<path|M\d+ \d+ L/.test(route), "the route holds no copy of the shape");
  // the one place that draws: MARK_PATH, an SVG vector with the even-odd rule, on a full-bleed square (no font, no inset tile)
  assert.equal((appIcon.match(/MARK_PATH/g) ?? []).length >= 2, true); assert.match(appIcon, /createElement\("path", \{ d: MARK_PATH, fill: "url\(#apex\)", fillRule: "evenodd" \}\)/);
  assert.match(appIcon, /createElement\("svg", \{ width: s, height: s, viewBox: "0 0 100 100" \}/); assert.match(appIcon, /background: ICON_BG/);
  assert.ok(!/fontSize|fontWeight|fontFamily|borderRadius/.test(appIcon + route), "no default-font letter and no inset tile");
  for (const n of ["180", "192", "512", "32", "maskable"]) assert.ok(route.includes(n), `${n} is documented in the route`);
  assert.ok(!/fetch\(|process\.env/.test(route + appIcon), "nothing external or private");
});


/** Minimal PNG decoder (8-bit RGB or RGBA, not interlaced): enough to look at the pixels of an icon. */
function decodePng(buf: Buffer) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "a PNG");
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0; const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    if (type === "IDAT") idat.push(data);
    pos += 12 + len; if (type === "IEND") break;
  }
  assert.equal(depth, 8); assert.equal(interlace, 0); assert.ok(ctype === 6 || ctype === 2, "RGB or RGBA");
  const bpp = ctype === 6 ? 4 : 3, stride = w * bpp, raw = inflateSync(Buffer.concat(idat)), out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y > 0 ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * stride + x] = (line[x] + pred) & 255;
    }
  }
  return { w, h, at: (x: number, y: number): [number, number, number, number] => { const i = y * stride + x * bpp; return [out[i], out[i + 1], out[i + 2], bpp === 4 ? out[i + 3] : 255]; } };
}
const BG: [number, number, number] = [6, 8, 11];                                         // #06080b
const isBg = ([r, g, b, a]: number[], tol = 8) => a > 250 && Math.abs(r - BG[0]) <= tol && Math.abs(g - BG[1]) <= tol && Math.abs(b - BG[2]) <= tol;
async function render(k: IconKey) {
  const res = new ImageResponse(iconElement(k), { width: ICONS[k].px, height: ICONS[k].px });
  assert.equal(res.status, 200); assert.equal(res.headers.get("content-type"), "image/png");
  return decodePng(Buffer.from(await res.arrayBuffer()));
}

test("rendered icons (no build needed): real PNGs of the declared size, full-bleed dark background, the A where the geometry says it is", async () => {
  for (const k of ICON_KEYS) {
    const { px } = ICONS[k], img = await render(k), sc = markSize(k) / 100;
    assert.deepEqual([img.w, img.h], [px, px], `${k} is ${px}x${px}`);
    for (const [x, y] of [[0, 0], [px - 1, 0], [0, px - 1], [px - 1, px - 1]]) assert.ok(isBg(img.at(x, y)), `${k}: corner (${x}, ${y}) is the dark background, so there is no inset tile`);
    const grid = (gx: number, gy: number) => img.at(Math.round(px / 2 + (gx - 50) * sc), Math.round(px / 2 + (gy - 50) * sc));
    assert.ok(!isBg(grid(50, 66), 40), `${k}: the crossbar is solid`); assert.ok(Math.max(...grid(50, 66).slice(0, 3)) > 100);
    assert.ok(!isBg(grid(24, 80), 40), `${k}: the left leg is solid`); assert.ok(!isBg(grid(76, 80), 40), `${k}: the right leg is solid`);
    assert.ok(isBg(grid(50, 82)), `${k}: the base between the legs is open`);
    assert.ok(isBg(grid(50, 5)) && isBg(grid(5, 50)), `${k}: nothing outside the mark's box`);
    if (px >= 180) assert.ok(isBg(grid(50, 56)), `${k}: the counter above the crossbar is open`);
    // the brand gradient runs from green (top left) to blue (bottom right)
    if (px >= 180) { const top = grid(50, 18), foot = grid(84, 86); assert.ok(foot[2] > top[2] + 20 && foot[1] < top[1] - 10, `${k}: green at the apex, bluer at the right foot`); }
    // extent of everything that is not background
    let minX = px, maxX = -1, maxR = 0;
    for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) if (!isBg(img.at(x, y), 24)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); maxR = Math.max(maxR, Math.hypot(x + 0.5 - px / 2, y + 0.5 - px / 2) / px); }
    assert.ok(maxX >= 0, `${k} has a mark`);
    if (ICONS[k].purpose === "any") assert.ok((maxX - minX + 1) / px >= 0.55, `${k}: the A is at least 55% of the width`);
    if (k === "32") assert.ok(maxX - minX + 1 >= 24, "the favicon A is 24+ of 32 px wide");
    if (k === "maskable") assert.ok(maxR <= MASKABLE_SAFE_RADIUS, `maskable: every visible pixel is inside the safe circle (farthest ${maxR.toFixed(3)} <= ${MASKABLE_SAFE_RADIUS})`);
  }
  const [any, mask] = [await render("512"), await render("maskable")];
  const width = (img: ReturnType<typeof decodePng>) => { let lo = 512, hi = -1; for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) if (!isBg(img.at(x, y), 24)) { lo = Math.min(lo, x); hi = Math.max(hi, x); } return hi - lo; };
  assert.ok(width(mask) < width(any), "the maskable mark is smaller than the 'any' mark");
});

test("description: layout metadata and the manifest use the same text, and it names the three pillars", () => {
  assert.equal(manifest().description, APP_DESCRIPTION);
  assert.match(layout, /import \{ APP_DESCRIPTION \} from "@\/lib\/appMeta"/); assert.match(layout, /description: APP_DESCRIPTION,/);
  assert.match(read("app/manifest.ts"), /description: APP_DESCRIPTION,/);
  for (const w of ["health", "performance", "longevity"]) assert.match(APP_DESCRIPTION.toLowerCase(), new RegExp(w), `mentions ${w}`);
  assert.ok(!/endurance athletes|sports science/i.test(layout + read("app/manifest.ts") + APP_DESCRIPTION), "no sports-only positioning left");
  assert.ok(APP_DESCRIPTION.length <= 160, "short enough for search and share previews");
  assert.ok(!/diagnos|cure|treat|clinical|prevent/i.test(APP_DESCRIPTION), "no medical claims");
});
