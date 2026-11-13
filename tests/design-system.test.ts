// Design System 1.0, mobile navigation, the redesigned Today (profile-aware presentation, honest missing data) and the Omni-Action entry point.
// Pure logic is tested directly; components and CSS are checked at source level (the build covers compilation).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { BREAKPOINTS, badgeClass, buttonClass, freshnessBadge, progressPct } from "../lib/ui.ts";
import { LENS_LABEL, LENS_METRICS, LENS_SECTIONS, fmtSleep, groupEmpty, lensFromGoal, metricSpecs, nextAction, type MetricInput } from "../lib/today/lens.ts";
import { overview, wellnessSummary, supplementSummary, type DailyRow } from "../lib/today/model.ts";
import { DESKTOP_NAV, MORE_NAV, PRIMARY_NAV, activeTab } from "../lib/nav.ts";
import { OMNI_ACTIONS } from "../lib/omni.ts";
import { GOALS } from "../lib/profile.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const css = read("app/globals.css");
const TODAY = "2026-11-13";

// ------------------------------------------------------------------ tokens and components
test("design tokens: colour, status, spacing, radii, type, elevation and layout tokens exist, and the old names still work", () => {
  const root = css.slice(css.indexOf(":root{"), css.indexOf("*{box-sizing"));
  for (const t of ["--bg", "--card", "--text", "--muted", "--line", "--green", "--blue", "--amber", "--red", "--text-2", "--focus", "--ok", "--info", "--warn", "--danger",
    "--sp-1", "--sp-4", "--sp-7", "--r-sm", "--r-lg", "--r-pill", "--fs-xs", "--fs-md", "--fs-xl", "--fs-display", "--elev-1", "--elev-2", "--w-content", "--w-narrow"]) assert.ok(root.includes(`${t}:`), `${t} defined`);
  assert.ok(!/--fs-[a-z]+:\s*(?:[0-9]|1[01])px/.test(root), "no type token below 12px");
  assert.deepEqual(BREAKPOINTS, { phone: 520, mobile: 800, tablet: 1100 });
  for (const w of Object.values(BREAKPOINTS)) assert.ok(css.includes(`max-width:${w}px`) || css.includes(`max-width: ${w}px`) || css.includes(`min-width:${w + 1}px`), `a ${w}px breakpoint is used`);
});

test("ui helpers: button, badge, progress and freshness rules", () => {
  assert.match(buttonClass(), /^btn ds-btn$/); assert.match(buttonClass("ghost"), /\bghost\b/); assert.match(buttonClass("secondary", "sm", "x"), /secondary tiny x$/);
  assert.equal(badgeClass("warn"), "ds-badge ds-warn");
  assert.equal(progressPct(30, 60), 50); assert.equal(progressPct(90, 60), 100); assert.equal(progressPct(null, 60), 0); assert.equal(progressPct(5, 0), 0); assert.equal(progressPct(-1, 10), 0); assert.equal(progressPct(NaN, 10), 0);
  assert.equal(freshnessBadge("today"), null);
  assert.equal(freshnessBadge("yesterday")!.text, "From yesterday"); assert.equal(freshnessBadge("stale", "5 days ago")!.text, "Older: 5 days ago"); assert.equal(freshnessBadge("missing")!.text, "No data");
});

test("components: semantic HTML and accessible patterns, no UI framework", () => {
  const btn = read("components/ui/Button.tsx"), metric = read("components/ui/MetricCard.tsx"), prog = read("components/ui/Progress.tsx"), head = read("components/ui/SectionHeader.tsx"), sk = read("components/ui/Skeleton.tsx");
  assert.match(btn, /<Link className=\{cls\} href=/); assert.match(btn, /<button type=/); assert.match(btn, /aria-busy/); assert.match(btn, /disabled=\{b\.disabled \|\| b\.loading\}/);
  assert.match(metric, /<article/); assert.match(metric, /<h3>/); assert.match(metric, /<div id=\{panel\} className="ds-explain" hidden=\{!open\}>/);
  assert.match(prog, /role="progressbar"/); assert.match(prog, /aria-valuenow/); assert.match(head, /const H = `h\$\{level\}`/);
  assert.match(sk, /aria-hidden="true"/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.ds-skel\{animation:none\}\}/);
  assert.match(css, /a:focus-visible,button:focus-visible,summary:focus-visible/);
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  for (const lib of ["tailwindcss", "@mui/material", "antd", "@chakra-ui/react", "styled-components", "@emotion/react"]) assert.ok(!(lib in pkg.dependencies), `${lib} not introduced`);
});

