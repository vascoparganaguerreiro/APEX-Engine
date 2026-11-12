"use client";
// Browser loaders for the Today cockpit. Every read runs as the signed-in user (RLS) and every module is independent: a missing
// migration or a failed query affects only its own card ("unavailable"), never the whole page. Nothing here writes data.
import { getSupabase } from "../supabase";
import { addDays } from "../engine";
import { listRacesCompat, type Race } from "../races";
import { loadHistory, loadLinksOrNone, NotSetUp, type Db as StrengthDb } from "../strength/data";
import { loadExcludedActivityIds } from "../strength/dedup";
import { workSets } from "../strength/analytics";
import { resolveExercise } from "../strength/library";
import type { Intake, Schedule, Supplement } from "../health/core";
import type { AssessmentRow } from "../coach/client";
import type { ActLite, DailyRow, PanelLite, ResultLite, StrengthLite } from "./model";

export type Section<T> = { status: "ok"; data: T } | { status: "unavailable"; reason: string };
const msg = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e));
const missing = (e: unknown) => /does not exist|schema cache|could not find|PGRST20[25]|42P01/i.test(msg(e) + String((e as { code?: string } | null)?.code ?? ""));
const unavailable = (e: unknown, setup: string): Section<never> => ({ status: "unavailable", reason: missing(e) ? setup : "Could not load right now." });

/** sleep_goal_h is null unless the profile actually holds a positive value: no default goal is invented. */
export interface ProfileLite { display_name: string | null; timezone: string | null; sleep_goal_h: number | null }
export async function loadProfileLite(): Promise<ProfileLite> {
  const { data } = await getSupabase().from("profiles").select("display_name,timezone,sleep_goal_h").maybeSingle();
  const goal = data?.sleep_goal_h === null || data?.sleep_goal_h === undefined ? NaN : Number(data.sleep_goal_h);
  return { display_name: data?.display_name?.trim() || null, timezone: data?.timezone ?? null, sleep_goal_h: Number.isFinite(goal) && goal > 0 && goal <= 24 ? goal : null };
}

/** Last 45 days of daily wellness with per-field provenance (06). Falls back to the plain columns if provenance is missing. */
export async function loadDaily(today: string): Promise<Section<DailyRow[]>> {
  const sb = getSupabase(), since = addDays(today, -45);
  let r = await sb.from("daily_metrics").select("day,hrv_ms,rhr_bpm,sleep_minutes,sleep_score,hrv_source,rhr_source,sleep_source,sleep_score_source").gte("day", since).order("day");
  if (r.error) r = await sb.from("daily_metrics").select("day,hrv_ms,rhr_bpm,sleep_minutes,sleep_score").gte("day", since).order("day") as typeof r;
  if (r.error) return unavailable(r.error, "Wellness data is not available.");
  return { status: "ok", data: ((r.data ?? []) as DailyRow[]).map((x) => ({ ...x, hrv_ms: x.hrv_ms === null ? null : Number(x.hrv_ms), rhr_bpm: x.rhr_bpm === null ? null : Number(x.rhr_bpm), sleep_minutes: x.sleep_minutes === null ? null : Number(x.sleep_minutes), sleep_score: x.sleep_score === null ? null : Number(x.sleep_score) })) };
}

/** 210 days of activities (CTL needs months), with copies the user merged as duplicates removed (counted once). */
export async function loadActivities(today: string): Promise<Section<ActLite[]>> {
  const sb = getSupabase();
  const [a, links] = await Promise.all([
    sb.from("activities").select("id,started_at,sport,title,duration_s,distance_m,load").gte("started_at", `${addDays(today, -210)}T00:00:00Z`).order("started_at", { ascending: false }).limit(5000),
    loadLinksOrNone(sb as unknown as StrengthDb),
  ]);
  if (a.error) return unavailable(a.error, "Activities are not available.");
  const dup = loadExcludedActivityIds(links);
  return { status: "ok", data: ((a.data ?? []) as ActLite[]).filter((x) => !dup.has(Number(x.id))) };
}

