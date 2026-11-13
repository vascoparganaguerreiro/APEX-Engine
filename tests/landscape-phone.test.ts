// Landscape phones: (1) safe areas on notched iPhones at every width, including fixed elements, and (2) the phone layout (bottom bar, Coach composer, compact
// sheets) on a short touchscreen held sideways even though its CSS width is 800-1000px. Portrait, tablets and normal desktops are unchanged.
// The CSS media query is EVALUATED here (a tiny evaluator over the real text of app/globals.css), not just matched as text.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PHONE_MEDIA, SHORT_LANDSCAPE_MEDIA } from "../lib/nav.ts";
import manifest from "../app/manifest.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const css = read("app/globals.css"), bar = read("components/nav/BottomNav.tsx"), omni = read("components/omni/OmniAction.tsx"), layout = read("app/layout.tsx");
const PHONE_CSS = "(max-width:800px),(orientation:landscape) and (pointer:coarse) and (max-height:500px) and (max-width:1000px)";
const norm = (q: string) => q.replace(/:\s+/g, ":").replace(/,\s+/g, ",");

interface Screen { w: number; h: number; coarse: boolean }
/** Evaluates a media query list made of (feature:value) conditions joined by "and" / ",". Enough for the queries in this file. */
function matches(query: string, s: Screen): boolean {
  return query.split(",").some((alt) => alt.split(" and ").every((c) => {
    const m = c.trim().match(/^\((min-width|max-width|min-height|max-height|orientation|pointer):\s*([a-z]+|\d+)(?:px)?\)$/); assert.ok(m, `understood: ${c}`);
    const f = m![1], v = m![2], n = Number(v);
    return f === "max-width" ? s.w <= n : f === "min-width" ? s.w >= n : f === "max-height" ? s.h <= n : f === "min-height" ? s.h >= n
      : f === "orientation" ? (v === "landscape") === (s.w > s.h) : (v === "coarse") === s.coarse;
  }));
}

