// Profile-aware Today: the key insight, the order of the daily summary and the next step adapt to the selected experience, using only data APEX already has.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LENS_OVERVIEW, keyInsight, nextAction, type InsightInput } from "../lib/today/lens.ts";
import { overview, wellnessSummary, type BiomarkerSummary, type DailyRow, type EnduranceSummary, type StrengthSummary, type SupplementSummary } from "../lib/today/model.ts";
import { resolveExperience } from "../lib/experience.ts";

const TODAY = "2026-11-13";
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rows = (n: number, f: (i: number) => Partial<DailyRow>): DailyRow[] => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.UTC(2026, 10, 13 - (n - 1 - i))).toISOString().slice(0, 10);
  return { day: d, hrv_ms: null, rhr_bpm: null, sleep_minutes: null, sleep_score: null, ...f(i) };
});
const good = wellnessSummary(rows(20, (i) => ({ hrv_ms: 60 + (i % 3), rhr_bpm: 50, sleep_minutes: 420 })), TODAY, 8);
const none = wellnessSummary([], TODAY, 8);
const endur = { last: { day: "2026-11-12", title: "Easy run", sport: "run" }, week: { sessions: 3, load: 180, durationS: 9000, prevLoad: 150, prevSessions: 2 }, bars: [], form: { ctl: 40, atl: 50, tsb: -10, state: "Productive training" } } as unknown as EnduranceSummary;
const strength = { last: { day: "2026-11-11", title: "Legs" }, thisWeekSets: 12, avgWeeklySets4: null, weekSessions: 2 } as unknown as StrengthSummary;
const bio = { panel: { collected_on: "2026-10-30" }, results: 12, outside: 2, noRange: 1, daysAgo: 14 } as unknown as BiomarkerSummary;
const base = (o: Partial<InsightInput> = {}): InsightInput => ({ w: null, e: null, st: null, b: null, sleepGoalH: null, today: TODAY, ...o });

test("each experience reads a different set of signals", () => {
  const all = base({ w: good, e: endur, st: strength, b: bio, sleepGoalH: 8 });
  const p = keyInsight("performance", all).text, w = keyInsight("wellness", all).text, l = keyInsight("longevity", all).text;
  assert.match(p, /Readiness estimate/); assert.match(p, /Training form: Productive training \(TSB -10\)/); assert.match(p, /Load over the last 7 days: 180 from 3 sessions, against 150/);
  assert.match(w, /Sleep today: 7 h 00 min \(your goal: 8 h\)/); assert.match(w, /Active sessions: 5/); assert.doesNotMatch(w, /TSB|Readiness estimate/);
  assert.match(l, /Latest blood test 14 days ago: 12 results, 2 outside the reference range and 1 without one/); assert.match(l, /Strength: 2 sessions this week/); assert.match(l, /HRV today is/);
  assert.notEqual(p, w); assert.notEqual(w, l); assert.notEqual(p, l);
});

test("missing data is named, never filled in", () => {
  const part = keyInsight("longevity", base({ st: strength }));
  assert.equal(part.empty, false); assert.match(part.text, /Strength: 2 sessions this week\./); assert.match(part.text, /Not yet available: biomarkers, recovery signals\./);
  assert.doesNotMatch(part.text, /blood test|HRV/);
  for (const lens of ["performance", "wellness", "longevity"] as const) {
    const e = keyInsight(lens, base({ w: none }));
    assert.equal(e.empty, true, lens); assert.match(e.text, /Not enough data yet for the .* view\. Needed: /, lens); assert.doesNotMatch(e.text, /\d/, `${lens}: no number invented`);
  }
  assert.doesNotMatch(keyInsight("performance", base({ w: good })).text, /Training form|Load over/, "no training data: no training sentence");
  assert.match(keyInsight("performance", base({ w: good })).text, /Not yet available: training form, weekly training load\./);
  assert.doesNotMatch(keyInsight("wellness", base({ w: good })).text, /Active sessions/, "activity not loaded: not claimed as zero");
  assert.match(keyInsight("wellness", base({ w: good, e: { ...endur, week: { ...endur.week, sessions: 0 } } as EnduranceSummary })).text, /Active sessions: 0/, "a loaded week with none is a real zero");
});

test("the insight states facts: no advice, no good or bad", () => {
  const all = base({ w: good, e: endur, st: strength, b: bio, sleepGoalH: 8 });
  for (const lens of ["performance", "wellness", "longevity"] as const) assert.doesNotMatch(keyInsight(lens, all).text, /\b(should|must|good|bad|healthy|unhealthy|risk|diagnos|improve)\b/i, lens);
});

