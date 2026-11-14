import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, loadSeries, tsbState } from "@/lib/engine";
import { addDaysIso, localDay, paceLabel, weekStart as mondayOf, weekTotals, type Activity, type WeekTotals } from "@/lib/activities";
import {
  buildActivityPrompt, buildWeekPrompt, extractText, nextRace, SUMMARY_SYSTEM,
  type Brief, type LoadState,
} from "@/lib/summary";
import { AiUsageError, withAiUsage } from "@/lib/serverAiUsage";
import { GeminiListError, geminiHeaders, generateUrl, isModelName, listRankedModels } from "@/lib/gemini";
import { AuthError, authUser } from "@/lib/serverAuth";

export const runtime = "nodejs";
export const maxDuration = 60;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const COLS = "id,started_at,sport,title,duration_s,distance_m,avg_hr,load,note";
type Row = {
  id: number; started_at: string; sport: string; title: string | null; duration_s: number | null;
  distance_m: number | null; avg_hr: number | null; load: number | null; note: string | null;
};
const DIST_SPORTS = ["run", "bike", "swim"];
let cachedModel: string | null = null;

// ------------------------------------------------------------------ Gemini
async function listModels(key: string): Promise<string[]> {
  try { return await listRankedModels(key); }
  catch (e) { throw new HttpError(e instanceof GeminiListError ? e.status : 502, "model list failed"); }
}

async function generate(key: string, model: string, prompt: string): Promise<string> {
  if (!isModelName(model)) throw new HttpError(404, "bad model name");
  const r = await fetch(generateUrl(model), {
    method: "POST",
    headers: geminiHeaders(key),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SUMMARY_SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });
  if (!r.ok) {
    console.error("Gemini error", model, r.status, (await r.text()).slice(0, 200));
    throw new HttpError(r.status, `gemini ${r.status}`);
  }
  const text = extractText(await r.json());
  if (!text) throw new HttpError(502, "The AI returned an empty answer.");
  return text;
}

async function ask(prompt: string): Promise<{ text: string; model: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new HttpError(500, "The AI is not set up: GEMINI_API_KEY is missing on the server.");
  const candidates: string[] = [];
  const add = (m?: string | null) => { if (m && !candidates.includes(m)) candidates.push(m); };
  add(cachedModel); add(process.env.GEMINI_MODEL);
  let discovered = false, i = 0, last: HttpError | null = null;
  for (;;) {
    if (i >= candidates.length) {
      if (discovered) break;
      try { (await listModels(key)).slice(0, 5).forEach(add); } catch (e) { last = e instanceof HttpError ? e : null; }
      discovered = true;
      continue;
    }
    const model = candidates[i++];
    try {
      const text = await generate(key, model, prompt);
      cachedModel = model;
      return { text, model };
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      last = e;
      if (![403, 404, 429].includes(e.status)) break;      // otherwise try the next model
    }
  }
  if (last?.status === 429) throw new HttpError(429, "The free Gemini quota is used up for now. Try again later.");
  throw new HttpError(502, `The AI service did not answer${last ? ` (${last.status})` : ""}.`);
}