// ------------------------------------------------------------------ mobile navigation
test("mobile navigation: Today, Activities, Coach and More; Training and every module stay reachable; active state and routes", () => {
  assert.deepEqual(PRIMARY_NAV.map((n) => n.label), ["Today", "Activities", "Coach"]);
  assert.equal(MORE_NAV[0].href, "/training", "Training is the first entry in More");
  assert.deepEqual([...PRIMARY_NAV, ...MORE_NAV].map((n) => n.href).sort(), DESKTOP_NAV.map((n) => n.href).sort(), "no destination lost or duplicated");
  for (const n of DESKTOP_NAV) assert.ok(existsSync(new URL(`../app/(app)${n.href}/page.tsx`, import.meta.url)), `${n.href} page exists`);
  for (const [p, tab] of [["/today", "today"], ["/activities", "activities"], ["/coach", "coach"], ["/coach/x", "coach"], ["/training", "more"], ["/profile", "more"], ["/strength/history/1", "more"]] as const) assert.equal(activeTab(p), tab, p);
  const bar = read("components/nav/BottomNav.tsx");
  assert.match(bar, /<nav className=\{`bnav/); assert.match(bar, /aria-label="Primary"/); assert.match(bar, /aria-current/); assert.match(bar, /aria-expanded/);
  assert.match(css, /--bnav-h:calc\(60px \+ env\(safe-area-inset-bottom\)\)/, "safe area");
  assert.match(css, /\.main\{padding-bottom:calc\(var\(--bnav-h\) \+ 96px/, "content is never covered by the bar");
});

// ------------------------------------------------------------------ profile lens
test("profile-aware Today: the view comes from the stored goal only, with a documented default and no new setting", () => {
  for (const g of GOALS) assert.ok(lensFromGoal(g.value).basis === "goal", `${g.value} maps to a view`);
  assert.deepEqual(lensFromGoal("race_performance"), { lens: "performance", basis: "goal" });
  assert.deepEqual(lensFromGoal("endurance"), { lens: "performance", basis: "goal" });
  assert.deepEqual(lensFromGoal("general_fitness"), { lens: "wellness", basis: "goal" });
  assert.deepEqual(lensFromGoal("return_from_injury"), { lens: "wellness", basis: "goal" });
  assert.deepEqual(lensFromGoal("health"), { lens: "longevity", basis: "goal" });
  for (const none of [null, undefined, "", "unknown_goal"]) assert.deepEqual(lensFromGoal(none), { lens: "performance", basis: "default" });
  assert.deepEqual(Object.keys(LENS_LABEL), ["performance", "wellness", "longevity"]);
});

test("profile-aware Today: each view orders the SAME trusted data differently; no card or metric is dropped or invented", () => {
  const allSections = ["biomarkers", "endurance", "race", "strength", "supplements", "wellness"];
  for (const l of ["performance", "wellness", "longevity"] as const) {
    assert.deepEqual([...LENS_SECTIONS[l]].sort(), allSections, `${l}: every detail card appears exactly once`);
    assert.equal(new Set(LENS_METRICS[l]).size, LENS_METRICS[l].length);
  }
  assert.deepEqual(LENS_METRICS.performance.slice(0, 2), ["readiness", "hrv"]); assert.ok(LENS_METRICS.performance.includes("form") && LENS_METRICS.performance.includes("weekload"));
  assert.equal(LENS_SECTIONS.performance[0], "endurance", "Performance: training context first");
  assert.deepEqual(LENS_METRICS.wellness.slice(0, 2), ["sleep", "readiness"]); assert.equal(LENS_SECTIONS.wellness[0], "wellness"); assert.ok(!LENS_METRICS.wellness.includes("form"), "no training-load jargon first for wellness");
  assert.equal(LENS_METRICS.longevity[0], "sleep"); assert.ok(LENS_METRICS.longevity.includes("sessions"), "consistency of activity"); assert.equal(LENS_SECTIONS.longevity[1], "strength", "functional activity early");
  const page = read("app/(app)/today/page.tsx");
  assert.match(page, /LENS_SECTIONS\[lens\]\.filter\(\(k\) => !hidden\[k\]\)\.map\(\(k\) => cards\[k\]\)/); assert.match(page, /<KeyMetrics lens=\{lens\}/); assert.match(page, /<NextActionCard/);
  assert.match(page, /View, based on your goal|view, based on your goal in/); assert.match(page, /view \(default\)/, "the page says when the default view is used");
});

// ------------------------------------------------------------------ data
const rows = (n: number, f: (i: number) => Partial<DailyRow>): DailyRow[] => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.UTC(2026, 10, 13 - (n - 1 - i))).toISOString().slice(0, 10);
  return { day: d, hrv_ms: null, rhr_bpm: null, sleep_minutes: null, sleep_score: null, ...f(i) };
});
const input = (over: Partial<MetricInput> = {}): MetricInput => ({ w: null, wellnessProblem: null, e: null, st: null, whoop: null, sleepGoalH: null, today: TODAY, ...over });

test("missing data: every metric shows an honest empty state, never a number, and says what to do", () => {
  const specs = metricSpecs(input(), LENS_METRICS.performance);
  assert.equal(specs.length, LENS_METRICS.performance.length - 1, "WHOOP recovery is left out when there is no WHOOP value (nothing to show, nothing to promote)");
  assert.ok(!specs.some((x) => x.key === "recovery"));
  assert.ok(metricSpecs(input({ whoop: { value: 71, day: TODAY } }), LENS_METRICS.performance).some((x) => x.key === "recovery" && x.value === "71"), "shown when WHOOP data exists");
  for (const s of specs) { assert.equal(s.value, null, `${s.key} has no value`); assert.equal(s.badge, null); assert.ok(s.empty.length > 10, `${s.key} explains what is missing`); assert.ok(s.explain.length > 20); }
  assert.match(specs.find((s) => s.key === "hrv")!.empty, /Quick log or connect a device/);
  assert.match(specs.find((s) => s.key === "form")!.empty, /training load/);
  const failed = metricSpecs(input({ wellnessProblem: "Wellness data is not available right now." }), ["hrv", "sleep", "readiness"]);
  assert.ok(failed.every((s) => s.value === null && s.empty === "Wellness data is not available right now."), "a load problem is reported, not hidden");
  const none = wellnessSummary([], TODAY, 8);
  assert.equal(none.state, "missing"); assert.ok(metricSpecs(input({ w: none }), ["hrv", "rhr", "sleep", "readiness"]).every((s) => s.value === null));
});

test("real data: values, baselines and goal come from the existing summaries; older readings are labelled; unreliable estimates stay provisional or absent", () => {
  const good = wellnessSummary(rows(20, (i) => ({ hrv_ms: 60 + (i % 3), rhr_bpm: 50, sleep_minutes: 420 })), TODAY, 8);
  const sp = metricSpecs(input({ w: good, sleepGoalH: 8 }), ["hrv", "rhr", "sleep", "readiness"]);
  const by = Object.fromEntries(sp.map((s) => [s.key, s]));
  assert.equal(by.hrv.value, String(Math.round(good.hrv!.value))); assert.equal(by.hrv.unit, "ms"); assert.match(by.hrv.context!, /vs your \d+-day average \(\d+ ms\)/);
  assert.equal(by.rhr.value, "50"); assert.match(by.rhr.context!, /bpm vs your \d+-day average/);
  assert.equal(by.sleep.value, "7 h 00 min"); assert.match(by.sleep.context!, /Your goal: 8 h/); assert.equal(by.sleep.progress!.text, "7 h 00 min of 8 h"); assert.equal(progressPct(by.sleep.progress!.value, by.sleep.progress!.max), 88);
  assert.equal(by.hrv.badge, null, "today's value has no age badge");
  assert.equal(good.estimate.status, "ok"); assert.equal(by.readiness.value, String((good.estimate as { score: number }).score));
  // yesterday's values only: shown with an age badge, and no readiness estimate is made from them
  const old = wellnessSummary(rows(20, (i) => (i === 18 ? { hrv_ms: 60, rhr_bpm: 50, sleep_minutes: 420 } : { hrv_ms: 60, rhr_bpm: 50, sleep_minutes: 420 })).slice(0, 19), TODAY, 8);
  const os = metricSpecs(input({ w: old, sleepGoalH: 8 }), ["hrv", "readiness"]);
  assert.equal(os[0].badge!.text, "From yesterday"); assert.equal(os[1].value, null, "no estimate from earlier days");
  assert.equal(fmtSleep(425), "7 h 05 min");
  // no sleep goal: no invented comparison
  assert.equal(metricSpecs(input({ w: good, sleepGoalH: null }), ["sleep"])[0].progress, null);
});

test("next step: one clear action chosen from existing data, in a fixed priority", () => {
  const good = wellnessSummary(rows(20, (i) => ({ hrv_ms: 60 + (i % 3), rhr_bpm: 50, sleep_minutes: 420 })), TODAY, 8);
  const none = wellnessSummary([], TODAY, 8);
  const sup = (pending: number) => supplementSummary([], [], [], TODAY) && ({ active: 1, due: [], taken: 0, skipped: 0, pending });
  assert.equal(nextAction({ w: null, loading: true, activeWorkout: null, sup: null }).kind, "loading");
  assert.equal(nextAction({ w: good, loading: false, activeWorkout: { title: "Push day" }, sup: sup(2) }).kind, "resume-workout", "a workout in progress comes first");
  const log = nextAction({ w: none, loading: false, activeWorkout: null, sup: null }); assert.equal(log.kind, "log-wellness"); assert.equal(log.cta!.action, "log-wellness");
  const g = nextAction({ w: good, loading: false, activeWorkout: null, sup: sup(1) });
  assert.equal(g.kind, "readiness-guidance"); assert.equal(g.detail, (good.estimate as { guidance: string }).guidance, "the engine's own guidance, word for word");
  const partial = wellnessSummary(rows(20, (i) => (i === 19 ? { hrv_ms: 60 } : { hrv_ms: 60, rhr_bpm: 50, sleep_minutes: 420 })), TODAY, 8);
  if (partial.estimate.status === "insufficient") assert.equal(nextAction({ w: partial, loading: false, activeWorkout: null, sup: null }).kind, "log-wellness");
  const sups = nextAction({ w: { ...good, estimate: { ...good.estimate, status: "ok", guidance: null, provisional: true } as typeof good.estimate }, loading: false, activeWorkout: null, sup: sup(3) });
  assert.equal(sups.kind, "provisional"); assert.match(sups.detail, /no training suggestion/);
  const coach = nextAction({ w: { ...good, estimate: { status: "insufficient", name: good.estimate.name, reasons: ["x"], disclaimer: "" }, state: "current" }, loading: false, activeWorkout: null, sup: sup(2) });
  assert.equal(coach.kind, "log-supplements"); assert.equal(coach.cta!.action, "log-supplements");
  const end = nextAction({ w: { ...good, estimate: { status: "insufficient", name: good.estimate.name, reasons: [], disclaimer: "" }, state: "current" }, loading: false, activeWorkout: null, sup: sup(0) });
  assert.equal(end.kind, "ask-coach"); assert.equal(end.cta!.href, "/coach?tab=daily");
});

test("Today keeps its calculations: the model and engine files are not part of the presentation layer", () => {
  const lens = read("lib/today/lens.ts");
  assert.ok(!/Math\.random|demo|sample|fake|placeholderData/i.test(lens), "no demo or fabricated data");
  assert.ok(!/from "\.\.\/engine|readinessEstimate\(|wellnessSummary\(|enduranceSummary\(/.test(lens), "lens.ts reads summaries, it does not recompute them");
  const page = read("app/(app)/today/page.tsx");
  for (const keep of ["wellnessSummary(daily.data", "enduranceSummary(acts.data", "strengthSummary(strength.data", "supplementSummary(", "fiveDays({", "CoachInsight", "QuickLog", "<TrendChart"]) assert.ok(page.includes(keep), `${keep} still used`);
  assert.match(read("lib/today/load.ts"), /export async function loadPrimaryGoal[^]*?catch \{ return null; \}/, "the goal has its own guarded query");
});

// ------------------------------------------------------------------ Omni-Action
test("Omni-Action: only real, existing workflows; reachable on phone and keyboard; mounted once; no duplicate forms", () => {
  assert.equal(new Set(OMNI_ACTIONS.map((a) => a.id)).size, OMNI_ACTIONS.length);
  for (const a of OMNI_ACTIONS) {
    const path = a.href.split("?")[0];
    const dynamic = path.replace(/\/[^/]+$/, "/[id]");                      // /biomarkers/panels/new is served by /biomarkers/panels/[id]
    assert.ok([path, dynamic].some((q) => existsSync(new URL(`../app/(app)${q}/page.tsx`, import.meta.url))), `${a.id} opens an existing page (${path})`);
    assert.ok(!/log activity|log an activity/i.test(a.label), "no fake manual activity logging");
  }
  for (const id of ["log-wellness", "log-supplements", "add-blood-test", "start-workout"]) assert.ok(OMNI_ACTIONS.some((a) => a.id === id), `${id} is offered`);
  const host = read("components/omni/OmniAction.tsx"), layout = read("app/(app)/layout.tsx");
  assert.match(host, /role="dialog"/); assert.match(host, /aria-modal/); assert.match(host, /Escape/); assert.match(layout, /<OmniActionHost \/>/);
  assert.equal((layout.match(/<OmniActionHost/g) ?? []).length, 1, "mounted once");
  assert.match(css, /\.omni-fab\{display:grid;[^}]*position:fixed;right:16px;bottom:calc\(var\(--bnav-h\)/, "above the bottom bar, within thumb reach");
  assert.ok(!/<form/.test(host) && !/\.from\(|getSupabase|\.rpc\(/.test(host), "the host has no data-entry form and writes nothing: it only routes to existing workflows");
});

// ------------------------------------------------------------------ responsive
test("responsive: the new components adapt at the phone breakpoint and the shell keeps its layout", () => {
  assert.match(css, /@media \(max-width:520px\)\{\.ds-next\{padding:var\(--sp-4\)\}\.ds-next \.btn\{width:100%\}\.ds-metric-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.match(css, /\.ds-metric-grid\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\(220px,1fr\)\)/);
  assert.match(css, /\.btn\.ds-btn\{min-height:44px\}/, "touch target (design-system buttons only; see tests/touch-and-modal.test.ts)");
  assert.match(css, /\.td-bento\{grid-auto-flow:row dense\}/);
  assert.match(css, /\.shell\{display:grid;grid-template-columns:240px 1fr/); assert.match(css, /@media \(max-width:800px\),\(orientation:landscape\) and \(pointer:coarse\) and \(max-height:500px\) and \(max-width:1000px\)\{\s*\.shell\{grid-template-columns:1fr\}/);
});

// ------------------------------------------------------------------ next step: unavailable vs genuinely absent data
test("next step: a failed wellness load shows 'data unavailable', never 'you have no data', and recommends nothing", () => {
  const good = wellnessSummary(rows(20, (i) => ({ hrv_ms: 60 + (i % 3), rhr_bpm: 50, sleep_minutes: 420 })), TODAY, 8);
  const none = wellnessSummary([], TODAY, 8);
  const problem = "Wellness data is not available right now.";
  for (const w of [null, none, good]) {
    for (const sup of [null, { active: 1, due: [], taken: 0, skipped: 0, pending: 2 }]) {
      const a = nextAction({ w, loading: false, activeWorkout: null, sup, problem });
      assert.equal(a.kind, "data-unavailable"); assert.equal(a.title, "Wellness data is unavailable");
      assert.match(a.detail, /^Wellness data is not available right now\. Your readiness and today's guidance cannot be shown until it loads\.$/);
      assert.equal(a.cta, null, "no action is recommended from missing data"); assert.deepEqual(a.badge, { text: "Unavailable", tone: "warn" });
      assert.ok(!/no HRV|log wellness|add today|resting heart rate or sleep for you yet|guidance:/i.test(`${a.title} ${a.detail}`), "does not claim the person has no data or ask them to log it");
    }
  }
  assert.match(nextAction({ w: null, loading: false, activeWorkout: null, sup: null, problem: "Not set up yet" }).detail, /^Not set up yet\. Your readiness/, "a reason without punctuation is still a clean sentence");
  // order of the rules: loading first, a workout in progress still comes first (it does not depend on wellness data)
  assert.equal(nextAction({ w: null, loading: true, activeWorkout: null, sup: null, problem }).kind, "loading");
  assert.equal(nextAction({ w: null, loading: false, activeWorkout: { title: "Push day" }, sup: null, problem }).kind, "resume-workout");
  const page = read("app/(app)/today/page.tsx");
  assert.match(page, /const action = nextAction\(\{ w, loading: daily === null, activeWorkout: active, sup, problem: wellnessProblem, lens, bio: \{ loaded: bio\?\.status === "ok", summary: b \} \}\)/, "the load problem is passed in, together with the experience");
  assert.match(page, /const wellnessProblem = daily\?\.status === "unavailable" \? daily\.reason : null/);
  assert.match(read("components/today/NextActionCard.tsx"), /const cta = a\.cta[^]*\{cta && /, "the card renders without a button when there is no action");
});

test("next step: when the data loaded, behaviour is unchanged (absent measurements, available measurements, guidance and priority)", () => {
  const good = wellnessSummary(rows(20, (i) => ({ hrv_ms: 60 + (i % 3), rhr_bpm: 50, sleep_minutes: 420 })), TODAY, 8);
  const none = wellnessSummary([], TODAY, 8);
  const sup = (pending: number) => ({ active: 1, due: [], taken: 0, skipped: 0, pending });
  for (const problem of [undefined, null, ""]) {
    const missing = nextAction({ w: none, loading: false, activeWorkout: null, sup: null, problem });
    assert.equal(missing.kind, "log-wellness", "genuinely absent measurements still ask to log wellness"); assert.equal(missing.cta!.action, "log-wellness"); assert.match(missing.detail, /no HRV, resting heart rate or sleep for you yet/);
    const ok = nextAction({ w: good, loading: false, activeWorkout: null, sup: sup(2), problem });
    assert.equal(ok.kind, "readiness-guidance"); assert.equal(ok.detail, (good.estimate as { guidance: string }).guidance, "the engine's own guidance, unchanged");
    assert.equal(nextAction({ w: good, loading: false, activeWorkout: { title: "Push day" }, sup: sup(2), problem }).kind, "resume-workout");
    assert.equal(nextAction({ w: null, loading: true, activeWorkout: null, sup: null, problem }).kind, "loading");
  }
  assert.equal(nextAction({ w: none, loading: false, activeWorkout: null, sup: null }).kind, "log-wellness", "callers that pass no problem behave exactly as before");
});

// ------------------------------------------------------------------ no duplication, one empty-data message
const COUNT = (text: string, re: RegExp) => (text.match(re) ?? []).length;

test("empty data: missing metrics are listed once, grouped by what is missing, and stay honest and actionable", () => {
  const none = wellnessSummary([], TODAY, 8);
  const specs = metricSpecs(input({ w: none }), LENS_METRICS.performance);
  // Next step is not asking for wellness (for example a workout is in progress): the full instruction is kept, once, for all the wellness metrics together
  const g = groupEmpty(specs, "resume-workout", null);
  assert.equal(g.filled.length, 0);
  const wellness = g.missing.find((x) => x.labels.includes("HRV (rMSSD)"))!;
  assert.deepEqual(wellness.labels, ["HRV (rMSSD)", "Resting heart rate", "Sleep"], "one line for the three wellness readings");
  assert.match(wellness.message, /Log it in Quick log or connect a device/);
  assert.equal(COUNT(JSON.stringify(g.missing), /Quick log or connect a device/g), 1, "the instruction appears once, not once per metric");
  assert.ok(g.missing.some((x) => /training load/.test(x.message)), "training metrics keep their own, different message");
  assert.ok(!g.missing.some((x) => /WHOOP/.test(x.message)), "no WHOOP promotion for people who do not use it");
  // Next step is already asking to log wellness: the wellness lines point to it instead of repeating the instruction
  const asked = groupEmpty(specs, "log-wellness", null);
  assert.equal(COUNT(JSON.stringify(asked.missing), /Quick log or connect a device/g), 0);
  assert.ok(asked.missing.some((x) => x.message === "No reading for today yet." && x.labels.includes("HRV (rMSSD)")), "still says what is missing");
  // A failed load: one 'unavailable' line when the Next step says so, otherwise the real reason is kept
  const failedSpecs = metricSpecs(input({ wellnessProblem: "Wellness data is not available right now." }), ["hrv", "rhr", "sleep", "readiness"]);
  const unavailable = groupEmpty(failedSpecs, "data-unavailable", "Wellness data is not available right now.");
  assert.deepEqual(unavailable.missing, [{ labels: ["HRV (rMSSD)", "Resting heart rate", "Sleep", "Readiness estimate"], message: "Not shown while wellness data is unavailable." }]);
  assert.deepEqual(groupEmpty(failedSpecs, "resume-workout", "Wellness data is not available right now.").missing.map((x) => x.message), ["Wellness data is not available right now."], "the reason is not hidden when nothing else shows it");
  // Readiness with its own specific reason is never merged into the generic line
  const hrvOnly = wellnessSummary(rows(20, (i) => ({ hrv_ms: 60 + (i % 3), rhr_bpm: null, sleep_minutes: null })), TODAY, 8);
  const partial = groupEmpty(metricSpecs(input({ w: hrvOnly }), ["readiness", "hrv", "rhr", "sleep"]), "log-wellness", null);
  assert.deepEqual(partial.filled.map((x) => x.key), ["hrv"], "metrics that have a value stay as cards");
  assert.ok(partial.missing.some((x) => x.labels.includes("Readiness estimate") && /Not enough data yet\. .+/.test(x.message)), "the readiness reason is kept");
  // Nothing is dropped: every metric is either a card or on exactly one list line
  for (const kind of ["log-wellness", "resume-workout"] as const) {
    const r = groupEmpty(specs, kind, null);
    assert.deepEqual([...r.filled.map((x) => x.label), ...r.missing.flatMap((x) => x.labels)].sort(), specs.map((x) => x.label).sort());
  }
});

test("empty data: the hero, Next step, metrics and detail card do not each repeat the instruction", () => {
  const none = wellnessSummary([], TODAY, 8);
  assert.match(overview({ w: none, e: null, st: null, sup: null, race: null, today: TODAY })[0], /^No wellness data yet/, "the overview's first line is the wellness line the page drops");
  const page = read("app/(app)/today/page.tsx"), km = read("components/today/KeyMetrics.tsx"), mod = read("components/today/Modules.tsx");
  assert.match(page, /const lines = w\?\.state === "missing" && action\.kind === "log-wellness" \? allLines\.slice\(1\) : allLines;/);
  assert.match(page, /<KeyMetrics lens=\{lens\} nextKind=\{action\.kind\}/);
  assert.match(page, /quiet=\{action\.kind === "log-wellness" \|\| action\.kind === "data-unavailable"\}/); assert.match(page, /guidanceAbove=\{action\.kind === "readiness-guidance"\}/);
  assert.match(km, /<SetupArea groups=\{missing\} setup=\{setup\}/); assert.match(km, /groupEmpty\(/);
  // the detail card is quiet (one short line) when the Next step card already asks, and keeps the full educational empty state otherwise
  assert.match(mod, /quiet && \(s\.status === "unavailable" \|\| !w \|\| w\.state === "missing"\)/);
  assert.match(mod, /<EmptyState compact copy=\{EMPTY\["today-wellness"\]\} onAction=\{onLog\} \/>/);
  assert.match(mod, /Not shown while wellness data is unavailable\./);
});

test("detail card: adds sources, readiness breakdown and the device sleep score; the headline values and explanations are no longer repeated", () => {
  const mod = read("components/today/Modules.tsx");
  const card = mod.slice(mod.indexOf("export function WellnessCard"), mod.indexOf("/** APEX Readiness Estimate"));
  assert.ok(!/td-metrics3|<Metric /.test(card), "the HRV / resting HR / sleep value grid is gone from the detail card");
  assert.ok(!/hrvVsBaseline|rhrVsBaseline|WHOOP Recovery|whoop/.test(card), "baseline comparisons and WHOOP recovery live in Key metrics only");
  assert.match(card, /Where today&apos;s numbers come from/); assert.match(card, /sourceText\(r!\.source\)/); assert.match(card, /when\(r!, today\)/);
  assert.match(card, /No sleep goal is set, so sleep is left out of the readiness estimate/);
  assert.match(card, /w\.sleepScore &&/); assert.match(card, /<ReadinessBlock est=\{w\.estimate\} guidanceAbove=\{guidanceAbove\} \/>/);
  // the readiness breakdown keeps everything useful
  for (const keep of ["c.effectiveWeight * 100", "Calculation details: inputs, weights and method", "Only today&apos;s measurements are used", "est.disclaimer", "Insufficient data", "Not used:", "Provisional: too little data"]) assert.ok(mod.includes(keep), `${keep} kept`);
  assert.equal((mod.match(/td-readyscore/g) ?? []).length, 1, "the score circle exists only in the insufficient layout; it is not repeated in the breakdown");
  assert.doesNotMatch(mod.slice(mod.indexOf("export function ReadinessBlock"), mod.indexOf("// ------------------------------------------------------------------ 2 Endurance")), /\bdetail\b/, "no detail/non-detail switch is left in ReadinessBlock");
  assert.match(mod, /Today&apos;s guidance is in the Next step above\. You decide\./);
  assert.match(mod, /est\.guidance \? <p className="small"[^>]*>\{est\.guidance\} You decide\./, "when the Next step card is not showing it, the guidance is still shown here");
  // the headline sleep card says only that no goal is set; the link and the explanation live in the detail card
  const noGoal = wellnessSummary(rows(20, () => ({ hrv_ms: 60, rhr_bpm: 50, sleep_minutes: 420 })), TODAY, null);
  assert.equal(metricSpecs(input({ w: noGoal, sleepGoalH: null }), ["sleep"])[0].context, "No sleep goal set");
  assert.match(css, /\.td-sources li\{display:flex;justify-content:space-between/); assert.match(css, /\.ds-setup\{margin-top:var\(--sp-3\)/);
});

// ------------------------------------------------------------------ HRV specificity
test("HRV card is labelled rMSSD and its explanation does not imply every device measures HRV the same way", () => {
  const good = wellnessSummary(rows(20, (i) => ({ hrv_ms: 60 + (i % 3), rhr_bpm: 50, sleep_minutes: 420 })), TODAY, 8);
  for (const w of [good, null]) {
    const hrv = metricSpecs(input({ w }), ["hrv"])[0];
    assert.equal(hrv.label, "HRV (rMSSD)", "same wording as the previous Today card");
    assert.match(hrv.explain, /shows heart-rate variability \(HRV\) as rMSSD, in milliseconds/);
    assert.match(hrv.explain, /Other apps and devices may report a different HRV measure \(for example SDNN\)/);
    assert.match(hrv.explain, /not comparable with this one/);
    assert.ok(!/all (devices|sources|vendors)|every (device|source)|same on any/i.test(hrv.explain), "no claim that all sources use rMSSD");
  }
  assert.equal(metricSpecs(input({ w: good }), ["hrv"])[0].unit, "ms");
  assert.equal(metricSpecs(input({ w: good }), ["rhr"])[0].label, "Resting heart rate", "other labels are unchanged");
});
