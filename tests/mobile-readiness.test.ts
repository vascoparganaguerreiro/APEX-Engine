// Task 9A: phone readiness guards (static). The visual checks were done in a browser with the real stylesheet; these keep the fixes from regressing.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import manifest from "../app/manifest.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const css = read("app/globals.css");

test("home-screen install: manifest has a name, a start page, standalone display and 192/512 icons that exist as routes", () => {
  const m = manifest();
  assert.equal(m.name, "APEX Engine"); assert.equal(m.short_name, "APEX");
  assert.equal(m.start_url, "/today"); assert.equal(m.display, "standalone");
  assert.equal(m.theme_color, "#06080b"); assert.equal(m.background_color, "#06080b");
  const sizes = (m.icons ?? []).map((i) => i.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
  assert.ok((m.icons ?? []).some((i) => i.purpose === "maskable"));
  const route = read("app/icons/[size]/route.tsx");
  for (const s of ["180", "192", "512"]) assert.ok(route.includes(s));
  const layout = read("app/layout.tsx");
  assert.match(layout, /appleWebApp: \{ capable: true/); assert.match(layout, /apple: "\/icons\/180"/);
  assert.match(layout, /width: "device-width", initialScale: 1/);
  assert.ok(!/maximumScale|maximum-scale|userScalable|user-scalable/.test(layout), "pinch-zoom stays available");
});

test("no service worker and no offline cache of private data was added", () => {
  for (const d of ["public", "app"]) {
    if (!existsSync(new URL(`../${d}`, import.meta.url))) continue;
    const walk = (dir: string): string[] => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
    assert.deepEqual(walk(d).filter((f) => /(^|\/)(sw|service-worker|serviceworker)\.[jt]s$/i.test(f)), []);
  }
  assert.ok(!/serviceWorker\.register|navigator\.serviceWorker/.test(read("app/layout.tsx") + read("app/(app)/layout.tsx")));
});

test("phone CSS: no page-widening grid track, 16 px fields (no iOS zoom), 44 px menu items, one-row menu, stacked result tables", () => {
  const m = css.slice(css.indexOf("Phone use (Task 9A)"));
  assert.ok(m.length > 100);
  assert.match(m, /\.shell\{grid-template-columns:minmax\(0,1fr\)\}\.main\{min-width:0\}/);
  assert.match(m, /input,select,textarea,\.setextra select,\.setextra input,\.rpesel,\.srcsel\{font-size:16px\}/);
  assert.match(m, /\.navitem\{[^}]*min-height:44px/);
  assert.match(m, /\.side nav\{flex-wrap:nowrap;overflow-x:auto/);
  assert.match(m, /\.tbl\.stack td::before\{content:attr\(data-label\)/);
  assert.match(m, /\.syncpill\{white-space:normal\}/);
  assert.match(m, /88dvh/);
  assert.ok(css.indexOf("Phone use (Task 9A)") > css.indexOf(".td-quickbtn"), "the phone rules come last so they win; desktop rules are unchanged above");
});

test("wide tables never sit bare inside a card: scrollable wrapper or stacked layout", () => {
  const hist = read("app/(app)/strength/history/[id]/page.tsx");
  assert.match(hist, /<table className="tbl stack">/);
  for (const label of ["Working sets", "Reps", "Best set", "Volume*", "Last time"]) assert.ok(hist.includes(`data-label="${label}"`), label);
  assert.match(read("app/(app)/strength/analytics/page.tsx"), /<div className="tablewrap" style=\{\{ padding: 0 \}\}><table className="tbl"><thead><tr><th>Date<\/th><th>Best set/);
  assert.match(read("app/(app)/strength/exercises/page.tsx"), /<div className="tablewrap" style=\{\{ padding: 0 \}\}><table className="tbl">/);
});