// ---------------------------------------------------------------- Supabase
const avg = (xs: Array<number | null | undefined>) => {
  const v = xs.filter((x): x is number => x !== null && x !== undefined).map(Number);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const toActivity = (r: Row): Activity => ({ ...r, ai_summary: null, ai_summary_at: null });
const brief = (r: Row, tz: string): Brief => ({
  day: localDay(r.started_at, tz), sport: r.sport, title: r.title,
  minutes: Math.round((r.duration_s ?? 0) / 60),
  km: r.distance_m && DIST_SPORTS.includes(r.sport) ? r.distance_m / 1000 : null,
  pace: paceLabel(r.sport, r.duration_s, r.distance_m), avgHr: r.avg_hr, load: r.load, note: r.note,
});

function loadAt(rows: Row[], tz: string, endDay: string): LoadState {
  const daily: Record<string, number> = {};
  for (const r of rows) { const d = localDay(r.started_at, tz); daily[d] = (daily[d] ?? 0) + (r.load ?? 0); }
  const s = loadSeries(daily, addDays(endDay, -180), endDay).at(-1)!;
  return { ctl: s.ctl, atl: s.atl, tsb: s.tsb, state: tsbState(s.tsb) };
}

async function context(sb: SupabaseClient, uid: string, endDay: string, rowsFromDay: string) {
  const [prof, rows, race] = await Promise.all([
    sb.from("profiles").select("timezone").eq("id", uid).maybeSingle(),
    sb.from("activities").select(COLS).gte("started_at", `${rowsFromDay}T00:00:00Z`).lte("started_at", `${addDays(endDay, 1)}T23:59:59Z`).order("started_at"),
    // "Next race" is relative to today, not to the summarised day. One day of slack covers every time zone.
    sb.from("races").select("name,race_date").gte("race_date", addDays(new Date().toISOString().slice(0, 10), -1)).order("race_date").limit(5),
  ]);
  const tz: string = prof.data?.timezone ?? "UTC";
  const today = localDay(new Date().toISOString(), tz);
  return { tz, today, rows: (rows.data ?? []) as Row[], race: nextRace(race.data ?? [], today) };
}

async function dailyAvg(sb: SupabaseClient, from: string, to: string) {
  const { data } = await sb.from("daily_metrics").select("hrv_ms,rhr_bpm,sleep_minutes").gte("day", from).lte("day", to);
  const d = data ?? [];
  return {
    hrv: avg(d.map((x) => x.hrv_ms)), rhr: avg(d.map((x) => x.rhr_bpm)),
    sleepH: avg(d.map((x) => (x.sleep_minutes ? x.sleep_minutes / 60 : null))),
  };
}

// --------------------------------------------------------------- summaries
async function summarizeActivity(sb: SupabaseClient, uid: string, id: number) {
  const { data: a } = await sb.from("activities").select(COLS).eq("id", id).maybeSingle();
  if (!a) throw new HttpError(404, "Activity not found.");
  const act = a as Row;
  const { tz, today, rows, race } = await context(sb, uid, localDay(act.started_at, "UTC"), addDays(localDay(act.started_at, "UTC"), -190));
  const day = localDay(act.started_at, tz);
  const before = rows.filter((r) => r.sport === act.sport && r.id !== act.id && r.started_at < act.started_at);
  const last6w = before.filter((r) => localDay(r.started_at, tz) >= addDays(day, -42));
  const m = await sb.from("daily_metrics").select("hrv_ms,rhr_bpm,sleep_minutes,sleep_score").eq("day", day).maybeSingle();
  const seven = await dailyAvg(sb, addDays(day, -7), addDays(day, -1));
  const prompt = buildActivityPrompt({
    today, activity: brief(act, tz), sameSportRecent: before.slice(-6).reverse().map((r) => brief(r, tz)),
    typical: { sessions: last6w.length, avgMinutes: avg(last6w.map((r) => (r.duration_s ?? 0) / 60)), avgLoad: avg(last6w.map((r) => r.load)) },
    load: loadAt(rows.filter((r) => localDay(r.started_at, tz) <= day), tz, day),
    morning: m.data ? { hrv: m.data.hrv_ms, rhr: m.data.rhr_bpm, sleepH: m.data.sleep_minutes ? m.data.sleep_minutes / 60 : null, sleepScore: m.data.sleep_score } : null,
    sevenDay: seven, race,
  });
  const { text, model } = await ask(prompt);
  const { error } = await sb.from("activities").update({ ai_summary: text, ai_summary_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new HttpError(500, "Could not save the summary.");
  return { summary: text, model };
}

async function summarizeWeek(sb: SupabaseClient, uid: string, anyDay: string) {
  const ws = mondayOf(anyDay), we = addDaysIso(ws, 6);
  const { tz, today, rows, race } = await context(sb, uid, we, addDays(ws, -190));
  const acts = rows.map(toActivity);
  const side = (t: WeekTotals) => t;
  const thisWeek = side(weekTotals(acts, ws, tz));
  if (thisWeek.sessions === 0) throw new HttpError(400, "No sessions recorded that week.");
  const prev = [1, 2, 3, 4].map((k) => weekTotals(acts, addDaysIso(ws, -7 * k), tz));
  const endDay = we < today ? we : today;
  const [h, hp] = await Promise.all([dailyAvg(sb, ws, we), dailyAvg(sb, addDays(ws, -7), addDays(ws, -1))]);
  const prompt = buildWeekPrompt({
    today, weekStart: ws, weekEnd: we, thisWeek, previousWeek: prev[0],
    fourWeekAvg: { sessions: avg(prev.map((p) => p.sessions)) ?? 0, minutes: avg(prev.map((p) => p.minutes)) ?? 0, load: avg(prev.map((p) => p.load)) ?? 0 },
    sessions: rows.filter((r) => { const d = localDay(r.started_at, tz); return d >= ws && d <= we; }).map((r) => brief(r, tz)),
    load: loadAt(rows.filter((r) => localDay(r.started_at, tz) <= endDay), tz, endDay),
    health: { hrv: h.hrv, rhr: h.rhr, sleepH: h.sleepH, prevHrv: hp.hrv, prevRhr: hp.rhr, prevSleepH: hp.sleepH },
    race,
  });
  const { text, model } = await ask(prompt);
  const { error } = await sb.from("weekly_summaries").upsert(
    { user_id: uid, week_start: ws, summary: text, created_at: new Date().toISOString() }, { onConflict: "user_id,week_start" });
  if (error) throw new HttpError(500, "Could not save the summary.");
  return { summary: text, model, weekStart: ws };
}

// ------------------------------------------------------------------ handler
type Job = { kind: "activity"; id: number } | { kind: "week"; weekStart: string };

function parseBody(body: unknown): Job {
  const b = (body && typeof body === "object" ? body : {}) as { kind?: unknown; id?: unknown; weekStart?: unknown };
  if (b.kind === "activity" && typeof b.id === "number" && Number.isSafeInteger(b.id)) return { kind: "activity", id: b.id };
  if (b.kind === "week" && typeof b.weekStart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.weekStart)) return { kind: "week", weekStart: b.weekStart };
  throw new HttpError(400, "Bad request.");
}

export async function POST(req: Request) {
  try {
    const { sb, uid } = await authUser(req);                            // uid only ever from the verified token; RLS applies to sb
    const job = parseBody(await req.json().catch(() => null));          // bad input is rejected before anything is charged
    // One unit of the daily allowance per AI call (regenerating the same item counts again). The unit is given
    // back if anything below fails (not found, Gemini error, save error), so users are not charged for failures.
    return Response.json(await withAiUsage(uid, "summary", () =>
      job.kind === "activity" ? summarizeActivity(sb, uid, job.id) : summarizeWeek(sb, uid, job.weekStart)));
  } catch (e) {
    if (e instanceof HttpError || e instanceof AiUsageError || e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    console.error(e);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }
}
