// Personalised context for the Coach. Pure functions over rows already loaded under the user's own session (RLS).
// Principles: measured facts are computed here (never by the model); missing data is reported, never filled in;
// each category is only included when the user authorised it AND the question needs it.
import { normalizeMarker, normText, rangeStatus } from "../health/core.ts";
import { normalizeSport, type Category, type CoachSport, type Domain, type Intent } from "./schema.ts";
import type { SessionFacts } from "./scoring.ts";

export interface ActivityRow { id: number; started_at: string; sport: string; title: string | null; duration_s: number | null; distance_m: number | null; avg_hr: number | null; avg_power_w: number | null; load: number | null; rpe: number | null; note: string | null }
export interface DailyRow { day: string; hrv_ms: number | null; rhr_bpm: number | null; sleep_minutes: number | null; sleep_score: number | null }
export interface Fact { label: string; value: string }

// ------------------------------------------------------------------ small helpers
export const dayOf = (iso: string, tz: string): string => {
  try { return new Date(iso).toLocaleDateString("sv-SE", { timeZone: tz || "UTC" }); } catch { return new Date(iso).toISOString().slice(0, 10); }
};
export const addDay = (d: string, n: number) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
export const daysBetween = (a: string, b: string) => { const t = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((t(b) - t(a)) / 86_400_000); };
const nums = (xs: Array<number | null | undefined>): number[] => xs.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (now: number, base: number) => (base === 0 ? null : Math.round(((now - base) / Math.abs(base)) * 100));
const fmtPace = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// ------------------------------------------------------------------ the session being evaluated
export function paceSPerKm(durationS: number | null, distanceM: number | null): number | null {
  return durationS && distanceM && durationS > 0 && distanceM > 0 ? durationS / (distanceM / 1000) : null;
}
export function factsFromActivity(a: ActivityRow, tz: string, objective: string, clarification: string): SessionFacts {
  const sport = normalizeSport(a.sport) ?? "other";
  const dur = a.duration_s ?? null;
  return {
    mode: "completed", sport, date: dayOf(a.started_at, tz), source: "imported", title: a.title, duration_s: dur, distance_m: a.distance_m, avg_hr: a.avg_hr, max_hr: null,
    avg_power_w: a.avg_power_w, pace_s_per_km: ["run", "bike", "swim"].includes(sport) ? paceSPerKm(dur, a.distance_m) : null, load: a.load, rpe: a.rpe,
    objective, structure: clarification, notes: a.note ?? "",
  };
}
export function factsFromManual(m: { sport: CoachSport; date: string; mode: "completed" | "planned"; duration_min: number; distance_km: number | null; objective: string; avg_hr: number | null; max_hr: number | null; pace_s_per_km: number | null; power_w: number | null; rpe: number | null; structure: string; notes: string }, clarification: string): SessionFacts {
  const dur = m.duration_min * 60, dist = m.distance_km === null ? null : m.distance_km * 1000;
  return {
    mode: m.mode, sport: m.sport, date: m.date, source: "manual", title: null, duration_s: dur, distance_m: dist, avg_hr: m.avg_hr, max_hr: m.max_hr, avg_power_w: m.power_w,
    pace_s_per_km: m.pace_s_per_km ?? (["run", "bike", "swim"].includes(m.sport) ? paceSPerKm(dur, dist) : null), load: null, rpe: m.rpe,
    objective: m.objective, structure: [m.structure, clarification].filter(Boolean).join("\n"), notes: m.notes,
  };
}
/** The facts exactly as stored or entered (shown to the user as MEASURED/REPORTED, separate from the Coach's interpretation). */
export function describeSession(f: SessionFacts): Fact[] {
  const out: Fact[] = [{ label: "Type", value: `${f.mode === "planned" ? "Planned" : "Completed"} ${f.sport} session (${f.source === "imported" ? "imported from your data" : "entered by you"})` }, { label: "Date", value: f.date }];
  if (f.title) out.push({ label: "Title", value: f.title });
  if (f.duration_s) out.push({ label: "Duration", value: `${Math.round(f.duration_s / 60)} min` });
  if (f.distance_m) out.push({ label: "Distance", value: `${r1(f.distance_m / 1000)} km` });
  if (f.pace_s_per_km) out.push(f.sport === "bike" ? { label: "Average speed", value: `${r1(3600 / f.pace_s_per_km)} km/h` } : f.sport === "swim" ? { label: "Average pace", value: `${fmtPace(f.pace_s_per_km / 10)} /100 m` } : { label: "Average pace", value: `${fmtPace(f.pace_s_per_km)} /km` });
  if (f.avg_hr) out.push({ label: "Average heart rate", value: `${f.avg_hr} bpm` });
  if (f.max_hr) out.push({ label: "Maximum heart rate", value: `${f.max_hr} bpm` });
  if (f.avg_power_w) out.push({ label: "Average power", value: `${f.avg_power_w} W` });
  if (f.load) out.push({ label: "Training load", value: String(f.load) });
  if (f.rpe) out.push({ label: "RPE", value: `${f.rpe}/10` });
  return out;
}