test("the daily summary keeps every sentence and only changes their order", () => {
  const sup = { active: 2, due: [], taken: 0, skipped: 0, pending: 2 } as SupplementSummary;
  const a = { w: good, e: endur, st: strength, sup, race: null, today: TODAY };
  const perf = overview(a, LENS_OVERVIEW.performance), well = overview(a, LENS_OVERVIEW.wellness), lon = overview(a, LENS_OVERVIEW.longevity);
  assert.deepEqual(overview(a), perf, "the original order is the Performance order");
  for (const l of [well, lon]) assert.deepEqual([...l].sort(), [...perf].sort(), "same sentences");
  assert.match(perf[1], /^Last session/); assert.match(well[1], /supplement dose/); assert.match(lon[1], /^Last session/);
  for (const k of ["wellness", "last", "race", "supplements"]) for (const l of ["performance", "wellness", "longevity"] as const) assert.ok(LENS_OVERVIEW[l].includes(k as never), `${l} keeps ${k}`);
});

test("next step: safety and data-availability steps are the same in every experience", () => {
  for (const lens of ["performance", "wellness", "longevity"] as const) {
    const a = (o = {}) => nextAction({ w: good, loading: false, activeWorkout: null, sup: null, lens, ...o });
    assert.equal(a({ activeWorkout: { title: "Legs" } }).kind, "resume-workout", lens);
    assert.equal(a({ problem: "Could not load." }).kind, "data-unavailable", lens);
    assert.equal(a({ w: none }).kind, "log-wellness", lens);
    assert.equal(a({ loading: true, w: null }).kind, "loading", lens);
    assert.equal(a().kind, "readiness-guidance", `${lens}: the readiness guidance is still the engine's own`); assert.equal(a().detail, good.estimate.status === "ok" ? good.estimate.guidance : "");
  }
});

test("next step: Health & Wellness puts unlogged supplement doses first; others keep the guidance", () => {
  const sup = { active: 1, due: [], taken: 0, skipped: 0, pending: 1 } as SupplementSummary;
  assert.equal(nextAction({ w: good, loading: false, activeWorkout: null, sup, lens: "wellness" }).kind, "log-supplements");
  assert.equal(nextAction({ w: good, loading: false, activeWorkout: null, sup, lens: "performance" }).kind, "readiness-guidance");
  assert.equal(nextAction({ w: good, loading: false, activeWorkout: null, sup, lens: "longevity" }).kind, "readiness-guidance");
  assert.equal(nextAction({ w: good, loading: false, activeWorkout: null, sup }).kind, "readiness-guidance", "no experience given: unchanged behaviour");
  assert.equal(nextAction({ w: none, loading: false, activeWorkout: null, sup, lens: "wellness" }).kind, "log-wellness", "missing wellness still comes first");
});

// A routine day, built by hand so the fallback branches always run: today's wellness is complete (state "current"), there is no readiness guidance to show
// (the estimate is "insufficient"), nothing is in progress and no supplement dose is pending. Nothing here depends on the calculation engine.
const routine = { ...good, state: "current", estimate: { status: "insufficient", name: "APEX Readiness Estimate", reasons: [], disclaimer: "" } } as unknown as typeof good;
const calm = (lens?: "performance" | "wellness" | "longevity", bioState?: { loaded: boolean; summary: BiomarkerSummary | null }) =>
  nextAction({ w: routine, loading: false, activeWorkout: null, sup: null, lens, bio: bioState });

test("the hand-built routine day really reaches the routine-day branch (guard for the tests below)", () => {
  assert.equal(routine.state, "current"); assert.equal(routine.estimate.status, "insufficient");
  const r = calm("performance");
  assert.equal(r.kind, "ask-coach"); assert.equal(r.title, "Plan with the Coach"); assert.equal(r.cta?.href, "/coach?tab=daily");
  assert.equal(calm().kind, "ask-coach", "no experience given: the same step as before experiences existed");
});

test("Longevity, routine day, with a blood panel: review it, using only the panel's own numbers", () => {
  const n = calm("longevity", { loaded: true, summary: bio });
  assert.equal(n.kind, "review-biomarkers"); assert.equal(n.title, "Review your biomarkers");
  assert.equal(n.detail, "Your latest blood test is 14 days old: 12 results, 2 outside the reference range.");
  assert.deepEqual(n.cta, { label: "Open Biomarkers", href: "/biomarkers" }); assert.equal(n.badge, null);
  const today = calm("longevity", { loaded: true, summary: { ...bio, daysAgo: 0, results: 1, outside: 0 } as BiomarkerSummary });
  assert.equal(today.detail, "Your latest blood test is from today: 1 result, 0 outside the reference range.");
  assert.match(calm("longevity", { loaded: true, summary: { ...bio, daysAgo: 1 } as BiomarkerSummary }).detail, /is 1 day old/);
});

