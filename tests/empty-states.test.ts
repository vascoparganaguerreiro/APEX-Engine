// Educational empty states (UI/UX Phase 3A): the empty/failed/loading decision, the copy and CTAs, and where each state is allowed to appear.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY, loadView, type EmptyKey } from "../lib/emptyStates.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");
const page = (p: string) => read(`app/(app)/${p}/page.tsx`);
const KEYS = Object.keys(EMPTY) as EmptyKey[];

// ------------------------------------------------------------------ the decision
test("loadView: an empty state is only possible after a successful load", () => {
  assert.equal(loadView({ loaded: false, count: 0 }), "loading");
  assert.equal(loadView({ loaded: true, count: 0 }), "empty");
  assert.equal(loadView({ loaded: true, count: 3 }), "ready");
  // a failure is never "empty", whatever the count and whether or not a cache is showing
  assert.equal(loadView({ loaded: true, count: 0, error: "Could not load" }), "error");
  assert.equal(loadView({ loaded: false, count: 0, error: "Could not load" }), "error");
  assert.equal(loadView({ loaded: true, count: 5, error: "Could not load" }), "error");
  // a missing set-up (migration not applied) is not "empty" either
  assert.equal(loadView({ loaded: true, count: 0, notSetUp: true }), "setup");
  assert.equal(loadView({ loaded: false, count: 0, notSetUp: true }), "setup");
  // failure beats set-up beats loading beats empty
  assert.equal(loadView({ loaded: false, count: 0, error: "x", notSetUp: true }), "error");
  assert.equal(loadView({ loaded: true, count: 0, error: "", notSetUp: false }), "empty", "an empty error string is no error");
  assert.equal(loadView({ loaded: true, count: 0, error: null }), "empty");
});

// ------------------------------------------------------------------ the copy and its CTAs
test("every empty state explains the feature, says what activates it, and has exactly one primary CTA", () => {
  for (const k of KEYS) {
    const c = EMPTY[k];
    assert.ok(c.title.length >= 8, `${k}: title`); assert.ok(c.why.length >= 30, `${k}: says what the feature is for`); assert.ok(c.need.length >= 25, `${k}: says what turns it on`);
    assert.ok(c.cta.label.length >= 5, `${k}: CTA label`);
    assert.equal(Number(Boolean(c.cta.href)) + Number(Boolean(c.cta.action)), 1, `${k}: one primary CTA, either a page or an action on the page`);
    assert.ok(/[.]$/.test(c.why) && /[.?]$/.test(c.need), `${k}: complete sentences`);
  }
});

test("every CTA destination is an existing page", () => {
  const exists = (href: string) => existsSync(join(root, href === "/biomarkers/panels/new" ? "app/(app)/biomarkers/panels/[id]/page.tsx" : `app/(app)${href}/page.tsx`));
  const hrefs = KEYS.flatMap((k) => [EMPTY[k].cta.href, EMPTY[k].secondary?.href]).filter(Boolean) as string[];
  assert.ok(hrefs.length >= 10);
  for (const h of hrefs) assert.ok(exists(h), `${h} exists`);
  assert.deepEqual([...new Set(hrefs)].sort(), ["/biomarkers/panels/new", "/integrations", "/races", "/strength", "/strength/import", "/supplements"]);
});

test("no invented data: the copy carries no numbers, samples or illustrative charts", () => {
  for (const k of KEYS) {
    const text = `${EMPTY[k].title} ${EMPTY[k].why} ${EMPTY[k].need} ${EMPTY[k].cta.label}`;
    assert.doesNotMatch(text, /\d/, `${k}: no digits (no figures, no sample values)`);
    assert.doesNotMatch(text, /\b(sample|example data|demo|illustrat|placeholder|mock|fake)\w*/i, `${k}: nothing presented as sample data`);
  }
  const comp = read("components/ui/EmptyState.tsx");
  const code = comp.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /TrendChart|sparkline|<polyline|<canvas|chart/i, "no chart of any kind");
  assert.doesNotMatch(comp, /\{[^}]*\b\d+[^}]*\}\s*<\/(b|span)>/, "no numeric value rendered");
});

test("honest claims about integrations: no unavailable promises", () => {
  const all = KEYS.map((k) => EMPTY[k].need + EMPTY[k].why).join(" ");
  assert.doesNotMatch(all, /Strava/i, "Strava activities are not importable through Intervals.icu, so they are not promised");
  assert.match(EMPTY.activities.need, /Intervals\.icu/); assert.match(EMPTY.activities.need, /Garmin/);
  assert.match(EMPTY.supplements.need, /never recommends supplements or doses/, "the supplement disclaimer survives");
  assert.match(EMPTY.biomarkers.why, /never a diagnosis/, "the biomarker disclaimer survives");
  assert.match(EMPTY.training.need, /Nothing is ever planned for you/, "no automatic planning is implied");
});