// ------------------------------------------------------------------ history comparison (never invented: needs real comparable sessions)
export interface HistoryComparison {
  available: boolean; sessionsCompared: number; windowDays: number; note: string;
  medians: { duration_min: number | null; distance_km: number | null; avg_hr: number | null; load: number | null; pace_s_per_km: number | null };
  changes: Fact[];
}
export function compareToHistory(f: SessionFacts, history: ActivityRow[], tz: string, excludeId: number | null = null, windowDays = 56): HistoryComparison {
  const comparable = history.filter((a) => {
    if (excludeId !== null && a.id === excludeId) return false;
    if (normalizeSport(a.sport) !== f.sport || f.sport === "football") return false;
    const d = dayOf(a.started_at, tz), gap = daysBetween(d, f.date);
    return gap > 0 && gap <= windowDays;
  });
  const empty = { duration_min: null, distance_km: null, avg_hr: null, load: null, pace_s_per_km: null };
  if (comparable.length < 3) return { available: false, sessionsCompared: comparable.length, windowDays, note: `Not enough earlier ${f.sport} sessions in the last ${windowDays / 7} weeks to compare (found ${comparable.length}, need 3).`, medians: empty, changes: [] };
  const med = {
    duration_min: median(nums(comparable.map((a) => (a.duration_s ? a.duration_s / 60 : null)))), distance_km: median(nums(comparable.map((a) => (a.distance_m ? a.distance_m / 1000 : null)))),
    avg_hr: median(nums(comparable.map((a) => a.avg_hr))), load: median(nums(comparable.map((a) => a.load))),
    pace_s_per_km: median(nums(comparable.map((a) => paceSPerKm(a.duration_s, a.distance_m)))),
  };
  const changes: Fact[] = [];
  if (f.duration_s && med.duration_min) changes.push({ label: "Duration vs your median", value: `${Math.round(f.duration_s / 60)} min vs ${Math.round(med.duration_min)} min (${signed(pct(f.duration_s / 60, med.duration_min))})` });
  if (f.distance_m && med.distance_km) changes.push({ label: "Distance vs your median", value: `${r1(f.distance_m / 1000)} km vs ${r1(med.distance_km)} km (${signed(pct(f.distance_m / 1000, med.distance_km))})` });
  if (f.avg_hr && med.avg_hr) changes.push({ label: "Average HR vs your median", value: `${f.avg_hr} vs ${Math.round(med.avg_hr)} bpm` });
  if (f.load && med.load) changes.push({ label: "Load vs your median", value: `${f.load} vs ${Math.round(med.load)} (${signed(pct(f.load, med.load))})` });
  if (f.pace_s_per_km && med.pace_s_per_km && f.sport === "run") changes.push({ label: "Pace vs your median", value: `${fmtPace(f.pace_s_per_km)} vs ${fmtPace(med.pace_s_per_km)} /km` });
  return { available: true, sessionsCompared: comparable.length, windowDays, note: `Compared with ${comparable.length} earlier ${f.sport} sessions in the last ${windowDays / 7} weeks. A comparison of numbers, not a judgement on its own.`, medians: med, changes };
}
const signed = (p: number | null) => (p === null ? "n/a" : `${p > 0 ? "+" : ""}${p}%`);

