// AI training summaries (one activity, or one week): consent, rate limit and payload, with every dependency injected so the exact
// prompt that would go to Gemini is testable. The route (app/api/summarize) only wires Supabase and Gemini in.
//
// CONSENT (the Coach's own categories, chosen by the user in Coach and re-sent with each request; never inferred):
//   activities -> required for any summary: the sessions, their totals and same-sport history. Notes: only the note of the ONE
//                 activity being summarised (as in the Coach, notes are only sent for a session you explicitly ask about). A weekly
//                 summary sends no notes at all.
//   load       -> the CTL / ATL / TSB load model.
//   wellness   -> HRV, resting heart rate, sleep and sleep score (that morning, 7-day and weekly averages). Not even READ without it.
//   races      -> the next race. Not read without it.
// Consent counts only when the request carries X-Coach-Consent: yes (exactly like /api/coach); otherwise nothing is granted.
//
// RATE LIMIT: the durable Coach limiter (consume_coach_quota, 12_coach.sql): Postgres advisory lock per user, server clock, one row
// per allowed request written BEFORE the model is called (so failed calls count), shared Coach budget. Fail closed if unavailable.
import { CATEGORIES, type Category } from "./coach/schema.ts";
import { addDays, daysBetween, loadSeries, tsbState } from "./engine.ts";
import { addDaysIso, localDay, paceLabel, weekStart as mondayOf, weekTotals, type Activity } from "./activities.ts";
import { buildActivityPrompt, buildWeekPrompt, type Brief, type LoadState } from "./summary.ts";

export class SummaryError extends Error {
  status: number; extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) { super(message); this.status = status; this.extra = extra; }
}

export const SUMMARY_CATEGORIES = ["activities", "load", "wellness", "races"] as const;
export type SummaryCategory = (typeof SUMMARY_CATEGORIES)[number];
const NOT_SHARED_TEXT: Record<Exclude<SummaryCategory, "activities">, string> = {
  load: "the training-load model (CTL, ATL, TSB)", wellness: "recovery data (HRV, resting heart rate, sleep)", races: "races",
};
export interface SummaryConsent { granted: Set<SummaryCategory> }

/** Strictly validated consent. Anything malformed is rejected; a missing header or list means NOTHING is granted. */
export function summaryConsent(categories: unknown, header: string | null): SummaryConsent {
  if (categories !== undefined && categories !== null) {
    if (!Array.isArray(categories) || categories.length > CATEGORIES.length || categories.some((c) => !(CATEGORIES as readonly string[]).includes(c as string)) || new Set(categories).size !== categories.length) {
      throw new SummaryError(400, "Invalid data categories.");
    }
  }
  const list = header === "yes" && Array.isArray(categories) ? (categories as Category[]) : [];
  return { granted: new Set(list.filter((c): c is SummaryCategory => (SUMMARY_CATEGORIES as readonly string[]).includes(c))) };
}

export interface Row { id: number; started_at: string; sport: string; title: string | null; duration_s: number | null; distance_m: number | null; avg_hr: number | null; load: number | null; note: string | null }
export interface SummaryDeps {
  timezone(): Promise<string>;                                                  // profile time zone (UTC if none)
  getActivity(id: number): Promise<Row | null>;
  activities(fromDay: string, toDay: string): Promise<Row[]>;                  // merged duplicate copies already removed
  dailyOn(day: string): Promise<{ hrv: number | null; rhr: number | null; sleepH: number | null; sleepScore: number | null } | null>;
  dailyAvg(from: string, to: string): Promise<{ hrv: number | null; rhr: number | null; sleepH: number | null }>;
  nextRace(today: string): Promise<{ name: string; race_date: string } | null>;   // planned/registered, on or after today; throws on error
  consume(kind: "session" | "daily"): Promise<{ allowed: boolean; retryAfterSeconds: number; usageId: string | null }>;
  recordOutcome(usageId: string | null, outcome: "ok" | "error", model: string | null): Promise<void>;
  ask(prompt: string): Promise<{ text: string; model: string }>;
  saveActivitySummary(id: number, text: string): Promise<void>;
  saveWeekSummary(weekStart: string, text: string): Promise<void>;
  now(): Date;
}
export type SummaryRequest = { kind: "activity"; id: number } | { kind: "week"; weekStart: string };
export interface SummaryResult { summary: string; model: string; weekStart?: string; used: SummaryCategory[]; notShared: string[] }

