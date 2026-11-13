import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  biomarkerSummary, dayIn, enduranceSummary, fiveDays, freshnessOf, greeting, hourIn, insightView, longDate, overview, relDay, shortDate, strengthSummary,
  readinessEstimate, supplementSummary, userZone, wellnessSummary, type ActLite, type DailyRow, type StrengthLite,
} from "../lib/today/model.ts";
import { addDays, trendSeries } from "../lib/engine.ts";
import type { Race } from "../lib/races.ts";
import type { Schedule, Supplement } from "../lib/health/core.ts";

const TODAY = "2026-11-12";   // a Thursday
const row = (day: string, o: Partial<DailyRow> = {}): DailyRow => ({ day, hrv_ms: null, rhr_bpm: null, sleep_minutes: null, sleep_score: null, ...o });

// ------------------------------------------------------------------ time zone and labels
test("today and the greeting follow the user's time zone, not the server's", () => {
  const instant = new Date("2026-11-12T23:30:00Z");
  assert.equal(dayIn(instant, "Europe/Lisbon"), "2026-11-12");
  assert.equal(dayIn(instant, "Asia/Tokyo"), "2026-11-13", "already tomorrow in Tokyo");
  assert.equal(dayIn(instant, "America/Los_Angeles"), "2026-11-12");
  assert.equal(hourIn(new Date("2026-11-12T07:15:00Z"), "Europe/Lisbon"), 7);
  assert.equal(hourIn(new Date("2026-07-12T07:15:00Z"), "Europe/Lisbon"), 8, "summer time");
  assert.equal(greeting(7), "Good morning"); assert.equal(greeting(13), "Good afternoon"); assert.equal(greeting(20), "Good evening"); assert.equal(greeting(2), "Hello");
  assert.equal(userZone("Europe/Lisbon", "UTC"), "Europe/Lisbon");
  assert.equal(userZone("Not/AZone", "America/New_York"), "America/New_York", "an invalid profile zone falls back to the device");
  assert.equal(userZone(null, undefined), "UTC");
  assert.equal(shortDate(TODAY), "Thu 12 Nov"); assert.equal(longDate(TODAY), "Thursday, 12 November 2026");
  assert.equal(relDay("2026-11-11", TODAY), "yesterday"); assert.equal(relDay("2026-11-09", TODAY), "3 days ago"); assert.equal(relDay("2026-11-15", TODAY), "in 3 days");
});

// ------------------------------------------------------------------ wellness integrity
test("yesterday's HRV and sleep are shown as yesterday's, never as today's", () => {
  const w = wellnessSummary([row("2026-11-11", { hrv_ms: 60, rhr_bpm: 50, sleep_minutes: 420, hrv_source: "intervals" })], TODAY, 8);
  assert.equal(w.hrv!.day, "2026-11-11"); assert.equal(w.hrv!.freshness, "yesterday"); assert.equal(w.hrv!.source, "intervals");
  assert.equal(w.state, "stale"); assert.equal(w.estimate.status, "insufficient", "no readiness from yesterday's data");
  assert.ok(w.estimate.status === "insufficient" && /No wellness entry for today/.test(w.estimate.reasons[0]));
  assert.equal(freshnessOf("2026-11-09", TODAY), "stale"); assert.equal(freshnessOf(null, TODAY), "missing");
});

test("each metric keeps its own day; a field missing today is not filled with zero or with today's date", () => {
  const w = wellnessSummary([row("2026-11-10", { sleep_minutes: 400 }), row(TODAY, { hrv_ms: 55, sleep_minutes: null })], TODAY, 8);
  assert.equal(w.hrv!.freshness, "today"); assert.equal(w.sleep!.day, "2026-11-10"); assert.equal(w.sleep!.freshness, "stale");
  assert.equal(w.rhr, null, "never measured: null, not 0"); assert.equal(w.state, "partial");
  assert.equal(wellnessSummary([], TODAY, 8).state, "missing");
  assert.equal(wellnessSummary([row("2026-11-13", { hrv_ms: 70 })], TODAY, 8).hrv, null, "a future-dated row is ignored");
});