test("Longevity, routine day, with no blood panel: offer to add one, claiming nothing about results", () => {
  const n = calm("longevity", { loaded: true, summary: null });
  assert.equal(n.kind, "add-biomarkers"); assert.equal(n.title, "Add a blood test");
  assert.match(n.detail, /^No blood test is recorded yet\./); assert.doesNotMatch(n.detail, /\d/, "no number is invented");
  assert.deepEqual(n.cta, { label: "Open Biomarkers", href: "/biomarkers" });
});

test("Longevity, routine day, blood tests still loading or unavailable: nothing is claimed about them", () => {
  // `loaded` is false until the section loaded fine; the page also passes false when the section failed. Either way: the neutral step, no biomarker wording.
  for (const bioState of [{ loaded: false, summary: null }, { loaded: false, summary: bio }, undefined]) {
    const n = calm("longevity", bioState);
    assert.equal(n.kind, "ask-coach", JSON.stringify(bioState)); assert.doesNotMatch(n.title + n.detail, /blood|biomarker/i);
    assert.equal(n.cta?.href, "/coach?tab=daily");
  }
  assert.match(read("app/(app)/today/page.tsx"), /bio: \{ loaded: bio\?\.status === "ok", summary: b \}/, "an unavailable section is passed as not loaded");
});

test("Health & Wellness, routine day: review the week; Performance keeps the Coach step", () => {
  const n = calm("wellness");
  assert.equal(n.kind, "review-activity"); assert.equal(n.title, "Review your week");
  assert.equal(n.detail, "Your wellness is in. Look back at your sessions this week, or ask the Coach about sleep and habits.");
  assert.deepEqual(n.cta, { label: "Open Activities", href: "/activities" });
  assert.deepEqual(calm("wellness", { loaded: true, summary: bio }), n, "blood tests play no part in the Health & Wellness step");
  assert.equal(calm("performance", { loaded: true, summary: bio }).kind, "ask-coach", "Performance is unaffected by blood tests");
});

test("routine-day steps never override a higher-priority step", () => {
  const sup = { active: 1, due: [], taken: 0, skipped: 0, pending: 1 } as SupplementSummary;
  const b = { loaded: true, summary: bio };
  assert.equal(nextAction({ w: routine, loading: false, activeWorkout: { title: "Legs" }, sup: null, lens: "longevity", bio: b }).kind, "resume-workout");
  assert.equal(nextAction({ w: routine, loading: false, activeWorkout: null, sup: null, problem: "Could not load.", lens: "longevity", bio: b }).kind, "data-unavailable");
  assert.equal(nextAction({ w: none, loading: false, activeWorkout: null, sup: null, lens: "longevity", bio: b }).kind, "log-wellness");
  assert.equal(nextAction({ w: routine, loading: false, activeWorkout: null, sup, lens: "longevity", bio: b }).kind, "log-supplements", "pending doses come before a routine-day step");
  assert.equal(nextAction({ w: routine, loading: false, activeWorkout: null, sup, lens: "wellness" }).kind, "log-supplements");
});

test("Automatic mode and the selected experience feed the same view", () => {
  const page = read("app/(app)/today/page.tsx");
  assert.match(page, /const \{ lens, basis \} = resolveExperience\(chosenExperience, primaryGoal\);/);
  assert.match(page, /overview\(\{ w, e, st, sup, race, today \}, LENS_OVERVIEW\[lens\]\)/);
  assert.match(page, /lens, bio: \{ loaded: bio\?\.status === "ok", summary: b \}/);
  assert.match(page, /keyInsight\(lens, \{ w, e, st, b, sleepGoalH: goal, today \}\)/);
  assert.match(page, /daily === null \|\| wellnessProblem \? null : keyInsight/, "no insight while loading or when wellness data could not be loaded");
  assert.match(page, /<p className=\{`td-insight\$\{insight\.empty \? " none" : ""\}`\}><b>Key insight<\/b> \{insight\.text\}<\/p>/);
  assert.deepEqual(resolveExperience(null, "health"), { lens: "longevity", basis: "goal" }, "Automatic follows the goal");
  assert.deepEqual(resolveExperience("wellness", "race_performance"), { lens: "wellness", basis: "chosen" });
});

test("scope: every module stays, calculations untouched, no storage or network", () => {
  const page = read("app/(app)/today/page.tsx"), lens = read("lib/today/lens.ts");
  assert.match(page, /LENS_SECTIONS\[lens\]\.filter\(\(k\) => !hidden\[k\]\)\.map\(\(k\) => cards\[k\]\)/);
  for (const keep of ["<NextActionCard", "<KeyMetrics", "<FiveDay","<TrendChart", "wellnessSummary(daily.data"]) assert.ok(page.includes(keep), `${keep} still on Today`);
  assert.doesNotMatch(lens, /readinessEstimate\(|wellnessSummary\(|enduranceSummary\(|strengthSummary\(|biomarkerSummary\(|tsbState\(|fetch\(|supabase|localStorage/, "lens.ts only reads existing summaries");
  assert.match(read("app/globals.css"), /\.td-insight\{/);
});