/** Sessions in the 72 hours before the session date, as facts. Evidence for the recovery/scheduling category exists only if the data was loaded. */
export function recoveryContext(f: SessionFacts, history: ActivityRow[], daily: DailyRow[], loaded: { activities: boolean; wellness: boolean }, tz: string, excludeId: number | null = null) {
  const recent = history.filter((a) => a.id !== excludeId).filter((a) => { const gap = daysBetween(dayOf(a.started_at, tz), f.date); return gap >= 0 && gap <= 3 && !(gap === 0 && f.source === "imported" && excludeId === a.id); });
  const evidence = (loaded.activities && history.length > 0) || (loaded.wellness && daily.length > 0);
  const lines: Fact[] = [];
  if (loaded.activities) lines.push({ label: "Sessions in the 3 days before", value: recent.length ? recent.map((a) => `${dayOf(a.started_at, tz)} ${a.sport}${a.duration_s ? ` ${Math.round(a.duration_s / 60)} min` : ""}${a.load ? ` load ${a.load}` : ""}`).join("; ") : "none recorded" });
  return { evidence, lines };
}

// ------------------------------------------------------------------ training load (CTL/ATL/TSB only when valid)
export interface LoadFacts {
  valid: boolean; reason: string | null; ctl: number | null; atl: number | null; tsb: number | null;
  last7: number; prev7: number; trend: "increasing" | "decreasing" | "stable" | "insufficient"; sessionsPerWeek: number[]; lastActivityDay: string | null;
}
export function loadFacts(activities: ActivityRow[], today: string, tz: string): LoadFacts {
  const withLoad = activities.filter((a) => (a.load ?? 0) > 0);
  const byDay = new Map<string, number>();
  for (const a of withLoad) { const d = dayOf(a.started_at, tz); byDay.set(d, (byDay.get(d) ?? 0) + (a.load ?? 0)); }
  const sum = (from: string, to: string) => { let t = 0; for (const [d, v] of byDay) if (d >= from && d <= to) t += v; return t; };
  const last7 = sum(addDay(today, -6), today), prev7 = sum(addDay(today, -13), addDay(today, -7));
  const sessions14 = withLoad.filter((a) => { const g = daysBetween(dayOf(a.started_at, tz), today); return g >= 0 && g < 14; }).length;
  const trend: LoadFacts["trend"] = prev7 <= 0 || sessions14 < 3 ? "insufficient" : last7 > prev7 * 1.2 ? "increasing" : last7 < prev7 * 0.8 ? "decreasing" : "stable";
  const days = [...byDay.keys()].sort();
  const first = days[0] ?? null;
  const spanOk = first !== null && daysBetween(first, today) >= 42, countOk = withLoad.filter((a) => daysBetween(dayOf(a.started_at, tz), today) <= 90).length >= 10;
  let ctl: number | null = null, atl: number | null = null;
  const valid = spanOk && countOk;
  if (valid && first) {
    let c = 0, at = 0;
    for (let d = first; d <= today; d = addDay(d, 1)) { const l = byDay.get(d) ?? 0; c += (l - c) / 42; at += (l - at) / 7; }
    ctl = r1(c); atl = r1(at);
  }
  const perWeek = [0, 1, 2, 3].map((w) => activities.filter((a) => { const g = daysBetween(dayOf(a.started_at, tz), today); return g >= w * 7 && g < (w + 1) * 7; }).length);
  const lastActivityDay = activities.length ? activities.map((a) => dayOf(a.started_at, tz)).sort().at(-1)! : null;
  return {
    valid, reason: valid ? null : !first ? "No activities with a training load yet." : !spanOk ? "Less than 6 weeks of load history, so fitness (CTL) and fatigue (ATL) would not be reliable." : "Fewer than 10 sessions with a load in the last 90 days.",
    ctl, atl, tsb: ctl !== null && atl !== null ? r1(ctl - atl) : null, last7: Math.round(last7), prev7: Math.round(prev7), trend, sessionsPerWeek: perWeek, lastActivityDay,
  };
}
export function loadLines(l: LoadFacts): Fact[] {
  const out: Fact[] = [{ label: "Load, last 7 days vs previous 7", value: l.trend === "insufficient" ? `${l.last7} vs ${l.prev7} (not enough sessions to call a trend)` : `${l.last7} vs ${l.prev7} (${l.trend})` }, { label: "Sessions per week (this week back to 4 weeks ago)", value: l.sessionsPerWeek.join(", ") }];
  out.push(l.valid ? { label: "Fitness / fatigue / form (CTL / ATL / TSB)", value: `${l.ctl} / ${l.atl} / ${l.tsb}` } : { label: "CTL / ATL / TSB", value: `not shown: ${l.reason}` });
  return out;
}

