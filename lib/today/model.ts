// Today cockpit: pure view-model functions (no React, no Supabase), so every rule about dates, freshness and missing data is tested.
// Principles:
//   * A value is always shown with the calendar day it belongs to. Yesterday's HRV is never presented as today's.
//   * Missing is missing: nothing is filled with zero, carried forward or estimated.
//   * The user's own time zone (profile, else device) decides what "today" is.
//   * Vendor scores (e.g. a sleep score reported to Intervals.icu, WHOOP Recovery) are labelled with their origin and never merged.
//   * The APEX Readiness Estimate is computed here, deterministically, and only from today's measurements (see readinessEstimate).
import { addDays, tsbState, type TrendPoint } from "../engine.ts";
import { addDaysIso, localDay, weekStart } from "../activities.ts";
import { activeOn, dueOn, rangeStatus, type Intake, type Schedule, type Supplement } from "../health/core.ts";
import { countdown, daysUntil, isUpcoming, type Race } from "../races.ts";

// ------------------------------------------------------------------ time
export function validZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
/** The user's zone: the profile's when valid, else this device's, else UTC. */
export function userZone(profileTz: unknown, deviceTz?: string): string {
  if (validZone(profileTz)) return profileTz;
  return validZone(deviceTz) ? deviceTz : "UTC";
}
export const dayIn = (now: Date, tz: string) => now.toLocaleDateString("sv-SE", { timeZone: tz });
export function hourIn(now: Date, tz: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now)) % 24;
}
export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  if (hour >= 18 && hour < 23) return "Good evening";
  return "Hello";
}
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const parts = (day: string) => { const [y, m, d] = day.split("-").map(Number); return { y, m, d, wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }; };
/** "Wed 12 Nov" (calendar arithmetic only: no time zone involved). */
export function shortDate(day: string): string { const p = parts(day); return `${WD[p.wd]} ${p.d} ${MON[p.m - 1]}`; }
export function longDate(day: string): string {
  const p = parts(day);
  return `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][p.wd]}, ${p.d} ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][p.m - 1]} ${p.y}`;
}
/** Plain relative label for a past or future calendar day. */
export function relDay(day: string, today: string): string {
  const n = daysUntil(day, today);
  if (n === 0) return "today";
  if (n === -1) return "yesterday";
  if (n === 1) return "tomorrow";
  return n < 0 ? `${-n} days ago` : `in ${n} days`;
}

// ------------------------------------------------------------------ wellness
export type Freshness = "today" | "yesterday" | "stale" | "missing";
export const freshnessOf = (day: string | null, today: string): Freshness => {
  if (!day) return "missing";
  const n = daysUntil(day, today);                                   // 0 = today, -1 = yesterday, positive = future
  return n >= 0 ? "today" : n === -1 ? "yesterday" : "stale";      // a future-dated row (clock skew) counts as today
};

export interface DailyRow {
  day: string; hrv_ms: number | null; rhr_bpm: number | null; sleep_minutes: number | null; sleep_score: number | null;
  hrv_source?: string | null; rhr_source?: string | null; sleep_source?: string | null; sleep_score_source?: string | null;
}
export interface Reading { value: number; day: string; freshness: Freshness; source: string | null }
const latestOf = (rows: DailyRow[], k: "hrv_ms" | "rhr_bpm" | "sleep_minutes" | "sleep_score", s: "hrv_source" | "rhr_source" | "sleep_source" | "sleep_score_source", today: string): Reading | null => {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i][k];
    if (v !== null && v !== undefined && rows[i].day <= today) return { value: Number(v), day: rows[i].day, freshness: freshnessOf(rows[i].day, today), source: rows[i][s] ?? null };
  }
  return null;
};
export const SOURCE_TEXT: Record<string, string> = { manual: "entered by you", intervals: "synced from Intervals.icu", whoop: "from WHOOP", legacy_unknown: "source not recorded" };