test("the phone-layout query is defined once, identically, in every CSS block and in JS", () => {
  const blocks = css.match(/@media [^{]*max-width:800px[^{]*\{/g) ?? [];
  assert.equal(blocks.length, 6, "six phone blocks: sidebar strip, phone use, bottom navigation, Coach/omni, save bar, and the rest-bar override");
  for (const b of blocks) assert.equal(b, `@media ${PHONE_CSS}{`, "the same query everywhere");
  assert.ok(!/@media ?\(max-width:800px\)\{/.test(css), "no block still uses the width-only query");
  assert.equal(norm(PHONE_MEDIA), PHONE_CSS, "the JS copy equals the CSS");
  assert.equal(norm(SHORT_LANDSCAPE_MEDIA), "(orientation:landscape) and (pointer:coarse) and (max-height:500px) and (max-width:1000px)");
  assert.match(css, /@media \(min-width:801px\)\{\.restbar\{left:240px\}\}/, "the desktop rule is unchanged");
});

test("who gets the phone layout: portrait phones and narrow windows as before; phones in landscape now; tablets, desktops and short desktop windows never", () => {
  const phone: Array<[string, Screen]> = [
    ["iPhone portrait", { w: 390, h: 844, coarse: true }], ["small phone portrait", { w: 360, h: 640, coarse: true }], ["800px-wide tablet window", { w: 800, h: 1000, coarse: true }],
    ["narrow desktop window", { w: 700, h: 500, coarse: false }], ["iPhone 15 landscape", { w: 852, h: 393, coarse: true }], ["iPhone Pro Max landscape", { w: 932, h: 430, coarse: true }],
    ["Android phone landscape", { w: 915, h: 412, coarse: true }], ["phone landscape with the keyboard open", { w: 852, h: 200, coarse: true }], ["iPhone SE landscape", { w: 667, h: 375, coarse: true }],
  ];
  for (const [name, s] of phone) assert.equal(matches(PHONE_CSS, s), true, `${name} gets the phone layout`);
  const notPhone: Array<[string, Screen]> = [
    ["desktop", { w: 1440, h: 900, coarse: false }], ["laptop", { w: 1280, h: 720, coarse: false }], ["iPad landscape", { w: 1180, h: 820, coarse: true }], ["iPad mini landscape", { w: 1133, h: 744, coarse: true }],
    ["iPad portrait", { w: 820, h: 1180, coarse: true }], ["Android tablet landscape, keyboard open", { w: 1280, h: 420, coarse: true }],
    ["short desktop window with a mouse", { w: 950, h: 450, coarse: false }], ["wide short window", { w: 1400, h: 450, coarse: false }],
  ];
  for (const [name, s] of notPhone) assert.equal(matches(PHONE_CSS, s), false, `${name} keeps the desktop layout`);
  assert.equal(matches(PHONE_CSS, { w: 801, h: 1000, coarse: true }), false, "just above the old breakpoint in portrait: unchanged (desktop layout, as before)");
});

test("safe areas: the page frame keeps the side insets at every width, and every fixed element clears them", () => {
  // top level, not inside a media query: it applies to portrait, landscape, phones and desktops alike (the insets are 0 where there is no notch)
  const top = css.slice(0, css.indexOf("/* mobile bottom navigation"));
  assert.match(top, /\n\.shell\{padding-left:env\(safe-area-inset-left\);padding-right:env\(safe-area-inset-right\)\}\n/);
  assert.ok(!/\.shell\{padding-left:env/.test(css.slice(css.indexOf("/* mobile bottom navigation"))), "not repeated inside the phone block");
  const rule = (start: string) => { const i = css.indexOf(start); assert.ok(i >= 0, start); return css.slice(i, css.indexOf("}", i)); };
  assert.match(rule(".restbar{position:fixed;left:0;right:0;bottom:0;"), /padding-left:max\(16px,env\(safe-area-inset-left\)\);padding-right:max\(16px,env\(safe-area-inset-right\)\)$/);
  assert.match(rule(".restbar{position:fixed;left:0;right:0;bottom:0;"), /calc\(10px \+ env\(safe-area-inset-bottom\)\)/, "bottom inset kept");
  assert.match(rule(".fab{position:fixed;right:16px;"), /margin-right:env\(safe-area-inset-right\)$/);
  assert.match(rule("  .td-quickbtn{position:fixed;right:16px;"), /margin-right:env\(safe-area-inset-right\)$/);
  assert.match(rule("  .omni-fab{display:grid;place-items:center;position:fixed;right:16px;"), /;margin-right:env\(safe-area-inset-right\)$/);
  assert.match(rule("  .bnav{--cyan:#38d4d0;"), /padding:0 env\(safe-area-inset-right\) env\(safe-area-inset-bottom\) env\(safe-area-inset-left\)/, "the bar already had all three");
  assert.match(css, /--bnav-h:calc\(60px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(layout, /viewportFit: "cover"/);
});

test("rest bar: beside the sidebar on desktop, full width on a landscape phone (which has no sidebar)", () => {
  const desk = css.indexOf("@media (min-width:801px){.restbar{left:240px}}"), phone = css.indexOf(`@media ${PHONE_CSS}{.restbar{left:0}}`);
  assert.ok(desk > 0 && phone > desk, "the phone override comes after the desktop rule, so it wins when both match (width above 800)");
  assert.equal(matches("(min-width:801px)", { w: 852, h: 393, coarse: true }) && matches(PHONE_CSS, { w: 852, h: 393, coarse: true }), true, "a landscape phone matches both, hence the override");
  assert.match(css, /\.restbar\{bottom:var\(--bnav-h\);padding-bottom:10px\}/, "above the bottom bar in phone mode");
});

test("components follow the same definition: the bottom bar closes its menu only when the layout really becomes desktop; the omni button uses the phone layout", () => {
  assert.match(bar, /const wide = window\.matchMedia\("\(min-width: 801px\)"\), sideways = window\.matchMedia\(SHORT_LANDSCAPE_MEDIA\)/);
  assert.match(bar, /if \(wide\.matches && !sideways\.matches\) setOpen\(false\)/);
  assert.match(bar, /wide\.addEventListener\("change", on\); sideways\.addEventListener\("change", on\)/); assert.match(bar, /wide\.removeEventListener\("change", on\); sideways\.removeEventListener\("change", on\)/);
  assert.match(omni, /window\.matchMedia\(PHONE_MEDIA\)/); assert.match(omni, /import \{ PHONE_MEDIA \} from "@\/lib\/nav"/);
  assert.ok(!/matchMedia\("\(max-width: 800px\)"\)/.test(omni));
  // the More menu is not closed by rotating a phone to landscape
  const wide = (s: Screen) => matches("(min-width:801px)", s) && !matches(SHORT_LANDSCAPE_MEDIA.replace(/: /g, ":"), s);
  assert.equal(wide({ w: 852, h: 393, coarse: true }), false); assert.equal(wide({ w: 1440, h: 900, coarse: false }), true);
});

test("orientation stays unrestricted", () => {
  assert.ok(!("orientation" in manifest()), "the manifest has no orientation");
  assert.ok(!/orientation|screen\.orientation\.lock/.test(layout + read("app/(app)/layout.tsx")), "no script or metadata locks the orientation");
});
