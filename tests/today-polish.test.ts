// Today polish (phase 1): compact metrics, one setup area, a compact date strip, expandable calculation details, a calmer call to action, and clean
// labels for known engine and database values. Pure logic is tested directly; components and CSS at source level.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatDisplayName, formFacts, formStateLabel, sourceText, sportLabel } from "../lib/today/format.ts";
import { emphasis, metricSpecs, nextAction, type MetricInput } from "../lib/today/lens.ts";
import { setupModel, type SetupInput } from "../lib/today/setup.ts";
import { tsbState } from "../lib/engine.ts";
import { wellnessSummary, type DailyRow, type EnduranceSummary } from "../lib/today/model.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const css = read("app/globals.css");
const TODAY = "2026-11-13";
const rows = (n: number, f: (i: number) => Partial<DailyRow>): DailyRow[] => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.UTC(2026, 10, 13 - (n - 1 - i))).toISOString().slice(0, 10);
  return { day: d, hrv_ms: null, rhr_bpm: null, sleep_minutes: null, sleep_score: null, ...f(i) };
});
const endurance = (form: EnduranceSummary["form"]): EnduranceSummary => ({ last: null, week: { sessions: 2, load: 120, durationS: 7200, prevLoad: 90, prevSessions: 1 }, bars: [], form });
const input = (over: Partial<MetricInput> = {}): MetricInput => ({ w: null, wellnessProblem: null, e: null, st: null, whoop: null, sleepGoalH: null, today: TODAY, ...over });

// ------------------------------------------------------------------ 6. names and raw strings
test("display name: a clean first name, never the raw stored value", () => {
  assert.equal(formatDisplayName("Vasco"), "Vasco");
  assert.equal(formatDisplayName("  Vasco   Guerreiro "), "Vasco", "first name only, whitespace cleaned");
  assert.equal(formatDisplayName("vasco"), "Vasco"); assert.equal(formatDisplayName("VASCO"), "Vasco", "all lower or all upper case gets a capital");
  assert.equal(formatDisplayName("McKenzie"), "McKenzie", "mixed case is left exactly as written");
  assert.equal(formatDisplayName("Zoë"), "Zoë"); assert.equal(formatDisplayName("João Pedro"), "João"); assert.equal(formatDisplayName("Anne-Marie"), "Anne-Marie");
  assert.equal(formatDisplayName("Vasco,"), "Vasco", "trailing punctuation is dropped");
  for (const bad of [null, undefined, "", "   ", "vasco@example.com", "https://x.y", "www.site.pt", "vasco.guerreiro", "vasco_123", "12345", "\u0007\u0007", "Supercalifragilisticexpialidocious"]) assert.equal(formatDisplayName(bad as string | null), null, `${String(bad)} gives no name`);
  assert.equal(formatDisplayName("a\u0000b"), "A", "control characters are removed, not shown");
  const page = read("app/(app)/today/page.tsx");
  assert.match(page, /const name = formatDisplayName\(profile\?\.display_name\)/); assert.ok(!/const name = profile\?\.display_name;/.test(page));
});

test("labels: known engine and database values are mapped explicitly; unknown ones get a safe fallback, never a raw string", () => {
  for (const [id, label] of [["run", "Run"], ["bike", "Bike"], ["swim", "Swim"], ["strength", "Strength"], ["other", "Other"], ["RUN", "Run"], [" bike ", "Bike"]] as const) assert.equal(sportLabel(id), label);
  for (const raw of ["trail_run_v2", "", null, undefined, "hevy:legacy", "__proto__", "constructor", "toString"]) assert.equal(sportLabel(raw as string | null), "Activity", `${String(raw)} is not shown raw`);
  // every state the load model can produce has an explicit label; anything else is not shown
  for (const tsb of [40, 10, 0, -20, -40]) { const st = tsbState(tsb); assert.equal(formStateLabel(st), st, `${st} is mapped`); }
  assert.equal(formStateLabel("tsb_state_7"), null); assert.equal(formStateLabel("constructor"), null); assert.equal(formStateLabel("__proto__"), null); assert.equal(formStateLabel(""), null); assert.equal(formStateLabel(null), null);
  const f = formFacts({ ctl: 1, atl: 4, tsb: -3, state: "Productive training" });
  assert.deepEqual(f, { tsb: "-3", state: "Productive training", fitness: "1", fatigue: "4" }, "Fitness and Fatigue are separate values, numbers unchanged");
  assert.equal(formFacts({ ctl: 30, atl: 20, tsb: 10, state: "Peak form window" }).tsb, "+10", "Form carries its sign");
  assert.equal(formFacts({ ctl: 1, atl: 1, tsb: 0, state: "mystery" }).state, null);
});

