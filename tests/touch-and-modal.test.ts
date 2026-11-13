// Final-review follow-up: (3) design-system button sizing is scoped to .ds-btn so existing compact buttons keep their sizes, (4) the More sheet is genuinely
// modal (the scrim covers the bottom bar), (7) metric-card "Details" controls are 44px touch targets.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const css = read("app/globals.css"), bar = read("components/nav/BottomNav.tsx"), omni = read("components/omni/OmniAction.tsx");

interface Rule { selector: string; decl: string; inMedia: boolean }
/** Rules of the stylesheet (one level of @media is flattened and marked). Good enough for the selectors checked here. */
function rules(): Rule[] {
  const out: Rule[] = []; let depth = 0, buf = "";
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (ch === "{") { depth++; buf += ch; if (depth === 1 && /@media|@keyframes|@supports/.test(buf)) { buf = ""; depth = 0; out.push({ selector: "@@enter", decl: "", inMedia: false }); } }
    else if (ch === "}") { if (depth > 0) { depth--; } if (buf.trim()) { const m = buf.match(/^([^{]+)\{([^{}]*)$/); if (m) out.push({ selector: m[1].trim(), decl: m[2].trim(), inMedia: false }); } buf = ""; }
    else buf += ch;
  }
  return out.filter((r) => r.selector !== "@@enter");
}
const all = rules();
const sel = (s: string) => all.filter((r) => r.selector === s);

// ------------------------------------------------------------------ 3. button sizing scope
test("design-system buttons: sizing and layout are scoped to .ds-btn; the global .btn rules keep only non-sizing behaviour", () => {
  assert.match(css, /a\.btn\.ds-btn\{display:inline-flex;align-items:center;justify-content:center;text-decoration:none\}/);
  assert.match(css, /\.btn\.ds-btn\{min-height:44px\}/); assert.match(css, /\.btn\.ds-btn\.tiny\{min-height:36px;font-size:var\(--fs-sm\)\}/);
  const sizing = /(min-height|min-width|height|width|padding|font-size|display|line-height)\s*:/;
  // no bare `a.btn`, `.btn.tiny` or design-system `.btn` rule sizes anything any more (only `.ds-btn` ones do)
  for (const s of ["a.btn", ".btn.secondary", ".btn:not(:disabled):hover", ".btn[aria-busy=\"true\"]"]) for (const r of sel(s)) assert.ok(!sizing.test(r.decl) || s === ".btn.secondary" && !/min-height|padding|font-size|display/.test(r.decl), `${s} does not size`);
  const tiny = sel(".btn.tiny");
  assert.deepEqual(tiny.map((r) => r.decl), ["min-height:40px"], "the only bare .btn.tiny rule is the original phone one (40px), not a new 36px / 14px rule");
  const bare = sel(".btn").map((r) => r.decl);
  assert.ok(bare.some((d) => /transition:filter/.test(d)) && bare.every((d) => !/min-height/.test(d)), "the .btn rules add a transition but no height");
  assert.ok(bare.some((d) => /padding:12px 22px/.test(d)), "the original .btn base rule (padding, font size) is untouched");
});

test("existing compact buttons keep the sizes their screens give them (Strength, Races, Supplements, empty states)", () => {
  assert.match(css, /\.wk-head \.btn\.tiny,\.exc \.btn\.tiny\{min-height:44px;font-size:14px;padding:10px 14px\}/, "Strength workout buttons");
  assert.match(css, /\.week-nav \.btn\{min-height:44px\}/); assert.match(css, /\.tiny\{padding:6px 10px;font-size:12px;border-radius:10px\}/, "the base compact size");
  assert.match(css, /\.empty \.btn\{[^}]*min-height:44px/);
  // nothing outside the design-system component uses the .ds-btn class, so none of those screens can pick up its sizes
  const walk = (d: string): string[] => readdirSync(new URL(`../${d}`, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : walk(`${d}/${e.name}`)) : [`${d}/${e.name}`]));
  const users = ["app", "components", "lib"].flatMap(walk).filter((f) => /\.(tsx|ts)$/.test(f) && read(f).includes("ds-btn"));
  assert.deepEqual(users, ["lib/ui.ts"], "only buttonClass() produces ds-btn");
  const tsx = ["app", "components"].flatMap(walk).filter((f) => f.endsWith(".tsx"));
  assert.deepEqual(tsx.filter((f) => /<Button[ >]/.test(read(f)) && !f.endsWith("components/ui/Button.tsx")), ["components/today/NextActionCard.tsx"], "the design-system Button is used by the Next step card only");
  assert.ok(tsx.some((f) => /className="btn[^"]*tiny/.test(read(f))), "compact .btn.tiny buttons are still used in the app");
});