// ------------------------------------------------------------------ APEX Readiness Estimate (regression)
/** `n` prior days ending yesterday, with a slight day-to-day variation so the HRV standard deviation is realistic. */
const history = (n: number, o: Partial<DailyRow> = { hrv_ms: 60, rhr_bpm: 50, sleep_minutes: 450 }) =>
  Array.from({ length: n }, (_, i) => row(addDays(TODAY, -(n - i)), { ...o, ...(o.hrv_ms != null ? { hrv_ms: (o.hrv_ms as number) + (i % 2 ? 3 : -3) } : {}) }));
const est = (rows: DailyRow[], goal: number | null = 8) => readinessEstimate(rows, TODAY, goal);

test("estimate: named 'APEX Readiness Estimate' and labelled as an estimate, not a clinical measurement", () => {
  const ok = est([...history(20), row(TODAY, { hrv_ms: 60, rhr_bpm: 50, sleep_minutes: 480 })]);
  const no = est([]);
  for (const e of [ok, no]) { assert.equal(e.name, "APEX Readiness Estimate"); assert.match(e.disclaimer, /estimate/i); assert.match(e.disclaimer, /not a clinical measurement/i); }
  const ui = readFileSync(new URL("../components/today/Modules.tsx", import.meta.url), "utf8");
  assert.match(ui, /Insufficient data/); assert.match(ui, /est\.disclaimer/);
  // the confidence is still shown: in the Key metrics card (its details and the Provisional badge), no longer as a second pill in the breakdown block
  const lens = readFileSync(new URL("../lib/today/lens.ts", import.meta.url), "utf8");
  assert.match(lens, /\$\{ok\.confidence\} confidence\$\{ok\.provisional \? " \(provisional\)" : ""\}/); assert.doesNotMatch(ui, /conf-\$\{est\.confidence\}|CONF_TEXT/);
});

test("estimate: at least two valid inputs from TODAY are required; HRV alone gives 'Insufficient data'", () => {
  const h = history(20);
  const hrvOnly = est([...h, row(TODAY, { hrv_ms: 62 })]);
  assert.equal(hrvOnly.status, "insufficient");
  assert.ok(hrvOnly.status === "insufficient" && /only hrv is usable/i.test(hrvOnly.reasons[0]));
  assert.equal(est([...h, row(TODAY, { hrv_ms: 62, rhr_bpm: 49 })]).status, "ok");
  assert.equal(est([...h, row(TODAY, { rhr_bpm: 49, sleep_minutes: 420 })]).status, "ok");
  assert.equal(est(h).status, "insufficient", "no row for today");
});

test("estimate: previous-day values are never substituted for today's", () => {
  const rows = [...history(20), row(addDays(TODAY, -1), { hrv_ms: 60, rhr_bpm: 50, sleep_minutes: 450 }), row(TODAY, { hrv_ms: 62 })];
  const e = est(rows);
  assert.equal(e.status, "insufficient", "yesterday's resting HR and sleep are not used to complete today");
  assert.ok(e.status === "insufficient" && e.reasons.some((r) => /Resting HR: no measurement today/.test(r)) && e.reasons.some((r) => /Sleep: no measurement today/.test(r)));
  // the components that ARE used carry today's value
  const ok = est([...history(20), row(TODAY, { hrv_ms: 70, rhr_bpm: 47 })]);
  assert.ok(ok.status === "ok" && ok.components.find((c) => c.key === "hrv")!.today === 70 && ok.components.find((c) => c.key === "rhr")!.today === 47);
});