export interface WellnessSummary {
  hrv: Reading | null; rhr: Reading | null; sleep: Reading | null; sleepScore: Reading | null;
  hrvVsBaseline: { mean: number; days: number; pct: number } | null;
  rhrVsBaseline: { mean: number; days: number; diff: number } | null;
  estimate: ReadinessEstimate;
  state: "current" | "partial" | "stale" | "missing"; latestDay: string | null;
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// ------------------------------------------------------------------ APEX Readiness Estimate (deterministic, gated, transparent)
// Rules (all enforced here; no AI is involved, and nothing the Coach returns can change the result):
//   * Inputs come ONLY from today's row. A value from an earlier day is never substituted.
//   * A measurement counts only if it is valid (plausible range) AND can be compared with the user's own reference:
//       HRV and resting HR: the user's personal baseline = valid values from the 28 days before today, at least 5 of them;
//       sleep: the user's own sleep goal (profile).
//   * At least two comparable inputs are required, otherwise the result is "insufficient" (shown as "Insufficient data").
//   * Sub-scores and weights are the same as engine.ts readiness() (HRV 45 %, resting HR 25 %, sleep 30 %, renormalised), but an input
//     without a baseline is EXCLUDED instead of being given a neutral 50.
//   * Confidence depends only on how many inputs were usable and how long the baselines are. A low-confidence (provisional) estimate
//     never carries a training suggestion.
export const READINESS_NAME = "APEX Readiness Estimate";
export const READINESS_DISCLAIMER = "An estimate from your own measurements compared with your own baseline. Not a clinical measurement or a diagnosis.";
export const BASELINE_DAYS = 28, MIN_BASELINE = 5, FULL_BASELINE = 14;
export const VALID = { hrv: [1, 300], rhr: [20, 250], sleepMin: [1, 1440] } as const;
export type EstimateConfidence = "low" | "medium" | "high";
export interface EstimateComponent {
  key: "hrv" | "rhr" | "sleep"; label: string; today: number; unit: string;
  reference: number; referenceLabel: string; baselineDays: number | null; subscore: number;
  /** Nominal weight (HRV 0.45, resting HR 0.25, sleep 0.30). */
  weight: number;
  /** The weight actually used: nominal weight / sum of the nominal weights of the inputs used. Sums to 1 across components. */
  effectiveWeight: number;
}
export type ReadinessEstimate =
  | { status: "ok"; name: typeof READINESS_NAME; score: number; band: "above" | "mixed" | "below"; confidence: EstimateConfidence; provisional: boolean;
      components: EstimateComponent[]; excluded: string[]; guidance: string | null; disclaimer: string }
  | { status: "insufficient"; name: typeof READINESS_NAME; reasons: string[]; disclaimer: string };

const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const validIn = (v: unknown, [lo, hi]: readonly [number, number]): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const pstdev = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
const r1 = (x: number) => Math.round(x * 10) / 10;

const GUIDANCE: Record<"above" | "mixed" | "below", string> = {
  above: "Your measured signals are at or above your usual. Training as planned looks reasonable.",
  mixed: "Your signals are mixed compared with your usual. Consider training as planned without adding extra intensity.",
  below: "Your signals are below your usual. Consider an easier session or more recovery, and go by how you feel.",
};

/** One row per calendar day (the database guarantees this; enforced here too so a duplicated row can never count twice). The LAST
 *  row given for a day wins. */
const byDay = (rows: DailyRow[]): DailyRow[] => [...new Map(rows.map((r) => [r.day, r])).values()].sort((a, b) => a.day.localeCompare(b.day));
/** Valid values of one field from DISTINCT days in [from, to) . Missing and implausible values are dropped, so they never count. */
function baselineValues(rows: DailyRow[], k: "hrv_ms" | "rhr_bpm", from: string, to: string): number[] {
  return byDay(rows).filter((r) => r.day >= from && r.day < to).map((r) => (r[k] === null || r[k] === undefined ? null : Number(r[k])))
    .filter((v): v is number => validIn(v, k === "hrv_ms" ? VALID.hrv : VALID.rhr));
}

export function readinessEstimate(rowsIn: DailyRow[], today: string, sleepGoalH: number | null): ReadinessEstimate {
  const rows = byDay(rowsIn.filter((r) => r.day <= today));
  const t = rows.find((r) => r.day === today) ?? null;                    // TODAY's row only: no other day is ever substituted
  const from = addDays(today, -BASELINE_DAYS);                              // previous 28 days: today-28 .. today-1, today excluded
  const comps: Array<Omit<EstimateComponent, "effectiveWeight">> = [], excluded: string[] = [];

  const hrvBase = baselineValues(rows, "hrv_ms", from, today);
  if (!t || t.hrv_ms === null || t.hrv_ms === undefined) excluded.push("HRV: no measurement today");
  else if (!validIn(Number(t.hrv_ms), VALID.hrv)) excluded.push("HRV: today's value is outside a plausible range");
  else if (hrvBase.length < MIN_BASELINE) excluded.push(`HRV: baseline has ${hrvBase.length} day${hrvBase.length === 1 ? "" : "s"} (needs ${MIN_BASELINE})`);
  else {
    const m = mean(hrvBase), sd = Math.max(pstdev(hrvBase), 0.05 * m), z = (Number(t.hrv_ms) - m) / sd;
    comps.push({ key: "hrv", label: "HRV", today: Number(t.hrv_ms), unit: "ms", reference: r1(m), referenceLabel: `your ${hrvBase.length}-day average`, baselineDays: hrvBase.length, subscore: Math.round(((clip(z, -2, 2) + 2) / 4) * 100), weight: 0.45 });
  }
  const rhrBase = baselineValues(rows, "rhr_bpm", from, today);
  if (!t || t.rhr_bpm === null || t.rhr_bpm === undefined) excluded.push("Resting HR: no measurement today");
  else if (!validIn(Number(t.rhr_bpm), VALID.rhr)) excluded.push("Resting HR: today's value is outside a plausible range");
  else if (rhrBase.length < MIN_BASELINE) excluded.push(`Resting HR: baseline has ${rhrBase.length} day${rhrBase.length === 1 ? "" : "s"} (needs ${MIN_BASELINE})`);
  else {
    const m = mean(rhrBase), delta = m - Number(t.rhr_bpm);                     // lower than usual is better
    comps.push({ key: "rhr", label: "Resting HR", today: Number(t.rhr_bpm), unit: "bpm", reference: r1(m), referenceLabel: `your ${rhrBase.length}-day average`, baselineDays: rhrBase.length, subscore: Math.round(((clip(delta, -8, 8) + 8) / 16) * 100), weight: 0.25 });
  }
  if (!t || t.sleep_minutes === null || t.sleep_minutes === undefined) excluded.push("Sleep: no measurement today");
  else if (!validIn(Number(t.sleep_minutes), VALID.sleepMin)) excluded.push("Sleep: today's value is outside a plausible range");
  else if (!sleepGoalH || !Number.isFinite(sleepGoalH) || sleepGoalH <= 0) excluded.push("Sleep: no sleep goal set in your profile");
  else {
    const h = Number(t.sleep_minutes) / 60;
    comps.push({ key: "sleep", label: "Sleep", today: r1(h), unit: "h", reference: sleepGoalH, referenceLabel: "your sleep goal", baselineDays: null, subscore: Math.round(clip(h / sleepGoalH, 0, 1) * 100), weight: 0.3 });
  }

  if (comps.length < 2) {
    return { status: "insufficient", name: READINESS_NAME, disclaimer: READINESS_DISCLAIMER,
      reasons: [!t ? "No wellness entry for today yet." : `Needs at least two of HRV, resting HR and sleep measured today and comparable with your baseline; ${comps.length === 1 ? `only ${comps[0].label.toLowerCase()} is usable` : "none is usable"}.`, ...excluded] };
  }
  const totalW = comps.reduce((a, c) => a + c.weight, 0);
  const used: EstimateComponent[] = comps.map((c) => ({ ...c, effectiveWeight: c.weight / totalW }));
  // Sub-scores are each in [0, 100] and the effective weights sum to 1, so the score is always in [0, 100].
  const score = clip(Math.round(used.reduce((a, c) => a + c.effectiveWeight * c.subscore, 0)), 0, 100);
  const baseDays = comps.map((c) => c.baselineDays).filter((d): d is number => d !== null);
  const minBase = baseDays.length ? Math.min(...baseDays) : 0;
  // Confidence: from data availability and baseline quality only.
  const confidence: EstimateConfidence = comps.length === 3 && minBase >= FULL_BASELINE ? "high"
    : (comps.length === 3 && minBase >= 7) || (comps.length === 2 && baseDays.length > 0 && minBase >= FULL_BASELINE) ? "medium" : "low";
  const band = score >= 70 ? "above" : score >= 45 ? "mixed" : "below";
  const provisional = confidence === "low";
  return {
    status: "ok", name: READINESS_NAME, score, band, confidence, provisional, components: used, excluded, disclaimer: READINESS_DISCLAIMER,
    guidance: provisional ? null : confidence === "medium" ? `Tentative: ${GUIDANCE[band].charAt(0).toLowerCase()}${GUIDANCE[band].slice(1)}` : GUIDANCE[band],
  };
}

/** rows must be sorted by day ascending. Baselines use the 28 days BEFORE the reading's own day (at least 5 values). */
export function wellnessSummary(rowsIn: DailyRow[], today: string, sleepGoalH: number | null): WellnessSummary {
  const rows = byDay(rowsIn.filter((r) => r.day <= today));
  const hrv = latestOf(rows, "hrv_ms", "hrv_source", today), rhr = latestOf(rows, "rhr_bpm", "rhr_source", today);
  const sleep = latestOf(rows, "sleep_minutes", "sleep_source", today), sleepScore = latestOf(rows, "sleep_score", "sleep_score_source", today);
  // Same baseline rule as the estimate (distinct days, valid values, the 28 days before the reading's own day).
  const before = (day: string, k: "hrv_ms" | "rhr_bpm") => baselineValues(rows, k, addDays(day, -BASELINE_DAYS), day);
  let hrvVsBaseline: WellnessSummary["hrvVsBaseline"] = null, rhrVsBaseline: WellnessSummary["rhrVsBaseline"] = null;
  if (hrv) { const b = before(hrv.day, "hrv_ms"); if (b.length >= 5) { const m = mean(b); hrvVsBaseline = { mean: Math.round(m), days: b.length, pct: Math.round(((hrv.value - m) / m) * 100) }; } }
  if (rhr) { const b = before(rhr.day, "rhr_bpm"); if (b.length >= 5) { const m = mean(b); rhrVsBaseline = { mean: Math.round(m), days: b.length, diff: Math.round(rhr.value - m) }; } }

  const estimate = readinessEstimate(rows, today, sleepGoalH);
  const fresh = [hrv, rhr, sleep].filter((r) => r?.freshness === "today").length;
  const latestDay = rows.length ? rows[rows.length - 1].day : null;
  const state = !hrv && !rhr && !sleep ? "missing" : fresh === 3 ? "current" : fresh > 0 ? "partial" : "stale";
  return { hrv, rhr, sleep, sleepScore, hrvVsBaseline, rhrVsBaseline, estimate, state, latestDay };
}

// ------------------------------------------------------------------ endurance
export interface ActLite { id: number; started_at: string; sport: string; title: string | null; duration_s: number | null; distance_m: number | null; load: number | null }
export interface EnduranceSummary {
  last: (ActLite & { day: string }) | null;
  week: { sessions: number; load: number; durationS: number; prevLoad: number; prevSessions: number };
  bars: Array<{ day: string; load: number | null }>;   // last 7 days; null = no activity that day (not zero load)
  form: { ctl: number; atl: number; tsb: number; state: string } | null;
}
/** Endurance = every activity except strength. Duplicates the user merged must already be removed by the caller. */
export function enduranceSummary(acts: ActLite[], trend: TrendPoint[], today: string, tz: string): EnduranceSummary {
  const end = acts.filter((a) => a.sport !== "strength").map((a) => ({ ...a, day: localDay(a.started_at, tz) })).filter((a) => a.day <= today)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
  const from = addDaysIso(today, -6), prevFrom = addDaysIso(today, -13);
  const inR = (d: string, a: string, b: string) => d >= a && d <= b;
  const cur = end.filter((a) => inR(a.day, from, today)), prev = end.filter((a) => inR(a.day, prevFrom, addDaysIso(from, -1)));
  const sum = (xs: ActLite[], k: "load" | "duration_s") => xs.reduce((n, a) => n + (a[k] ?? 0), 0);
  const bars = Array.from({ length: 7 }, (_, i) => {
    const d = addDaysIso(from, i), on = end.filter((a) => a.day === d);
    return { day: d, load: on.length ? Math.round(sum(on, "load")) : null };
  });
  const hasLoad = trend.some((p) => p.load > 0);
  const last = trend[trend.length - 1];
  return {
    last: end[0] ?? null,
    week: { sessions: cur.length, load: Math.round(sum(cur, "load")), durationS: sum(cur, "duration_s"), prevLoad: Math.round(sum(prev, "load")), prevSessions: prev.length },
    bars,
    form: hasLoad && last ? { ctl: Math.round(last.ctl), atl: Math.round(last.atl), tsb: Math.round(last.tsb), state: tsbState(last.tsb) } : null,
  };
}

// ------------------------------------------------------------------ strength
export interface StrengthLite { id: string; title: string; startedAt: string; endedAt: string | null; pausedSeconds: number; sets: number; exercises: number }
export interface StrengthSummary {
  last: (StrengthLite & { day: string; durationS: number | null }) | null;
  thisWeekSets: number; avgWeeklySets4: number | null; weekSessions: number;
}
/** Working sets this week (Monday start) vs the average of the 4 previous complete weeks (null when there is no history at all). */
export function strengthSummary(sessions: StrengthLite[], today: string, tz: string): StrengthSummary {
  const s = sessions.filter((x) => x.endedAt).map((x) => ({ ...x, day: localDay(x.startedAt, tz) })).filter((x) => x.day <= today).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const mon = weekStart(today);
  const inWeek = (d: string, m: string) => d >= m && d <= addDaysIso(m, 6);
  const weekSets = (m: string) => s.filter((x) => inWeek(x.day, m)).reduce((n, x) => n + x.sets, 0);
  const prev = [1, 2, 3, 4].map((i) => addDaysIso(mon, -7 * i));
  const anyBefore = s.some((x) => x.day < mon && x.day >= prev[3]);
  const last = s[0] ?? null;
  return {
    last: last ? { ...last, durationS: last.endedAt ? Math.max(0, Math.round((Date.parse(last.endedAt) - Date.parse(last.startedAt)) / 1000) - (last.pausedSeconds || 0)) : null } : null,
    thisWeekSets: weekSets(mon), avgWeeklySets4: anyBefore ? Math.round((prev.reduce((n, m) => n + weekSets(m), 0) / 4) * 10) / 10 : null,
    weekSessions: s.filter((x) => inWeek(x.day, mon)).length,
  };
}

// ------------------------------------------------------------------ biomarkers
export interface PanelLite { id: string; collected_on: string; lab_name: string | null }
export interface ResultLite { value: number; ref_low: number | null; ref_high: number | null }
export interface BiomarkerSummary { panel: PanelLite; results: number; outside: number; noRange: number; daysAgo: number }
export function biomarkerSummary(panel: PanelLite | null, results: ResultLite[], today: string): BiomarkerSummary | null {
  if (!panel) return null;
  let outside = 0, noRange = 0;
  for (const r of results) { const st = rangeStatus(Number(r.value), r.ref_low, r.ref_high); if (st === "below" || st === "above") outside++; else if (st === "unknown") noRange++; }
  return { panel, results: results.length, outside, noRange, daysAgo: -daysUntil(panel.collected_on, today) };
}

// ------------------------------------------------------------------ supplements
export interface DoseToday { supplement_id: string; name: string; slot: string; dose: number; dose_unit: string; status: "taken" | "skipped" | null }
export interface SupplementSummary { active: number; due: DoseToday[]; taken: number; skipped: number; pending: number }
const SLOT_ORDER: Record<string, number> = { morning: 0, lunch: 1, dinner: 2 };
export function supplementSummary(sups: Supplement[], schedules: Schedule[], intakes: Intake[], today: string): SupplementSummary {
  const names = new Map(sups.map((s) => [s.id, s.name]));
  const log = new Map(intakes.filter((i) => i.day === today).map((i) => [`${i.supplement_id}|${i.slot}`, i.status]));
  const due = dueOn(today, sups, schedules).map((d) => ({ ...d, name: names.get(d.supplement_id) ?? "Supplement", status: log.get(`${d.supplement_id}|${d.slot}`) ?? null }))
    .sort((a, b) => (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9) || a.name.localeCompare(b.name));
  return {
    active: sups.filter((s) => s.status === "active" && activeOn(s, today)).length, due,
    taken: due.filter((d) => d.status === "taken").length, skipped: due.filter((d) => d.status === "skipped").length, pending: due.filter((d) => d.status === null).length,
  };
}

// ------------------------------------------------------------------ five days
export type DayItemKind = "race" | "activity" | "strength" | "workout_active" | "supplements";
export interface DayItem { kind: DayItemKind; title: string; detail: string; status: "planned" | "done" | "in_progress"; href: string }
export interface DayCol { day: string; label: string; items: DayItem[] }

/** Today and the next four days. Only real records appear: races on their date; activities and strength sessions already done today;
 *  a workout in progress; supplement doses scheduled for that day (with today's completion). APEX has no training calendar, so there
 *  are no invented planned sessions. */
export function fiveDays(a: {
  today: string; tz: string; races: Race[]; acts: ActLite[]; strength: StrengthLite[]; activeWorkout: { title: string; startedAt: string } | null;
  sups: Supplement[]; schedules: Schedule[]; supToday: SupplementSummary | null;
}): DayCol[] {
  return Array.from({ length: 5 }, (_, i) => {
    const day = addDaysIso(a.today, i), items: DayItem[] = [];
    // Same rule as the Races page (isUpcoming): planned or registered, on or after today. Completed, DNF, DNS and cancelled races are
    // not shown as upcoming; each race appears once, on its own date.
    for (const r of a.races.filter((x) => x.race_date === day && isUpcoming(x, a.today))) {
      items.push({ kind: "race", title: r.name, detail: `${r.priority === "A" ? "Goal race" : `Priority ${r.priority}`}${r.location ? ` · ${r.location}` : ""}`, status: "planned", href: `/races/${r.id}` });
    }
    if (i === 0) {
      for (const x of a.acts.filter((x) => localDay(x.started_at, a.tz) === day)) {
        items.push({ kind: "activity", title: x.title || (x.sport === "strength" ? "Strength" : x.sport[0].toUpperCase() + x.sport.slice(1)), detail: x.sport, status: "done", href: "/activities" });
      }
      for (const s of a.strength.filter((x) => x.endedAt && localDay(x.startedAt, a.tz) === day)) {
        items.push({ kind: "strength", title: s.title, detail: `${s.sets} working set${s.sets === 1 ? "" : "s"}`, status: "done", href: `/strength/history/${s.id}` });
      }
      if (a.activeWorkout) items.push({ kind: "workout_active", title: a.activeWorkout.title, detail: "Workout in progress", status: "in_progress", href: "/strength" });
    }
    const due = i === 0 && a.supToday ? a.supToday.due.length : dueOn(day, a.sups, a.schedules).length;
    if (due > 0) {
      const done = i === 0 && a.supToday ? a.supToday.taken + a.supToday.skipped : 0;
      items.push({ kind: "supplements", title: `${due} supplement dose${due === 1 ? "" : "s"}`, detail: i === 0 ? `${done} of ${due} logged` : "scheduled", status: i === 0 && done === due ? "done" : "planned", href: "/supplements" });
    }
    return { day, label: i === 0 ? "Today" : i === 1 ? "Tomorrow" : shortDate(day).slice(0, 3), items };
  });
}

// ------------------------------------------------------------------ Coach insight (from a saved Daily Coach analysis; no AI call here)
export interface InsightView {
  forToday: boolean; day: string; status: "ok" | "needs_data"; headline: string | null; suggestion: string | null; caution: string | null;
  confidence: string; basedOn: string[]; facts: number; missing: string[];
}
const CAT_LABEL: Record<string, string> = { wellness: "daily wellness", activities: "recent activities", load: "training load", profile: "profile baselines", races: "races", biomarkers: "biomarkers", supplements: "supplements" };
/** The saved analysis as a compact card. It counts as today's only when it was made on the user's local today. */
export function insightView(row: { created_at: string; result: Record<string, unknown> } | null, today: string, tz: string): InsightView | null {
  if (!row || !row.result || typeof row.result !== "object") return null;
  const r = row.result as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const day = localDay(row.created_at, tz);
  return {
    forToday: day === today, day, status: r.status === "ok" ? "ok" : "needs_data", headline: s(r.summary), suggestion: arr(r.suggestions)[0] ?? null, caution: s(r.caution),
    confidence: typeof r.confidence === "string" ? r.confidence : "low", basedOn: arr(r.categories_sent).map((c) => CAT_LABEL[c] ?? c),
    facts: Array.isArray(r.facts) ? r.facts.length : 0, missing: arr(r.missing).slice(0, 3),
  };
}

// ------------------------------------------------------------------ overview
export function nextRaceInfo(race: Race | null, today: string) {
  if (!race) return null;
  const cd = countdown(race.race_date, today);
  return cd.past ? null : { race, cd };
}

/** Two or three short, factual sentences. Missing and stale data are named, never hidden. */
export function overview(a: { w: WellnessSummary; e: EnduranceSummary | null; st: StrengthSummary | null; sup: SupplementSummary | null; race: Race | null; today: string }): string[] {
  const out: string[] = [];
  const { w } = a;
  if (w.state === "missing") out.push("No wellness data yet: log a day or connect a device.");
  else if (w.state === "current") out.push("Today's HRV, resting HR and sleep are in.");
  else {
    const have = ([["HRV", w.hrv], ["resting HR", w.rhr], ["sleep", w.sleep]] as const).filter(([, r]) => r?.freshness === "today").map(([n]) => n);
    out.push(have.length ? `Today so far: ${have.join(" and ")}. The rest is from earlier days.` : `No wellness data for today yet (latest: ${w.latestDay ? relDay(w.latestDay, a.today) : "none"}).`);
  }
  const lastTrain = [a.e?.last ? { day: a.e.last.day, what: (a.e.last.title || a.e.last.sport) } : null, a.st?.last ? { day: a.st.last.day, what: a.st.last.title } : null]
    .filter((x): x is { day: string; what: string } => !!x).sort((x, y) => y.day.localeCompare(x.day))[0];
  if (lastTrain) out.push(`Last session ${relDay(lastTrain.day, a.today)}: ${lastTrain.what}.`);
  const r = nextRaceInfo(a.race, a.today);
  if (r && r.cd.days <= 120) out.push(`${r.race.name} ${r.cd.days === 0 ? "is today" : r.cd.days === 1 ? "is tomorrow" : `in ${r.cd.days} days`}.`);
  if (a.sup && a.sup.pending > 0) out.push(`${a.sup.pending} supplement dose${a.sup.pending === 1 ? "" : "s"} still to log.`);
  return out;
}