/** Finished strength workouts of the last 40 days (13). */
export async function loadStrength(today: string): Promise<Section<StrengthLite[]>> {
  try {
    const hs = await loadHistory(getSupabase() as unknown as StrengthDb, { keys: null, sinceIso: `${addDays(today, -40)}T00:00:00Z`, max: 400, resolve: (k) => resolveExercise(k, []) });
    return { status: "ok", data: hs.map((s) => ({ id: s.id, title: s.title, startedAt: s.startedAt, endedAt: s.endedAt, pausedSeconds: s.pausedSeconds, sets: s.exercises.reduce((n, e) => n + workSets(e).length, 0), exercises: s.exercises.length })) };
  } catch (e) {
    return { status: "unavailable", reason: e instanceof NotSetUp || missing(e) ? "The Strength Hub needs a database update (migration 13)." : "Could not load right now." };
  }
}

/** A workout in progress on this device (the Strength Hub keeps it locally until it is finished). */
export async function loadActiveWorkout(): Promise<{ title: string; startedAt: string } | null> {
  try {
    const { getEngine } = await import("../strength/runtime");
    const { engine } = await getEngine();
    const w = engine.local.activeId ? engine.local.workouts[engine.local.activeId] : null;
    return w && w.status === "active" ? { title: w.title, startedAt: w.startedAt } : null;
  } catch { return null; }
}

export async function loadBiomarkers(): Promise<Section<{ panel: PanelLite | null; results: ResultLite[] }>> {
  const sb = getSupabase();
  const p = await sb.from("blood_panels").select("id,collected_on,lab_name").order("collected_on", { ascending: false }).limit(1);
  if (p.error) return unavailable(p.error, "Biomarkers need a database update (migration 08).");
  const panel = (p.data?.[0] as PanelLite | undefined) ?? null;
  if (!panel) return { status: "ok", data: { panel: null, results: [] } };
  const r = await sb.from("biomarker_results").select("value,ref_low,ref_high").eq("panel_id", panel.id).limit(500);
  if (r.error) return unavailable(r.error, "Biomarkers are not available.");
  return { status: "ok", data: { panel, results: ((r.data ?? []) as ResultLite[]).map((x) => ({ value: Number(x.value), ref_low: x.ref_low === null ? null : Number(x.ref_low), ref_high: x.ref_high === null ? null : Number(x.ref_high) })) } };
}

export async function loadSupplements(today: string): Promise<Section<{ sups: Supplement[]; schedules: Schedule[]; intakes: Intake[] }>> {
  const sb = getSupabase();
  const [s, c, i] = await Promise.all([
    sb.from("supplements").select("*"), sb.from("supplement_schedules").select("*"),
    sb.from("supplement_intakes").select("supplement_id,slot,day,status").gte("day", addDays(today, -1)).lte("day", addDays(today, 1)),
  ]);
  const err = s.error ?? c.error ?? i.error;
  if (err) return unavailable(err, "Supplements need a database update (migration 08).");
  return { status: "ok", data: { sups: (s.data ?? []) as Supplement[], schedules: (c.data ?? []) as Schedule[], intakes: (i.data ?? []) as Intake[] } };
}

/** Races for Today. Works before migration 10 (falls back to the original columns), so existing races always show. */
export async function loadRaces(): Promise<Section<Race[]>> {
  try { return { status: "ok", data: (await listRacesCompat(getSupabase())).races }; }
  catch { return { status: "unavailable", reason: "Races could not be loaded right now." }; }
}

/** The most recent saved Daily Coach analysis (12). Reading it costs nothing; a new one is only made when the user asks. */
export async function loadLatestDaily(): Promise<Section<AssessmentRow | null>> {
  const { data, error } = await getSupabase().from("coach_assessments").select("id,kind,mode,sport,score,confidence,result,created_at").eq("kind", "daily").order("created_at", { ascending: false }).limit(1);
  if (error) return unavailable(error, "The Coach needs a database update (migration 12).");
  return { status: "ok", data: (data?.[0] as AssessmentRow | undefined) ?? null };
}

/** WHOOP Recovery, if WHOOP is connected (14). A WHOOP-specific score, shown under its own name only. */
export async function loadWhoopRecovery(): Promise<{ value: number; day: string | null } | null> {
  try {
    const { data, error } = await getSupabase().from("metric_observations").select("value,local_day").eq("provider", "whoop").eq("metric", "whoop.recovery_score").order("measured_at", { ascending: false }).limit(1);
    if (error || !data?.[0]) return null;
    return { value: Number(data[0].value), day: data[0].local_day ?? null };
  } catch { return null; }
}

export async function loadIntervalsConnected(): Promise<boolean> {
  try { const { data } = await getSupabase().from("intervals_connections").select("athlete_id").maybeSingle(); return !!data; } catch { return false; }
}