test("estimate: invalid or implausible values do not count", () => {
  const h = history(20);
  for (const bad of [{ hrv_ms: 0, rhr_bpm: 50 }, { hrv_ms: 60, rhr_bpm: 400 }, { hrv_ms: 999, sleep_minutes: 400 }, { rhr_bpm: 50, sleep_minutes: 0 }]) {
    assert.equal(est([...h, row(TODAY, bad)]).status, "insufficient", JSON.stringify(bad));
  }
  const e = est([...h, row(TODAY, { hrv_ms: 999, rhr_bpm: 50, sleep_minutes: 450 })]);
  assert.ok(e.status === "ok" && !e.components.some((c) => c.key === "hrv") && e.excluded.some((x) => /HRV: today's value is outside/.test(x)));
});

test("estimate: HRV and resting HR are only used against a personal baseline of at least 5 days (no neutral 50 filler)", () => {
  const short = est([...history(4), row(TODAY, { hrv_ms: 62, rhr_bpm: 49 })]);
  assert.equal(short.status, "insufficient", "two measurements but no baseline to compare them with");
  assert.ok(short.status === "insufficient" && short.reasons.some((r) => /HRV: baseline has 4 days \(needs 5\)/.test(r)));
  const e = est([...history(4), row(TODAY, { hrv_ms: 62, rhr_bpm: 49, sleep_minutes: 480 })]);
  assert.equal(e.status, "insufficient", "only sleep is comparable");
  const noGoal = est([...history(20), row(TODAY, { hrv_ms: 62, sleep_minutes: 480 })], null);
  assert.equal(noGoal.status, "insufficient", "sleep needs the user's own goal as its reference");
  const old = est([...history(10).map((r) => ({ ...r, day: addDays(r.day, -40) })), row(TODAY, { hrv_ms: 62, rhr_bpm: 49 })]);
  assert.equal(old.status, "insufficient", "baseline days older than 28 days do not count");
});

test("estimate: confidence follows data availability and baseline quality; provisional estimates carry no training suggestion", () => {
  const high = est([...history(20), row(TODAY, { hrv_ms: 60, rhr_bpm: 50, sleep_minutes: 480 })]);
  assert.ok(high.status === "ok"); if (high.status !== "ok") return;
  assert.equal(high.confidence, "high"); assert.equal(high.provisional, false); assert.ok(high.guidance && !/Tentative/.test(high.guidance));
  const medium3 = est([...history(8), row(TODAY, { hrv_ms: 60, rhr_bpm: 50, sleep_minutes: 480 })]);
  assert.ok(medium3.status === "ok" && medium3.confidence === "medium" && /^Tentative:/.test(medium3.guidance!));
  const medium2 = est([...history(20), row(TODAY, { hrv_ms: 60, rhr_bpm: 50 })]);
  assert.ok(medium2.status === "ok" && medium2.confidence === "medium");
  const low = est([...history(6), row(TODAY, { hrv_ms: 40, rhr_bpm: 60 })]);
  assert.ok(low.status === "ok"); if (low.status !== "ok") return;
  assert.equal(low.confidence, "low"); assert.equal(low.provisional, true);
  assert.equal(low.guidance, null, "a provisional estimate never produces a training recommendation");
  const lowSleep = est([...history(6), row(TODAY, { hrv_ms: 60, sleep_minutes: 480 })]);
  assert.ok(lowSleep.status === "ok" && lowSleep.guidance === null);
});

test("estimate: deterministic and transparent (same inputs, same score; formula reproducible by hand)", () => {
  const rows = [...history(20, { hrv_ms: 60, rhr_bpm: 52, sleep_minutes: 450 }), row(TODAY, { hrv_ms: 60, rhr_bpm: 48, sleep_minutes: 360 })];
  const a = est(rows), b = est(JSON.parse(JSON.stringify(rows)));
  assert.deepEqual(a, b);
  assert.ok(a.status === "ok"); if (a.status !== "ok") return;
  // HRV at the mean -> z 0 -> 50; RHR 4 bpm below the mean -> (4 + 8) / 16 -> 75; sleep 6 h of 8 -> 75.
  assert.deepEqual(a.components.map((c) => [c.key, c.subscore, c.weight]), [["hrv", 50, 0.45], ["rhr", 75, 0.25], ["sleep", 75, 0.3]]);
  assert.equal(a.score, Math.round(0.45 * 50 + 0.25 * 75 + 0.3 * 75));
  assert.equal(a.band, "mixed");
  assert.ok(a.components.every((c) => c.reference > 0 && c.referenceLabel), "each input shows what it was compared with");
});

// ---- final review regressions
test("baseline: exactly the previous 28 days (today excluded), distinct days, valid values only", () => {
  const t = row(TODAY, { hrv_ms: 60, rhr_bpm: 50 });
  const four = [1, 2, 3, 4].map((n) => row(addDays(TODAY, -n), { hrv_ms: 60, rhr_bpm: 50 }));
  assert.equal(est([...four, row(addDays(TODAY, -28), { hrv_ms: 60, rhr_bpm: 50 }), t]).status, "ok", "today-28 is inside the window");
  assert.equal(est([...four, row(addDays(TODAY, -29), { hrv_ms: 60, rhr_bpm: 50 }), t]).status, "insufficient", "today-29 is outside");
  const e = est([...four, row(addDays(TODAY, -5), { hrv_ms: 60, rhr_bpm: 50 }), t, row(TODAY, { hrv_ms: 60, rhr_bpm: 50 })]);
  assert.ok(e.status === "ok" && e.components.every((c) => c.baselineDays === 5), "today never counts towards its own baseline");
  assert.equal(est([...four, ...four, t]).status, "insufficient", "a duplicated day counts once: 4 distinct days stay 4");
  const withInvalid = [...four, row(addDays(TODAY, -5), { hrv_ms: 0, rhr_bpm: 500 }), row(addDays(TODAY, -6), { hrv_ms: null, rhr_bpm: null }), t];
  assert.equal(est(withInvalid).status, "insufficient", "missing and implausible values do not raise the baseline count");
  const conf = est([...history(20).map((r) => ({ ...r, hrv_ms: r.day < addDays(TODAY, -10) ? 0 : r.hrv_ms })), row(TODAY, { hrv_ms: 60, rhr_bpm: 50, sleep_minutes: 480 })]);
  assert.ok(conf.status === "ok" && conf.components.find((c) => c.key === "hrv")!.baselineDays === 10 && conf.confidence === "medium", "invalid days cannot lift confidence to high");
});

test("sleep: compared with the user's configured goal only; no invented default", () => {
  const rows = [...history(20), row(TODAY, { hrv_ms: 60, sleep_minutes: 420 })];
  for (const g of [null, 0, NaN, -8]) assert.equal(est(rows, g as number | null).status, "insufficient", `goal ${g}`);
  const e = est([...history(20), row(TODAY, { hrv_ms: 60, rhr_bpm: 50, sleep_minutes: 420 })], 7);
  assert.ok(e.status === "ok" && e.components.find((c) => c.key === "sleep")!.reference === 7 && e.components.find((c) => c.key === "sleep")!.subscore === 100);
  assert.equal(wellnessSummary(rows, TODAY, null).estimate.status, "insufficient");
  const load = readFileSync(new URL("../lib/today/load.ts", import.meta.url), "utf8"), page = readFileSync(new URL("../app/(app)/today/page.tsx", import.meta.url), "utf8");
  assert.ok(!/sleep_goal_h\) : 8|sleep_goal_h: 8/.test(load + page), "no 8 h fallback in the loader or the page");
  assert.ok(!/sleep_goal_h \?\? 8/.test(page));
});

test("scoring: effective weights are renormalised, shown as used, and the score is bounded", () => {
  const two = est([...history(20, { hrv_ms: 60, rhr_bpm: 52, sleep_minutes: 450 }), row(TODAY, { hrv_ms: 60, rhr_bpm: 48 })]);
  assert.ok(two.status === "ok"); if (two.status !== "ok") return;
  const w = Object.fromEntries(two.components.map((c) => [c.key, c.effectiveWeight]));
  assert.ok(Math.abs(w.hrv - 0.45 / 0.7) < 1e-12 && Math.abs(w.rhr - 0.25 / 0.7) < 1e-12);
  assert.ok(Math.abs(two.components.reduce((a, c) => a + c.effectiveWeight, 0) - 1) < 1e-12);
  assert.equal(two.score, Math.round((0.45 * 50 + 0.25 * 75) / 0.7), "59, not the 3-input formula with a neutral sleep");
  const ui = readFileSync(new URL("../components/today/Modules.tsx", import.meta.url), "utf8");
  assert.match(ui, /c\.effectiveWeight \* 100/, "the breakdown shows the weight actually used");
  const hi = est([...history(20), row(TODAY, { hrv_ms: 300, rhr_bpm: 20, sleep_minutes: 1440 })]);
  const lo = est([...history(20), row(TODAY, { hrv_ms: 1, rhr_bpm: 250, sleep_minutes: 1 })]);
  assert.ok(hi.status === "ok" && hi.score === 100 && lo.status === "ok" && lo.score === 0);
  assert.ok(hi.status === "ok" && hi.components.every((c) => c.subscore >= 0 && c.subscore <= 100));
});

test("insufficient data never carries a score, band, confidence or recommendation", () => {
  for (const rows of [[], [...history(20), row(TODAY, { hrv_ms: 60 })], [...history(3), row(TODAY, { hrv_ms: 60, rhr_bpm: 50 })]]) {
    const e = est(rows);
    assert.equal(e.status, "insufficient");
    for (const k of ["score", "band", "confidence", "guidance", "components"]) assert.ok(!(k in e), `${k} must be absent`);
  }
});

test("estimate: computed only by APEX's own code; the Coach/LLM never receives, returns or changes it", () => {
  const coachFiles = ["lib/coach/engine.ts", "lib/coach/prompts.ts", "lib/coach/context.ts", "lib/coach/schema.ts", "app/api/coach/route.ts", "components/today/CoachInsight.tsx"];
  for (const f of coachFiles) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.ok(!/readinessEstimate|READINESS_NAME|Readiness Estimate/.test(src), `${f} must not touch the estimate`);
  }
  const page = readFileSync(new URL("../app/(app)/today/page.tsx", import.meta.url), "utf8");
  assert.ok(!/coachRequest|readiness\(/.test(page), "Today never sends the estimate to the Coach and does not use another readiness formula");
  const model = readFileSync(new URL("../lib/today/model.ts", import.meta.url), "utf8");
  assert.ok(!/fetch\(|gemini|coach/i.test(model.replace(/\/\/.*$/gm, "").replace(/Coach insight[\s\S]*?export function insightView/, "")), "the estimate code has no network or AI access");
});

test("baselines compare a reading with the 28 days before ITS OWN day and need at least 5 values", () => {
  const hist = ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"].map((d) => row(d, { hrv_ms: 50 }));
  assert.equal(wellnessSummary([...hist, row(TODAY, { hrv_ms: 60 })], TODAY, 8).hrvVsBaseline, null, "4 values: no baseline claim");
  const w = wellnessSummary([...hist, row("2026-11-09", { hrv_ms: 50 }), row(TODAY, { hrv_ms: 60, rhr_bpm: 52 })], TODAY, 8);
  assert.deepEqual(w.hrvVsBaseline, { mean: 50, days: 5, pct: 20 });
});

// ------------------------------------------------------------------ endurance and strength
const act = (id: number, started_at: string, o: Partial<ActLite> = {}): ActLite => ({ id, started_at, sport: "run", title: "Run", duration_s: 3600, distance_m: 10000, load: 60, ...o });

test("endurance: strength excluded, days in the user's zone, rest days are 'no activity' (null), not zero load", () => {
  const acts = [act(1, "2026-11-11T23:30:00Z"), act(2, "2026-11-10T08:00:00Z", { sport: "strength", load: 40 }), act(3, "2026-11-04T08:00:00Z", { load: 30 })];
  const e = enduranceSummary(acts, trendSeries({}, {}, "2026-10-14", TODAY), TODAY, "Europe/Berlin");
  assert.equal(e.last!.id, 1); assert.equal(e.last!.day, TODAY, "23:30Z is already the 12th in Berlin");
  assert.equal(e.bars.length, 7); assert.equal(e.bars.at(-1)!.load, 60);
  assert.equal(e.bars.find((b) => b.day === "2026-11-10")!.load, null, "the strength session is not endurance");
  assert.equal(e.week.sessions, 1); assert.equal(e.week.prevLoad, 30);
  assert.equal(e.form, null, "no load model claimed from an empty trend");
  assert.equal(enduranceSummary([], [], TODAY, "UTC").last, null);
});

const ses = (id: string, startedAt: string, sets: number, o: Partial<StrengthLite> = {}): StrengthLite => ({ id, title: `W${id}`, startedAt, endedAt: new Date(Date.parse(startedAt) + 3_600_000).toISOString(), pausedSeconds: 0, sets, exercises: 4, ...o });
test("strength: this week from Monday in the user's zone; 4-week average only when earlier weeks exist", () => {
  const s = strengthSummary([ses("a", "2026-11-10T18:00:00Z", 16), ses("b", "2026-11-03T18:00:00Z", 20), ses("c", "2026-10-27T18:00:00Z", 12)], TODAY, "UTC");
  assert.equal(s.last!.id, "a"); assert.equal(s.thisWeekSets, 16); assert.equal(s.weekSessions, 1);
  assert.equal(s.avgWeeklySets4, 8, "(20 + 12 + 0 + 0) / 4");
  assert.equal(s.last!.durationS, 3600);
  const fresh = strengthSummary([ses("a", "2026-11-10T18:00:00Z", 16)], TODAY, "UTC");
  assert.equal(fresh.avgWeeklySets4, null, "no earlier weeks: no average invented");
  assert.equal(strengthSummary([ses("x", "2026-11-12T10:00:00Z", 5, { endedAt: null })], TODAY, "UTC").last, null, "unfinished sessions are not 'latest'");
});

// ------------------------------------------------------------------ biomarkers and supplements
test("biomarkers: outside-range counts use each result's own laboratory range; no range stays unknown", () => {
  const b = biomarkerSummary({ id: "p", collected_on: "2026-10-13", lab_name: "Lab" }, [{ value: 5, ref_low: 1, ref_high: 4 }, { value: 2, ref_low: 1, ref_high: 4 }, { value: 9, ref_low: null, ref_high: null }], TODAY)!;
  assert.deepEqual({ results: b.results, outside: b.outside, noRange: b.noRange, daysAgo: b.daysAgo }, { results: 3, outside: 1, noRange: 1, daysAgo: 30 });
  assert.equal(biomarkerSummary(null, [], TODAY), null);
});

const SUPS: Supplement[] = [
  { id: "s1", name: "Vitamin D", brand: null, ingredients: null, formulation: null, dose: null, dose_unit: null, notes: null, start_date: "2026-01-01", end_date: null, status: "active", discontinuation_reason: null },
  { id: "s2", name: "Old", brand: null, ingredients: null, formulation: null, dose: null, dose_unit: null, notes: null, start_date: "2025-01-01", end_date: "2025-12-31", status: "discontinued", discontinuation_reason: null },
];
const SCHED: Schedule[] = [
  { supplement_id: "s1", slot: "morning", dose: 1000, dose_unit: "IU", days: [1, 2, 3, 4, 5, 6, 7], valid_from: "2026-01-01", valid_to: null },
  { supplement_id: "s1", slot: "dinner", dose: 1000, dose_unit: "IU", days: [1], valid_from: "2026-01-01", valid_to: null },
  { supplement_id: "s2", slot: "morning", dose: 5, dose_unit: "mg", days: [4], valid_from: "2025-01-01", valid_to: null },
];
test("supplements: today's doses from the versioned schedule; unlogged doses are pending, not missed", () => {
  const s = supplementSummary(SUPS, SCHED, [{ supplement_id: "s1", slot: "morning", day: TODAY, status: "taken" }, { supplement_id: "s1", slot: "morning", day: "2026-11-11", status: "skipped" }], TODAY);
  assert.equal(s.active, 1); assert.equal(s.due.length, 1, "Thursday: only the daily morning dose; the discontinued one is not due");
  assert.equal(s.taken, 1); assert.equal(s.pending, 0);
  const none = supplementSummary(SUPS, SCHED, [], TODAY);
  assert.equal(none.pending, 1); assert.equal(none.due[0].status, null);
});

// ------------------------------------------------------------------ five days
const race = (o: Partial<Race>): Race => ({ id: 1, name: "City 10k", race_date: "2026-11-14", race_type: "10k", sport: "running", location: "Lisbon", distance: 10, distance_unit: "km", target_time_s: 2700, priority: "A", goal: null, notes: null, status: "registered", ...o });
test("five days: only real records, completed vs planned, cancelled races and empty days are not padded", () => {
  const days = fiveDays({
    today: TODAY, tz: "UTC", races: [race({}), race({ id: 2, name: "Cancelled", race_date: "2026-11-13", status: "cancelled" })],
    acts: [act(1, "2026-11-12T07:00:00Z"), act(2, "2026-11-11T07:00:00Z")], strength: [ses("a", "2026-11-12T17:00:00Z", 12)],
    activeWorkout: null, sups: SUPS, schedules: SCHED, supToday: supplementSummary(SUPS, SCHED, [], TODAY),
  });
  assert.deepEqual(days.map((d) => d.label), ["Today", "Tomorrow", "Sat", "Sun", "Mon"]);
  const t = days[0].items;
  assert.ok(t.some((i) => i.kind === "activity" && i.status === "done"));
  assert.ok(t.some((i) => i.kind === "strength" && i.status === "done" && i.href === "/strength/history/a"));
  assert.equal(t.filter((i) => i.kind === "activity").length, 1, "yesterday's run is not on today");
  assert.ok(!days[1].items.some((i) => i.kind === "race"), "cancelled race not shown");
  assert.ok(days[2].items.some((i) => i.kind === "race" && i.status === "planned" && i.title === "City 10k"));
  assert.equal(days[4].items.find((i) => i.kind === "supplements")!.title, "2 supplement doses", "Monday has the extra dinner dose");
  assert.ok(days.every((d) => d.items.every((i) => i.kind !== "activity" || d.label === "Today")), "no planned training is invented");
});

// ------------------------------------------------------------------ coach insight
test("coach insight: today's only when made on the user's local today; never invents content", () => {
  const result = { status: "ok", summary: "HRV is close to your baseline.", suggestions: ["Keep today easy-moderate."], caution: null, confidence: "medium", categories_sent: ["wellness", "load"], facts: [{}, {}], missing: ["No profile baselines."] };
  const v = insightView({ created_at: "2026-11-12T06:00:00Z", result }, TODAY, "Europe/Lisbon")!;
  assert.equal(v.forToday, true); assert.equal(v.suggestion, "Keep today easy-moderate."); assert.deepEqual(v.basedOn, ["daily wellness", "training load"]); assert.equal(v.facts, 2);
  assert.equal(insightView({ created_at: "2026-11-11T23:30:00Z", result }, TODAY, "America/Los_Angeles")!.forToday, false, "still the 11th in Los Angeles");
  assert.equal(insightView({ created_at: "2026-11-11T23:30:00Z", result }, TODAY, "Asia/Tokyo")!.forToday, true);
  assert.equal(insightView(null, TODAY, "UTC"), null);
  const bare = insightView({ created_at: "2026-11-12T06:00:00Z", result: { status: "needs_data" } }, TODAY, "UTC")!;
  assert.equal(bare.status, "needs_data"); assert.equal(bare.headline, null); assert.equal(bare.suggestion, null);
});

test("overview names missing and stale data instead of hiding it", () => {
  const stale = wellnessSummary([row("2026-11-09", { hrv_ms: 50 })], TODAY, 8);
  const lines = overview({ w: stale, e: null, st: null, sup: supplementSummary(SUPS, SCHED, [], TODAY), race: race({}), today: TODAY });
  assert.match(lines[0], /No wellness data for today yet \(latest: 3 days ago\)/);
  assert.ok(lines.some((l) => /City 10k in 2 days/.test(l)));
  assert.ok(lines.some((l) => /1 supplement dose still to log/.test(l)));
  assert.match(overview({ w: wellnessSummary([], TODAY, 8), e: null, st: null, sup: null, race: null, today: TODAY })[0], /No wellness data yet/);
});

// ------------------------------------------------------------------ wiring (in addition to the behaviour tests above)
test("Today reuses the existing write paths and never calls the AI without a click", () => {
  const ql = readFileSync(new URL("../components/today/QuickLog.tsx", import.meta.url), "utf8");
  assert.match(ql, /rpc\("apply_manual_metrics"/, "manual wellness goes through 06's atomic function");
  assert.match(ql, /buildManualPatch\(/);
  assert.match(ql, /onConflict: "user_id,supplement_id,slot,day"/);
  const ci = readFileSync(new URL("../components/today/CoachInsight.tsx", import.meta.url), "utf8");
  assert.ok(!/useEffect/.test(ci), "no automatic Coach request on page load");
  assert.match(ci, /authorizedOf\(consent\)/, "the Coach's own consent choices are used");
  const ld = readFileSync(new URL("../lib/today/load.ts", import.meta.url), "utf8");
  assert.match(ld, /loadExcludedActivityIds\(links\)/, "merged duplicates are counted once");
  assert.ok(!/\.(insert|upsert|update|delete)\(/.test(ld), "loaders never write");
});