const DIST_SPORTS = ["run", "bike", "swim"];
const avg = (xs: Array<number | null | undefined>) => { const v = xs.filter((x): x is number => x !== null && x !== undefined).map(Number); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
/** A session line. The free-text note is only included when `withNote` is true. */
const brief = (r: Row, tz: string, withNote: boolean): Brief => ({
  day: localDay(r.started_at, tz), sport: r.sport, title: r.title, minutes: Math.round((r.duration_s ?? 0) / 60),
  km: r.distance_m && DIST_SPORTS.includes(r.sport) ? r.distance_m / 1000 : null, pace: paceLabel(r.sport, r.duration_s, r.distance_m),
  avgHr: r.avg_hr, load: r.load, note: withNote ? r.note : null,
});
function loadAt(rows: Row[], tz: string, endDay: string): LoadState {
  const daily: Record<string, number> = {};
  for (const r of rows) { const d = localDay(r.started_at, tz); daily[d] = (daily[d] ?? 0) + (r.load ?? 0); }
  const s = loadSeries(daily, addDays(endDay, -180), endDay).at(-1)!;
  return { ctl: s.ctl, atl: s.atl, tsb: s.tsb, state: tsbState(s.tsb) };
}

export async function runSummary(deps: SummaryDeps, req: SummaryRequest, consent: SummaryConsent): Promise<SummaryResult> {
  const g = consent.granted;
  if (!g.has("activities")) {
    throw new SummaryError(403, "AI summaries need your permission to share Recent activities with the AI. Choose what may be shared in Coach (What the Coach can see), then try again.");
  }
  const notShared = (["load", "wellness", "races"] as const).filter((c) => !g.has(c)).map((c) => NOT_SHARED_TEXT[c]);
  const used = SUMMARY_CATEGORIES.filter((c) => g.has(c));
  const tz = await deps.timezone();
  const today = localDay(deps.now().toISOString(), tz);
  // Next race = the Races page / Today rule (planned or registered, on or after TODAY, soonest first). Never a past, completed, DNF, DNS or
  // cancelled race, and never one from the summarised period's own date. If it cannot be read, the line is left out (not "none").
  const race = async () => {
    if (!g.has("races")) return undefined;
    let r: { name: string; race_date: string } | null;
    try { r = await deps.nextRace(today); } catch { return undefined; }
    if (!r || !(r.race_date >= today)) return null;
    return { name: r.name, days: daysBetween(today, r.race_date) };
  };

  let prompt: string, kind: "session" | "daily", save: (text: string) => Promise<void>, weekStart: string | undefined;
  if (req.kind === "activity") {
    const act = await deps.getActivity(req.id);
    if (!act) throw new SummaryError(404, "Activity not found.");
    const day = localDay(act.started_at, tz);
    const rows = (await deps.activities(addDays(day, -190), addDays(day, 1))).filter((r) => localDay(r.started_at, tz) <= day);
    const before = rows.filter((r) => r.sport === act.sport && r.id !== act.id && r.started_at < act.started_at);
    const last6w = before.filter((r) => localDay(r.started_at, tz) >= addDays(day, -42));
    prompt = buildActivityPrompt({
      today, activity: brief(act, tz, true), sameSportRecent: before.slice(-6).reverse().map((r) => brief(r, tz, false)),
      typical: { sessions: last6w.length, avgMinutes: avg(last6w.map((r) => (r.duration_s ?? 0) / 60)), avgLoad: avg(last6w.map((r) => r.load)) },
      load: g.has("load") ? loadAt(rows, tz, day) : undefined,
      morning: g.has("wellness") ? await deps.dailyOn(day) : undefined,
      sevenDay: g.has("wellness") ? await deps.dailyAvg(addDays(day, -7), addDays(day, -1)) : undefined,
      race: await race(), notShared,
    });
    kind = "session"; save = (t) => deps.saveActivitySummary(act.id, t);
  } else {
    const ws = mondayOf(req.weekStart), we = addDaysIso(ws, 6);
    const rows = await deps.activities(addDays(ws, -190), addDays(we, 1));
    const acts = rows.map((r): Activity => ({ ...r, ai_summary: null, ai_summary_at: null }));
    const thisWeek = weekTotals(acts, ws, tz);
    if (thisWeek.sessions === 0) throw new SummaryError(400, "No sessions recorded that week.");
    const prev = [1, 2, 3, 4].map((k) => weekTotals(acts, addDaysIso(ws, -7 * k), tz));
    const endDay = we < today ? we : today;
    let health: Parameters<typeof buildWeekPrompt>[0]["health"] = undefined;
    if (g.has("wellness")) {
      const [h, hp] = await Promise.all([deps.dailyAvg(ws, we), deps.dailyAvg(addDays(ws, -7), addDays(ws, -1))]);
      health = { hrv: h.hrv, rhr: h.rhr, sleepH: h.sleepH, prevHrv: hp.hrv, prevRhr: hp.rhr, prevSleepH: hp.sleepH };
    }
    prompt = buildWeekPrompt({
      today, weekStart: ws, weekEnd: we, thisWeek, previousWeek: prev[0],
      fourWeekAvg: { sessions: avg(prev.map((p) => p.sessions)) ?? 0, minutes: avg(prev.map((p) => p.minutes)) ?? 0, load: avg(prev.map((p) => p.load)) ?? 0 },
      sessions: rows.filter((r) => { const d = localDay(r.started_at, tz); return d >= ws && d <= we; }).map((r) => brief(r, tz, false)),   // no notes in weekly summaries
      load: g.has("load") ? loadAt(rows.filter((r) => localDay(r.started_at, tz) <= endDay), tz, endDay) : undefined,
      health, race: await race(), notShared,
    });
    kind = "daily"; weekStart = ws; save = (t) => deps.saveWeekSummary(ws, t);
  }

  // Durable limit, consumed only now (bad requests above cost nothing) and BEFORE the model is called, so a failed call still counts.
  const q = await deps.consume(kind);
  if (!q.allowed) {
    const s = Math.max(1, Math.ceil(q.retryAfterSeconds));
    throw new SummaryError(429, `You have reached the AI limit for now. Try again in ${s < 90 ? `about ${s} seconds` : `about ${Math.ceil(s / 60)} minutes`}.`, { retryAfterSeconds: s });
  }
  let out: { text: string; model: string };
  try { out = await deps.ask(prompt); }
  catch (e) { await deps.recordOutcome(q.usageId, "error", null).catch(() => undefined); throw e; }
  await deps.recordOutcome(q.usageId, "ok", out.model).catch(() => undefined);
  await save(out.text);
  return { summary: out.text, model: out.model, ...(weekStart ? { weekStart } : {}), used, notShared };
}