// ------------------------------------------------------------------ daily recovery facts
export interface DailyFacts { lines: Fact[]; missing: string[]; hasData: boolean; latestDay: string | null; staleDays: number | null }
export function dailyFacts(rows: DailyRow[], today: string, sleepGoalH: number | null): DailyFacts {
  const recentFrom = addDay(today, -6), baseFrom = addDay(today, -27);
  const rec = rows.filter((r) => r.day >= recentFrom && r.day <= today), base = rows.filter((r) => r.day >= baseFrom && r.day < recentFrom);
  const lines: Fact[] = [], missing: string[] = [];
  const latest = rows.map((r) => r.day).sort().at(-1) ?? null;
  const stale = latest ? daysBetween(latest, today) : null;
  lines.push({ label: "Latest wellness entry", value: latest ? `${latest} (${stale === 0 ? "today" : `${stale} day${stale === 1 ? "" : "s"} ago`})` : "none" });
  if (!latest) missing.push("No daily wellness entries at all.");
  else if (stale !== null && stale > 0) missing.push(`No wellness entry for today (latest is ${stale} day${stale === 1 ? "" : "s"} old).`);

  const metric = (label: string, pick: (r: DailyRow) => number | null, unit: string, minRecent: number, minBase: number, dp = 0) => {
    const a = nums(rec.map(pick)), b = nums(base.map(pick));
    if (!a.length) { missing.push(`No ${label} in the last 7 days.`); return; }
    const f = (n: number) => String(dp ? r1(n) : Math.round(n));
    lines.push({ label: `${label}, last 7 days`, value: `${f(mean(a))} ${unit} (${a.length} value${a.length === 1 ? "" : "s"})` });
    if (a.length >= minRecent && b.length >= minBase) {
      const d = mean(a) - mean(b);
      lines.push({ label: `${label}, baseline (days 8-28)`, value: `${f(mean(b))} ${unit} (${b.length} values)` }, { label: `${label}, change vs your baseline`, value: `${d > 0 ? "+" : ""}${dp ? r1(d) : Math.round(d)} ${unit}${unit === "ms" && mean(b) ? ` (${signed(pct(mean(a), mean(b)))})` : ""}` });
    } else missing.push(`Not enough ${label} history to compare with your own baseline (need ${minRecent}+ recent and ${minBase}+ earlier values).`);
  };
  metric("HRV", (r) => r.hrv_ms, "ms", 4, 10, 1);
  metric("Resting heart rate", (r) => r.rhr_bpm, "bpm", 4, 10);
  const sleepH = (r: DailyRow) => (r.sleep_minutes ? r.sleep_minutes / 60 : null);
  metric("Sleep duration", sleepH, "h", 4, 10, 1);
  const sc = nums(rec.map((r) => r.sleep_score));
  if (sc.length) lines.push({ label: "Sleep score, last 7 days", value: `${Math.round(mean(sc))} (${sc.length} nights)` }); else missing.push("No sleep score in the last 7 days.");
  if (sleepGoalH) lines.push({ label: "Your sleep goal", value: `${sleepGoalH} h` });
  return { lines, missing, hasData: rows.length > 0, latestDay: latest, staleDays: stale };
}