// ------------------------------------------------------------------ 4. modal More sheet
test("More sheet is modal: the scrim covers the whole screen including the bottom bar, above every other fixed control, below only dialogs", () => {
  const scrim = sel(".bnav-scrim")[0].decl, panel = sel(".bnav-panel")[0].decl;
  assert.match(scrim, /position:fixed;left:0;right:0;top:0;bottom:0;/); assert.ok(!/bottom:var\(--bnav-h\)/.test(scrim), "no longer stops above the bar");
  const z = (d: string) => Number(d.match(/z-index:(\d+)/)?.[1]);
  const zs = Object.fromEntries(all.filter((r) => /position:fixed/.test(r.decl) && /z-index:\d+/.test(r.decl)).map((r) => [r.selector.trim(), z(r.decl)]));
  const scrimZ = z(scrim), panelZ = z(panel);
  assert.ok(panelZ > scrimZ, "the sheet is above its own scrim");
  // every fixed control with a z-index is under the scrim, except the dialogs that are allowed to be above it
  const above = Object.entries(zs).filter(([s, n]) => n > scrimZ && s !== ".bnav-panel").map(([s]) => s).sort();
  assert.deepEqual(above, [".omni-bg", ".sheet-bg"], "only full dialogs (command palette, page drawers) may sit above the scrim");
  for (const s of [".bnav", ".restbar", ".fab", ".omni-fab", ".td-quickbtn"]) assert.ok((zs[s] ?? 0) < scrimZ, `${s} (z-index ${zs[s]}) is covered by the scrim`);
  assert.ok(zs[".bnav"] === 35 && scrimZ === 46 && panelZ === 47);
});

test("More sheet: the bar is also inert while open (no keyboard or assistive access), and dismissal, focus and the keyboard trap are unchanged", () => {
  assert.match(bar, /<nav className=\{`bnav\$\{typing \? " typing" : ""\}`\} aria-label="Primary" inert=\{open \|\| undefined\}>/);
  assert.match(bar, /className="bnav-scrim" onClick=\{\(\) => setOpen\(false\)\} aria-hidden="true"/);
  assert.match(bar, /e\.key === "Escape"/); assert.match(bar, /aria-label="Close menu" onClick=\{\(\) => setOpen\(false\)\}/);
  assert.match(bar, /querySelector<HTMLElement>\("a,button"\)\?\.focus\(\)/); assert.match(bar, /btn\?\.focus\(\)/, "focus returns to the More button");
  assert.match(bar, /onKeyDown=\{trapTab\}/); assert.match(bar, /aria-expanded=\{open\}/); assert.match(bar, /aria-modal="true"/);
  assert.match(bar, /document\.body\.style\.overflow = "hidden"/); assert.match(bar, /document\.body\.style\.overflow = prev/);
  assert.match(bar, /useEffect\(\(\) => \{ setOpen\(false\); \}, \[path\]\)/, "following a link still closes it");
  // the command palette is not opened on top of an open modal sheet
  assert.match(omni, /\[role="dialog"\]\[aria-modal="true"\]:not\(\[data-omni\]\)/);
});

// ------------------------------------------------------------------ 7. Details touch targets
test("metric-card Details and the setup 'More you can add' control are at least 44px high, and span the card width", () => {
  for (const s of [".ds-explain summary", ".ds-setup-more summary"]) {
    const d = sel(s)[0].decl; assert.ok(Number(d.match(/min-height:(\d+)px/)?.[1]) >= 44, `${s} is at least 44px`); assert.match(d, /display:flex;align-items:center/);
    assert.ok(!/padding:[^;]*0 4px/.test(d), `${s}: no padding trick that shrinks the target`);
  }
  assert.match(read("components/ui/MetricCard.tsx"), /<details className="ds-explain">\s*<summary>Details<\/summary>/);
  assert.match(read("components/today/SetupArea.tsx"), /<summary>More you can add<\/summary>/);
  assert.match(css, /a:focus-visible,button:focus-visible,summary:focus-visible/, "the focus ring is kept");
});
