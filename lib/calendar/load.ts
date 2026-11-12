"use client";
// Browser loaders for the calendar. Read-only; each module is independent so a missing migration 15 only disables the planned part.
import { getSupabase } from "../supabase";
import { listPlanned, loadStrengthRange } from "./data";
import { friendlyMessage, logTechnical, SafeError, NOT_SET_UP_MESSAGE } from "../userError";
import { addDaysIso, type DoneActivity, type DoneStrength, type PlannedWorkout } from "./model";
import { loadLinksOrNone, NotSetUp, type Db as StrengthDb } from "../strength/data";
import { loadExcludedActivityIds } from "../strength/dedup";
import type { Section } from "../today/load";

export async function loadPlannedRange(from: string, to: string): Promise<Section<PlannedWorkout[]>> {
  try { return { status: "ok", data: await listPlanned(getSupabase(), from, to) }; }
  catch (e) {
    logTechnical("calendar.load", e);
    if (e instanceof SafeError && e.kind === "not-set-up") return { status: "unavailable", reason: NOT_SET_UP_MESSAGE };
    return { status: "unavailable", reason: friendlyMessage(e, "Your planned workouts could not be loaded", { scope: "calendar.load" }) };
  }
}

/** Real activities in [from, to], padded by a day on each side so a time-zone shift can never drop one (the caller buckets by local day).
 *  Activities that are duplicates of a merged strength session are left out, exactly as on Today. */
export async function loadCompletedActivities(from: string, to: string): Promise<Section<DoneActivity[]>> {
  const sb = getSupabase();
  const [a, links] = await Promise.all([
    sb.from("activities").select("id,started_at,sport,title,duration_s,distance_m").gte("started_at", `${addDaysIso(from, -1)}T00:00:00Z`).lt("started_at", `${addDaysIso(to, 2)}T00:00:00Z`).order("started_at").limit(2000),
    loadLinksOrNone(sb as unknown as StrengthDb),
  ]);
  if (a.error) { logTechnical("calendar.activities", a.error); return { status: "unavailable", reason: friendlyMessage(a.error, "Activities could not be loaded", { scope: "calendar.activities" }) }; }
  const dup = loadExcludedActivityIds(links);
  return { status: "ok", data: ((a.data ?? []) as DoneActivity[]).filter((x) => !dup.has(Number(x.id))) };
}

/** Finished strength workouts in [from, to], padded by a day on each side like the activities (the caller buckets by local day). A
 *  lightweight, date-bounded query: any month, old or new, is complete and no workout trees are loaded. */
export async function loadCompletedStrength(from: string, to: string): Promise<Section<DoneStrength[]>> {
  try {
    return { status: "ok", data: await loadStrengthRange(getSupabase() as unknown as StrengthDb, `${addDaysIso(from, -1)}T00:00:00Z`, `${addDaysIso(to, 2)}T00:00:00Z`) };
  } catch (e) {
    logTechnical("calendar.strength", e);
    if (e instanceof NotSetUp) return { status: "unavailable", reason: NOT_SET_UP_MESSAGE };
    return { status: "unavailable", reason: friendlyMessage(e, "Strength workouts could not be loaded", { scope: "calendar.strength" }) };
  }
}