// ------------------------------------------------------------------ races, blood results, supplements
export interface RaceLite { id: number; name: string; race_date: string; sport: string; distance: number | null; distance_unit: string | null; target_time_s: number | null; priority: string; goal: string | null; status: string }
export function raceLines(races: RaceLite[], today: string, focusId: number | null): Fact[] {
  const up = races.filter((r) => r.race_date >= today && (r.status === "planned" || r.status === "registered")).sort((a, b) => a.race_date.localeCompare(b.race_date));
  const pick = focusId !== null ? up.filter((r) => r.id === focusId) : up.slice(0, 3);
  return pick.map((r) => ({
    label: `${r.priority === "A" ? "Goal race (A)" : `Race (${r.priority})`}`,
    value: `${r.name}, ${r.race_date} (${daysBetween(today, r.race_date)} days), ${r.sport}${r.distance ? `, ${r.distance} ${r.distance_unit ?? ""}` : ""}${r.target_time_s ? `, target ${Math.floor(r.target_time_s / 3600)}:${String(Math.floor((r.target_time_s % 3600) / 60)).padStart(2, "0")}` : ""}${r.goal ? `, goal: ${r.goal.slice(0, 120)}` : ""}`,
  }));
}

export interface ResultRow { original_name: string; marker_key: string | null; value: number; unit: string; ref_low: number | null; ref_high: number | null; flag: string | null; collected_on: string; lab_name: string | null }
const PANEL_WORDS = /(blood (panel|test|work|results)|lab (results|panel|report)|latest panel|my results|análises|exames de sangue|resultados)/i;
/** Only the markers the question is about; the latest panel only when asked for; never the full history. Ranges are each laboratory's own. */
export function biomarkerLines(rows: ResultRow[], question: string): Fact[] {
  if (!rows.length) return [];
  const q = normText(question);
  const named = new Set<string>();
  for (const r of rows) {
    const key = r.marker_key ?? normText(r.original_name), label = r.marker_key ? normalizeMarker(r.original_name)?.label ?? r.original_name : r.original_name;
    const names = [normText(r.original_name), normText(label)].filter((n) => n.length >= 3);
    if (names.some((n) => q.includes(n))) named.add(key);
  }
  let pool: ResultRow[];
  if (named.size) pool = rows.filter((r) => named.has(r.marker_key ?? normText(r.original_name)));
  else if (PANEL_WORDS.test(question)) { const latest = [...rows].sort((a, b) => b.collected_on.localeCompare(a.collected_on))[0].collected_on; pool = rows.filter((r) => r.collected_on === latest); }
  else return [];
  const groups = new Map<string, ResultRow[]>();
  for (const r of pool) { const k = `${r.marker_key ?? normText(r.original_name)}|${r.unit.toLowerCase()}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const lines = [...groups.values()].map((g) => g.sort((a, b) => b.collected_on.localeCompare(a.collected_on)).slice(0, 3)).map((g) => {
    const st = (r: ResultRow) => rangeStatus(r.value, r.ref_low, r.ref_high);
    return { out: g.some((r, i) => i === 0 && st(r) !== "within" && st(r) !== "unknown"), line: { label: g[0].original_name, value: g.map((r) => `${r.collected_on}: ${r.value} ${r.unit} (lab range ${r.ref_low ?? "-"} to ${r.ref_high ?? "-"}${r.flag ? `, lab flag ${r.flag}` : ""}; ${st(r)})`).join(" | ") } };
  }).sort((a, b) => Number(b.out) - Number(a.out)).slice(0, 30).map((x) => x.line);
  return lines;
}
export interface SupplementLite { name: string; start_date: string; end_date: string | null; status: string; schedule: string }
export const supplementLines = (s: SupplementLite[], today: string): Fact[] =>
  s.filter((x) => x.status === "active" && x.start_date <= today).slice(0, 15).map((x) => ({ label: x.name, value: `since ${x.start_date}${x.schedule ? `, ${x.schedule}` : ""}` }));

// ------------------------------------------------------------------ which categories are used for this request
const KEYWORDS: Record<Exclude<Category, "profile">, RegExp> = {
  wellness: /(hrv|variab|resting h|rhr|sleep|slept|recover|tired|fatigue|readiness|energy|stress|sono|cansad|recupera)/i,
  activities: /(train|session|workout|run|ride|swim|bike|cycl|interval|endurance|volume|pace|too much|overtrain|plan|fitness|gym|strength|week|month|focus|improv|treino|corrida|ciclismo|natac)/i,
  load: /(load|ctl|atl|tsb|form\b|fitness|fatigue|overtrain|too much|progress|volume|build|taper|improv)/i,
  races: /(race|marathon|half|10k|triathlon|event|taper|goal|prepar|prova|maratona|compet)/i,
  biomarkers: /(blood|panel|ferritin|vitamin|b12|\blab\b|marker|cholesterol|glucose|hba1c|tsh|iron|hemoglobin|crp|testosterone|cortisol|biomarker|exame|sangue|an.lises)/i,
  supplements: /(supplement|vitamin|creatine|magnesium|omega|caffeine|zinc|protein powder|suplement)/i,
  strength: /(\bgym\b|strength|weight ?lifting|\blift(s|ing)?\b|squat|bench press|deadlift|\b1rm\b|personal record|hypertroph|muscula|gin[aá]sio|agachamento|supino)/i,
};
export interface ContextPlan { categories: Category[]; reasons: Partial<Record<Category, string>>; notSent: Category[] }
/** Strict context selection: authorised AND needed. A short follow-up keeps the topic of the previous turn.
 *  In the gym assistant (domain "strength") the workout itself is always relevant; other categories still need a matching question. */
export function planContext(a: { intent: Intent; question: string; authorized: Category[]; previous: Category[]; domain?: Domain }): ContextPlan {
  const need = new Set<Category>(), reasons: Partial<Record<Category, string>> = {};
  const add = (c: Category, why: string) => { need.add(c); reasons[c] ??= why; };
  if (a.intent === "daily") (["profile", "wellness", "load", "activities", "races"] as Category[]).forEach((c) => add(c, "daily analysis"));
  else if (a.intent === "session") (["profile", "activities", "wellness", "load"] as Category[]).forEach((c) => add(c, "session evaluation"));
  else {
    add("profile", "personal baselines");
    let matched = false;
    if (a.domain === "strength") { add("strength", "gym assistant"); matched = true; }
    for (const [c, re] of Object.entries(KEYWORDS) as Array<[Exclude<Category, "profile">, RegExp]>) {
      if (a.domain === "strength" && c === "activities" && !/(run|ride|swim|bike|cycl|endurance|cardio|corrida)/i.test(a.question)) continue;   // gym words are not an activities question
      if (re.test(a.question)) { add(c, "mentioned in your question"); matched = true; }
    }
    if (a.intent === "plan") { add("races", "race preparation"); add("activities", "race preparation"); add("load", "race preparation"); matched = true; }
    if (!matched && a.question.trim().split(/\s+/).length <= 8) for (const c of a.previous) add(c, "follow-up on the previous topic");
  }
  const categories = (Object.keys(CATEGORY_ORDER) as Category[]).filter((c) => need.has(c) && a.authorized.includes(c));
  return { categories, reasons, notSent: a.authorized.filter((c) => !categories.includes(c)) };
}
const CATEGORY_ORDER: Record<Category, number> = { profile: 0, wellness: 1, load: 2, activities: 3, races: 4, biomarkers: 5, supplements: 6, strength: 7 };

// ------------------------------------------------------------------ assembling the prompt context within a size budget
export interface Block { category: Category | "session" | "history"; title: string; facts: Fact[]; priority: number }
export function assembleContext(blocks: Block[], maxChars: number): { text: string; included: string[]; truncated: string[] } {
  const included: string[] = [], truncated: string[] = [];
  let text = "";
  for (const b of [...blocks].sort((x, y) => x.priority - y.priority)) {
    const body = b.facts.map((f) => `- ${f.label}: ${f.value}`).join("\n");
    const section = `## ${b.title}\n${body || "- (nothing available)"}\n\n`;
    if (text.length + section.length > maxChars) { truncated.push(b.title); continue; }
    text += section; included.push(b.title);
  }
  return { text: text.trim(), included, truncated };
}