// ------------------------------------------------------------------ the component
test("component: labelled section, heading, purpose, requirement, one CTA (link or button), decorative icon", () => {
  const c = read("components/ui/EmptyState.tsx");
  assert.match(c, /<section className=\{compact \? "empty compact" : "empty"\} aria-label=\{copy\.title\}>/);
  assert.match(c, /<H className="empty-title">\{copy\.title\}<\/H>/); assert.match(c, /className="empty-why">\{copy\.why\}/); assert.match(c, /<b>To get started:<\/b> \{copy\.need\}/);
  assert.match(c, /cta\.href\s*\?\s*<Link/); assert.match(c, /<button type="button" className=\{compact \? "btn ghost tiny" : "btn"\} onClick=\{onAction\}>/);
  assert.match(c, /aria-hidden="true"[\s\S]*focusable="false"/);
  assert.match(c, /headingLevel = 3/);
});

test("a failed request uses LoadProblem: an alert with a retry, never the empty-state component", () => {
  const c = read("components/ui/EmptyState.tsx");
  assert.match(c, /export function LoadProblem[\s\S]*role="alert"/); assert.match(c, /Try again/);
  assert.doesNotMatch(c.slice(c.indexOf("export function LoadProblem")), /EmptyState|copy\./);
});

test("CSS: restrained dashed card, cyan icon, 44px targets, focus ring, stacked on phones, compact variant inside cards", () => {
  const css = read("app/globals.css"), from = css.indexOf("/* educational empty states"), to = css.indexOf("/* progressive disclosure", from);
  const b = css.slice(from, to === -1 ? undefined : to);   // only this block: later blocks (disclosure) have their own transitions
  assert.match(b, /\.empty\{display:flex;[^}]*border:1px dashed/); assert.match(b, /\.empty-ic\{[^}]*color:#38d4d0/);
  assert.match(b, /\.empty \.btn\{[^}]*min-height:44px/); assert.match(b, /\.empty \.btn:focus-visible,\.empty-link:focus-visible\{outline:2px solid #38d4d0/);
  assert.match(b, /@media \(max-width:520px\)\{\.empty\{flex-direction:column/); assert.match(b, /\.empty\.compact\{display:block;margin:0;padding:0;border:0;background:none/);
  assert.doesNotMatch(b, /box-shadow|animation|transition/, "static: nothing to animate");
});

// ------------------------------------------------------------------ where each state may appear (never for a failure)
test("Activities: educates only when loaded without error and genuinely empty; the dashboard needs data", () => {
  const p = page("activities");
  assert.match(p, /\{acts !== null && acts\.length === 0 && !error && <EmptyState copy=\{EMPTY\.activities\}/);
  assert.match(p, /\{acts !== null && acts\.length > 0 && \(/, "the empty dashboard (week card, filters, dashes) is gone when there is nothing");
  assert.match(p, /\{error && <div className="notice error">\{error\}<\/div>\}/, "a failure still shows its error");
  assert.match(p, /No sessions recorded this week\./, "a quiet week (data exists elsewhere) keeps its own plain message");
});

test("Strength history and Routines: a failed load or a missing set-up is never reported as 'no workouts / no routines'", () => {
  const s = page("strength");
  assert.match(s, /const histView = loadView\(\{ loaded: hist\.sessions !== null, error: hist\.error, notSetUp: hist\.setUp === false, count: \(hist\.sessions \?\? \[\]\)\.length \}\)/);
  assert.match(s, /histView === "error" && <LoadProblem message=\{hist\.error \?\? ""\} onRetry=\{\(\) => void hist\.reload\(\)\} \/>/);
  assert.match(s, /histView === "empty" \? <EmptyState copy=\{EMPTY\["strength-history"\]\}[^>]*onAction=\{\(\) => start\(\)\}/);
  assert.doesNotMatch(s, /No finished workouts yet\./, "the old unconditional notice is gone");
  assert.match(s, /\{\(lib\.setUp === false \|\| hist\.setUp === false\) && <SetupNotice/, "the set-up notice is kept");
  const r = page("strength/routines");
  assert.match(r, /\{rts\.error && <LoadProblem message=\{rts\.error\} onRetry=\{\(\) => void rts\.reload\(\)\} \/>\}/);
  assert.match(r, /rts\.routines\.length === 0 \? \(rts\.error \|\| rts\.setUp === false \? null : <EmptyState copy=\{EMPTY\.routines\}/);
  assert.doesNotMatch(r, /No routines yet\./);
});

test("Biomarkers, Races, Supplements, Training: shown only after a successful load", () => {
  assert.match(page("biomarkers"), /results !== null && results\.length === 0 && panels\.length === 0 && \(\s*\n\s*<EmptyState copy=\{EMPTY\.biomarkers\}/);
  const races = page("races");
  assert.match(races, /\{races !== null && \(/); assert.match(races, /all\.length === 0 && !editing && <EmptyState copy=\{EMPTY\.races\} headingLevel=\{2\} onAction=\{\(\) => setEditing\("new"\)\}/);
  assert.match(races, /: all\.length > 0 && <button className="btn" onClick=\{\(\) => setEditing\("new"\)\}>\+ Add race<\/button>/, "one CTA: the header button steps aside while the empty state offers it");
  assert.match(races, /loadError && \(/, "a failed load keeps its own alert and retry");
  const sup = page("supplements");
  assert.match(sup, /sups !== null && sups\.length === 0 && !editing && <EmptyState copy=\{EMPTY\.supplements\}[^>]*onAction=\{\(\) => setEditing\("new"\)\}/);
  assert.match(sup, /sups !== null && sups\.length > 0 && !editing && <button/); assert.match(sup, /\{sups !== null && sups\.length > 0 && \(\s*\n\s*<>\s*\n\s*<h2>Today&apos;s doses<\/h2>/, "no second 'nothing scheduled' notice when no supplement exists");
  const tr = page("training");
  assert.match(tr, /\{ready && !form && plannedList\.length === 0 && <EmptyState compact copy=\{EMPTY\.training\} onAction=/);
  assert.match(tr, /const ready = planned\?\.status === "ok"/, "ready means the planned workouts loaded successfully");
});

test("Today cards: 'unavailable' (loading, failed, not set up) is always decided before 'empty'; each empty card has one CTA", () => {
  const m = read("components/today/Modules.tsx");
  const at = [...m.matchAll(/<EmptyState compact/g)].map((x) => x.index!);
  assert.equal(at.length, 6, "all six cards use the shared empty state");
  for (const i of at) {
    const before = m.slice(Math.max(0, i - 420), i);
    assert.ok(before.lastIndexOf('s.status === "unavailable" ? <Unavailable s={s} />') !== -1, "the card decides 'unavailable' (loading, failed, not set up) first, in the same expression");
  }
  for (const k of ["today-wellness", "today-endurance", "today-strength", "today-biomarkers", "today-supplements", "today-race"]) assert.ok(m.includes(`EMPTY["${k}"]`), k);
  assert.match(m, /<EmptyState compact copy=\{EMPTY\["today-wellness"\]\} onAction=\{onLog\} \/>/, "wellness opens the existing Quick log");
  assert.match(m, /const Unavailable = /); assert.match(m, /s\.status === "unavailable" \? <Unavailable s=\{s\} \/>/);
});

test("actions named in the copy are wired to existing forms on their pages", () => {
  const wired: Array<[EmptyKey, string]> = [["strength-history", page("strength")], ["routines", page("strength/routines")], ["races", page("races")], ["supplements", page("supplements")], ["training", page("training")], ["today-wellness", read("components/today/Modules.tsx")]];
  for (const [k, src] of wired) { assert.ok(EMPTY[k].cta.action, `${k} has an action`); assert.match(src, new RegExp(`EMPTY(\\.${k.replace("-", "\\-")}|\\["${k}"\\])`), `${k} is rendered by its page`); assert.match(src, /onAction=/); }
  assert.match(page("strength/routines"), /onAction=\{\(\) => \{ setMsg\(null\); setEdit\(emptyRoutine\(newId\(\)\)\); \}\}/, "opens the existing routine editor");
});

test("scope: empty states touch no calculation, engine, database or environment code", () => {
  for (const f of ["lib/emptyStates.ts", "components/ui/EmptyState.tsx"]) {
    const imports = read(f).split("\n").filter((l) => /^import /.test(l)).join("\n");
    assert.doesNotMatch(imports, /supabase|engine|today\/model|health|races|activities/i, `${f}: imports no data or calculation code`);
    assert.doesNotMatch(read(f), /fetch\(|\.rpc\(|process\.env|\.from\("/, f);
  }
});