test("training form: shown as a labelled state plus separate Fitness and Fatigue, not as one raw sentence", () => {
  const spec = metricSpecs(input({ e: endurance({ ctl: 1, atl: 4, tsb: -3, state: "Productive training" }) }), ["form"])[0];
  assert.equal(spec.value, "-3"); assert.equal(spec.unit, "TSB"); assert.equal(spec.delta, "Productive training");
  assert.deepEqual(spec.facts, [{ label: "Fitness", value: "1" }, { label: "Fatigue", value: "4" }]);
  assert.equal(spec.context, "Productive training. Fitness 1, fatigue 4.");
  assert.ok(!/Productive training fitness|fitness 1, fatigue 4 \(model\)| · fitness/i.test(JSON.stringify(spec)), "no run-together engine string");
  const unknown = metricSpecs(input({ e: endurance({ ctl: 5, atl: 6, tsb: -1, state: "mystery_state" }) }), ["form"])[0];
  assert.equal(unknown.delta, null); assert.ok(!JSON.stringify(unknown).includes("mystery_state"), "an unknown state is not exposed");
  const mod = read("components/today/Modules.tsx"), fd = read("components/today/FiveDay.tsx");
  assert.match(mod, /<small>Fitness<\/small><b>\{f\.fitness\}<\/b>/); assert.match(mod, /<small>Fatigue<\/small><b>\{f\.fatigue\}<\/b>/);
  assert.ok(!/e\.form\.state|\{e\.form\.ctl\}|fitness \{e\.form/.test(mod), "the Endurance card no longer prints the raw state sentence");
  assert.match(mod, /e\.last\.title \|\| sportLabel\(e\.last\.sport\)/); assert.ok(!/e\.last\.title \|\| e\.last\.sport\b/.test(mod));
  assert.match(fd, /it\.kind === "activity" \? sportLabel\(it\.detail\) : it\.detail/);
});

test("data sources: an unknown or missing source is 'source not recorded', never the stored identifier", () => {
  const good = wellnessSummary(rows(20, () => ({ hrv_ms: 60, rhr_bpm: 50, sleep_minutes: 420, hrv_source: "weird_vendor_x", rhr_source: "intervals", sleep_source: null })), TODAY, 8);
  const [hrv, rhr, sleep] = metricSpecs(input({ w: good, sleepGoalH: 8 }), ["hrv", "rhr", "sleep"]);
  assert.equal(hrv.source, "Today · source not recorded"); assert.equal(rhr.source, "Today · synced from Intervals.icu"); assert.equal(sleep.source, "Today · source not recorded");
  assert.ok(!JSON.stringify([hrv, rhr, sleep]).includes("weird_vendor_x"));
  assert.match(read("components/today/Modules.tsx"), /\{sourceText\(r!\.source\)\}/);
  for (const raw of ["constructor", "__proto__", "toString", "", null, undefined, "legacy_unknown_x"]) assert.equal(sourceText(raw as string | null), "source not recorded", `${String(raw)} is not shown raw`);
  assert.equal(sourceText("manual"), "entered by you"); assert.equal(sourceText("whoop"), "from WHOOP");
});

// ------------------------------------------------------------------ 1. compact metrics
test("compact metrics: name, value and unit first; context, source and meaning in an expandable 'Details'; HRV and resting HR stay neutral", () => {
  const good = wellnessSummary(rows(20, (i) => ({ hrv_ms: 60 + (i % 3), rhr_bpm: 50, sleep_minutes: 420 })), TODAY, 8);
  const [readiness, hrv, rhr, sleep] = metricSpecs(input({ w: good, sleepGoalH: 8 }), ["readiness", "hrv", "rhr", "sleep"]);
  assert.match(hrv.delta!, /^[+-]?\d+% vs your average$/, "one short line"); assert.match(rhr.delta!, /^[+-]?\d+ bpm vs your average$/);
  assert.match(hrv.context!, /vs your \d+-day average \(\d+ ms\)/, "the long comparison is kept, for the details");
  assert.equal(hrv.tone, undefined, "a higher HRV is never styled as good or bad"); assert.equal(rhr.tone, undefined); assert.equal(sleep.tone, undefined);
  assert.ok(!/better|worse|good|bad|great|poor|healthy|excellent/i.test(`${hrv.delta} ${hrv.context} ${rhr.delta} ${rhr.context}`), "no verdict words on HRV or resting heart rate");
  assert.ok(readiness.tone === "ok" || readiness.tone === "info" || readiness.tone === "warn", "only the readiness band (an existing validated interpretation) carries status styling");
  assert.match(readiness.context!, /confidence/, "confidence is kept");
  const card = flat(read("components/ui/MetricCard.tsx"));
  assert.match(card, /<p className="ds-metric-value"><b>\{m\.value\}<\/b>\{m\.unit && <small>\{m\.unit\}<\/small>\}<\/p>/);
  assert.match(card, /\{m\.delta && <p className="ds-metric-delta">/);
  assert.match(card, /<div id=\{panel\} className="ds-explain" hidden=\{!open\}> \{showContext && <p>\{m\.context\}<\/p>\} \{m\.source && <p>Source: \{m\.source\}<\/p>\} <p>\{m\.explain\}<\/p> <\/div>/, "context, source and meaning are all kept");
  assert.doesNotMatch(card, /<summary>|<details/, "no separate Details row: the disclosure lives in the heading");
  assert.match(card, /<h3><button type="button" className="ds-metric-toggle" aria-expanded=\{open\} aria-controls=\{panel\} onClick=\{\(\) => setOpen\(\(v\) => !v\)\}><span>\{m\.label\}<\/span>/, "the heading contains the real button");
  assert.match(card, /const panel = useId\(\)/); assert.match(card, /^"use client";/);
  assert.match(css, /\.ds-metric-toggle\{[^}]*min-height:44px;min-width:44px/); assert.match(css, /\.ds-metric-toggle:focus-visible\{outline:2px solid/);
  assert.match(css, /\.ds-explain\[hidden\]\{display:none\}/);
  assert.ok(!/aria-label=\{m\.label\}/.test(card), "the heading is not announced twice");
  assert.match(css, /\.ds-metric-value b\{font-size:26px/); assert.ok(!/\.ds-explain summary/.test(css), "the old Details summary styling is gone");
});

// ------------------------------------------------------------------ 2. one setup area
const base: SetupInput = { wellness: "ok", wellnessMissing: false, hasSleepReading: true, sleepGoalH: 8, activities: "ok", hasActivity: true, hasStrength: true, strength: "ok", intervalsConnected: true,
  race: "ok", hasRace: true, biomarkers: "ok", hasBiomarkers: true, supplements: "ok", hasSupplements: true };
test("setup area: only relevant items, honest wording, optional modules kept quiet", () => {
  assert.deepEqual(setupModel(base), { needed: [], optional: [] }, "a complete setup shows nothing");
  const noGoal = setupModel({ ...base, sleepGoalH: null });
  assert.deepEqual(noGoal.needed.map((x) => x.id), ["sleep-goal"]); assert.equal(noGoal.needed[0].href, "/profile"); assert.match(noGoal.needed[0].text, /left out of the readiness estimate/);
  assert.deepEqual(setupModel({ ...base, sleepGoalH: null, hasSleepReading: false }).needed, [], "a sleep goal is only mentioned when there is a sleep reading to use it");
  assert.deepEqual(setupModel({ ...base, sleepGoalH: null, wellnessMissing: true }).needed, []);
  const none = setupModel({ ...base, hasActivity: false, hasStrength: false, intervalsConnected: false });
  assert.deepEqual(none.needed.map((x) => x.id), ["activities"]); assert.equal(none.needed[0].href, "/integrations");
  assert.deepEqual(setupModel({ ...base, hasActivity: false, hasStrength: false, intervalsConnected: true }).needed, [], "a connected source with no recent sessions has nothing to set up");
  const optional = setupModel({ ...base, hasRace: false, hasBiomarkers: false, hasSupplements: false, hasStrength: false });
  assert.deepEqual(optional.optional.map((x) => x.id), ["race", "biomarkers", "supplements", "strength"]); assert.deepEqual(optional.needed, []);
  // unavailable or still-loading data never produces a setup item: that is a load problem, shown by the card itself
  for (const st of ["loading", "unavailable"] as const) {
    const r = setupModel({ ...base, wellness: st, activities: st, strength: st, race: st, biomarkers: st, supplements: st, sleepGoalH: null, hasActivity: false, hasStrength: false, hasRace: false, hasBiomarkers: false, hasSupplements: false, intervalsConnected: false });
    assert.deepEqual(r, { needed: [], optional: [] }, `${st}: nothing is claimed missing`);
  }
});

test("setup area: one area under the metrics; empty detail cards are not drawn, but errors and loading always are", () => {
  const page = read("app/(app)/today/page.tsx"), sa = read("components/today/SetupArea.tsx"), km = read("components/today/KeyMetrics.tsx");
  assert.match(page, /endurance: acts\?\.status === "ok" && \(!e \|\| !e\.last\)/); assert.match(page, /strength: strength\?\.status === "ok" && !hasStrength/);
  assert.match(page, /race: races\?\.status === "ok" && !race/); assert.match(page, /biomarkers: bio\?\.status === "ok" && !b/); assert.match(page, /supplements: sups\?\.status === "ok" && !hasSupplements/);
  assert.match(page, /wellness: false/, "the wellness card is always drawn");
  assert.ok(!/status === "unavailable"[^;]*hidden|hidden[^;]*"unavailable"/.test(page), "a card that failed to load is never hidden");
  assert.match(page, /intervalsConnected: intervals \|\| !intervalsKnown/, "no 'connect a source' hint before the connection check answers");
  assert.match(sa, /aria-labelledby="td-setup-h"/); assert.match(sa, /<summary>More you can add<\/summary>/); assert.match(sa, /ds-setup-link/);
  assert.match(km, /<SetupArea groups=\{missing\} setup=\{setup\} \/>/);
  assert.equal((km.match(/<SetupArea/g) ?? []).length, 1, "a single setup area");
  assert.match(css, /\.ds-setup-link\{[^}]*min-height:44px/);
});

// ------------------------------------------------------------------ 3. date strip
test("five-day strip: compact horizontal strip, today and the selected day distinguishable, indicators only from real records", () => {
  const fd = read("components/today/FiveDay.tsx");
  assert.match(fd, /className="td-strip" role="group" aria-label="Choose a day"/);
  assert.match(fd, /<button key=\{d\.day\} type="button"/); assert.match(fd, /aria-pressed=\{on\}/); assert.match(fd, /aria-current=\{d\.label === "Today" \? "date" : undefined\}/);
  assert.match(fd, /kinds = \[\.\.\.new Set\(d\.items\.map\(\(i\) => i\.kind\)\)\]/, "dots come only from the day's own items");
  assert.match(fd, /\{kinds\.map\(\(k\) => <i key=\{k\} className=\{`td-dot2 k-\$\{k\}`\} \/>\)\}/);
  assert.match(fd, /nothing recorded/); assert.match(fd, /No activity recorded or workout planned today\./); assert.match(fd, /No workouts planned\./);
  assert.doesNotMatch(fd, /Nothing recorded for this day|nothing is planned for you|Planned workouts are the ones you add/, "the repetitive wording is gone");
  assert.match(fd, /APEX does not plan for you/, "the honest note that nothing is planned automatically stays, once, in one short line");
  assert.match(css, /\.ds-setup-list li\{display:flex;flex-flow:row wrap;/, "setup rows are one wrapped line each, not stacked blocks");
  assert.match(read("components/today/SetupArea.tsx"), />Not set up</); assert.match(read("components/today/SetupArea.tsx"), /className="ds-setup-link"/); assert.match(read("components/today/SetupArea.tsx"), /More you can add/, "actions and optional links are kept");
  assert.match(fd, /<Link href=\{it\.href\}/, "items still link to their existing pages"); assert.match(fd, /href="\/training"/);
  assert.ok(fd.indexOf("days.map((d) => {") < fd.indexOf("cur.items.map"), "strip first, then the day's items: reading order equals visual order");
  assert.match(css, /\.td-strip\{display:flex;[^}]*overflow-x:auto;scroll-snap-type:x proximity/); assert.match(css, /\.td-chip\{[^}]*min-width:64px;min-height:64px/);
  assert.match(css, /\.td-chip\.sel\{[^}]*border-color:var\(--green\)/); assert.match(css, /\.td-chip\.now small\{color:var\(--green\)\}/);
  assert.ok(!/\.td-days\{|\.td-day\{|\.td-dayhead|\.td-dayempty/.test(css), "the bulky day cards are gone");
  assert.ok(!/(^|[;{\s])order:/.test(css.slice(css.indexOf(".td-strip{"), css.indexOf(".td-sources ul{"))), "no visual reordering in the strip");
});

// ------------------------------------------------------------------ 4. expandable calculation details
test("readiness details: calculation inputs, weights and method are expandable; warnings, exclusions, limits and the disclaimer stay visible", () => {
  const mod = read("components/today/Modules.tsx");
  const ok = mod.slice(mod.indexOf("How the readiness estimate was made"), mod.indexOf("{guidanceAbove ?"));
  const inDetails = ok.slice(ok.indexOf("<details"), ok.indexOf("</details>"));
  assert.match(inDetails, /Calculation details: inputs, weights and method/); assert.match(inDetails, /c\.effectiveWeight \* 100/); assert.match(inDetails, /Only today&apos;s measurements are used/);
  const before = ok.slice(0, ok.indexOf("<details"));
  assert.match(before, /est\.excluded\.map[^]*Not used:/, "data-quality exclusions are visible, not hidden");
  const tail = mod.slice(mod.indexOf("{guidanceAbove ?"), mod.indexOf("// ------------------------------------------------------------------ 2 Endurance"));
  assert.match(tail, /Provisional: too little data or a short baseline, so no training suggestion is made/); assert.match(tail, /\{est\.disclaimer\}/);
  assert.match(mod, /<span className="td-pill">Insufficient data<\/span>[^]*est\.reasons\[0\]/, "the reasons for an insufficient estimate stay visible");
  assert.doesNotMatch(mod, /How it is calculated|CONF_TEXT|conf-\$\{|\{!detail|detail = false|detail \?/, "the unreachable non-detail layout is gone, not hidden");
});

// ------------------------------------------------------------------ 5. CTA hierarchy
test("call to action: strong only when attention or a meaningful action is needed; calm and neutral on a routine day; logic and destinations unchanged", () => {
  assert.deepEqual((["resume-workout", "log-wellness", "data-unavailable"] as const).map(emphasis), ["strong", "strong", "strong"]);
  assert.deepEqual((["readiness-guidance", "provisional", "log-supplements", "ask-coach", "loading"] as const).map(emphasis), ["neutral", "neutral", "neutral", "neutral", "neutral"]);
  const card = read("components/today/NextActionCard.tsx");
  assert.match(card, /strong = emphasis\(a\.kind\) === "strong", variant = strong \? "primary" : "secondary"/); assert.match(card, /ds-next-strong/); assert.match(card, /ds-next-neutral/);
  assert.match(card, /<Button href=\{cta\.href\} variant=\{variant\}>/); assert.match(card, /onAction\(cta\.action!\)/);
  assert.match(css, /\.ds-next\{[^}]*border:1px solid var\(--line\);[^}]*background:var\(--card2\)\}/, "neutral by default"); assert.match(css, /\.ds-next-strong\{border-color:#1d4a37;background:linear-gradient/);
  // the chosen step and its destination are exactly as before
  const good = wellnessSummary(rows(20, (i) => ({ hrv_ms: 60 + (i % 3), rhr_bpm: 50, sleep_minutes: 420 })), TODAY, 8);
  const guidance = nextAction({ w: good, loading: false, activeWorkout: null, sup: null });
  assert.equal(guidance.kind, "readiness-guidance"); assert.equal(guidance.cta!.href, "/coach?tab=daily"); assert.equal(emphasis(guidance.kind), "neutral");
  assert.equal(nextAction({ w: null, loading: false, activeWorkout: { title: "Push" }, sup: null }).cta!.href, "/strength");
  assert.equal(nextAction({ w: wellnessSummary([], TODAY, 8), loading: false, activeWorkout: null, sup: null }).cta!.action, "log-wellness");
});

// ------------------------------------------------------------------ boundaries
test("scope: no calculation, schema, auth or dependency change in this phase", () => {
  const lens = read("lib/today/lens.ts"), fmt = read("lib/today/format.ts"), setup = read("lib/today/setup.ts");
  for (const src of [lens, fmt, setup]) assert.ok(!/getSupabase|\.from\(|\.rpc\(|fetch\(|localStorage|Math\.random/.test(src), "pure presentation code");
  assert.ok(!/readinessEstimate\(|wellnessSummary\(|enduranceSummary\(|tsbState\(/.test(lens + fmt + setup), "no calculation is recomputed or changed here");
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  assert.ok(!["tailwindcss", "@mui/material", "framer-motion", "date-fns", "lodash"].some((d) => d in pkg.dependencies));
});

// ------------------------------------------------------------------ dead code removed (each item verified unused before removal)
test("dead code is gone; what is still used stays: Coach confidence pills, the insufficient-estimate ring, the provisional background", () => {
  const card = flat(read("components/ui/MetricCard.tsx")), keym = read("components/today/KeyMetrics.tsx");
  assert.doesNotMatch(card, /\bhas\b|m\.empty|ds-metric-none|ds-metric-empty|value: string \| null/, "MetricCard only renders metrics that have a value");
  assert.match(card, /value: string;/);
  assert.match(read("lib/today/lens.ts"), /export type FilledMetric = MetricSpec & \{ value: string \};[^]*filter\(\(m\): m is FilledMetric => m\.value !== null\)/, "the type system guarantees it");
  assert.match(keym, /filled\.map\(\(\{ key, \.\.\.m \}\) => <MetricCard key=\{key\} \{\.\.\.m\} \/>\)/);
  for (const dead of [".td-metrics3", ".td-metric{", ".td-metric ", ".td-metric.", ".ds-metric-none", ".ds-metric-empty", ".td-readyscore small", ".td-ready.provisional .td-readyscore"]) assert.ok(!css.includes(dead), `${dead} is removed`);
  for (const used of [".conf-low{", ".conf-high{", ".conf-medium{", ".td-readyscore.none{", ".td-ready.provisional{", ".td-ready.insufficient{", ".td-none{"]) assert.ok(css.includes(used), `${used} is still used`);
  assert.match(read("components/coach/AssessmentCards.tsx"), /pill conf-\$\{r\.confidence\}/, "the Coach still uses the .conf-* pills");
  assert.match(read("components/today/Modules.tsx"), /className="td-readyscore none"/); assert.match(read("components/today/Modules.tsx"), /td-ready\$\{est\.provisional \? " provisional" : ""\}/);
});
