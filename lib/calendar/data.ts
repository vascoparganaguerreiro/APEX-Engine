// Training Calendar data access (Phase 1). The database client is passed in (browser client in the app, a fake in tests).
// Every failure becomes a SafeError whose message is safe to show; the technical detail goes to the log only.
import { SafeError, NOT_SET_UP_MESSAGE, friendlyError } from "../userError.ts";
import { loadLinksOrNone, pageAll, type Db as StrengthDb } from "../strength/data.ts";
import { strengthExcludedIds } from "../strength/dedup.ts";
import type { DoneStrength, PlannedInput, PlannedWorkout, WorkoutStep } from "./model.ts";
import { linkProblem, validatePlanned } from "./model.ts";

export interface Db { from(table: string): any }

export const PLANNED_COLUMNS = "id,planned_date,kind,sport,title,duration_min,distance_m,intensity,routine_id,structure,notes,status,completed_at,completed_activity_id,completed_strength_session_id,link_origin,source";

/** "The table is not there": decided ONLY from the Postgres / PostgREST code, never from message text. */
export const isMissingPlannedTable = (e: unknown): boolean => ["42P01", "PGRST202", "PGRST205"].includes(String((e as { code?: string } | null)?.code ?? ""));
const isUniqueViolation = (e: unknown): boolean => String((e as { code?: string } | null)?.code ?? "") === "23505";

const fail = (e: { message?: string; code?: string } | null | undefined, what: string): never => {
  if (isMissingPlannedTable(e)) { friendlyError(e, what, { scope: "calendar.not-set-up" }); throw new SafeError("not-set-up", NOT_SET_UP_MESSAGE, false); }
  const u = friendlyError(e ?? new Error("Request failed"), what, { scope: "calendar" });
  throw new SafeError(u.kind, u.message, u.retryable);
};
const notFound = () => new SafeError("other", "This planned workout was not found.", false);

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
export function plannedFromRow(r: Record<string, unknown>): PlannedWorkout {
  const structure = Array.isArray(r.structure) ? (r.structure as WorkoutStep[]) : null;
  return {
    id: String(r.id), planned_date: String(r.planned_date).slice(0, 10), kind: r.kind as PlannedWorkout["kind"], sport: (r.sport as string | null) ?? null,
    title: String(r.title ?? ""), duration_min: num(r.duration_min), distance_m: num(r.distance_m), intensity: (r.intensity as string | null) ?? null,
    routine_id: (r.routine_id as string | null) ?? null, structure, notes: (r.notes as string | null) ?? null,
    status: (r.status as PlannedWorkout["status"]) ?? "planned", completed_at: (r.completed_at as string | null) ?? null,
    completed_activity_id: num(r.completed_activity_id), completed_strength_session_id: (r.completed_strength_session_id as string | null) ?? null,
    link_origin: (r.link_origin as PlannedWorkout["link_origin"]) ?? null, source: (r.source as PlannedWorkout["source"]) ?? "manual",
  };
}

const WRITABLE = ["planned_date", "kind", "sport", "title", "duration_min", "distance_m", "intensity", "routine_id", "structure", "notes"] as const;
/** Only the form's columns pass through. user_id, status, completion and link columns can never be written through create/update. */
export function writablePlanned(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of WRITABLE) if (k in input) out[k] = input[k];
  return out;
}

/** Finished, non-deleted strength workouts whose start lies in [fromIso, toIso). Only the columns the calendar shows are read (no sets or
 *  exercises). Paged, so a response capped by PostgREST can never silently truncate a range; merged duplicates are excluded exactly as
 *  everywhere else (strengthExcludedIds). Throws NotSetUp / SafeError like the other strength reads. */
export async function loadStrengthRange(db: StrengthDb, fromIso: string, toIso: string): Promise<DoneStrength[]> {
  const [rows, links] = await Promise.all([
    pageAll<Record<string, unknown>>((from, to) => db.from("strength_sessions").select("id,title,started_at,ended_at,paused_seconds")
      .is("deleted_at", null).eq("status", "completed").gte("started_at", fromIso).lt("started_at", toIso)
      .order("started_at", { ascending: true }).order("id", { ascending: true }).range(from, to), { size: 500, max: 5000 }),
    loadLinksOrNone(db),
  ]);
  const dup = strengthExcludedIds(links);
  return rows.filter((r) => !dup.has(String(r.id))).map((r) => ({
    id: String(r.id), title: String(r.title ?? "Workout"), startedAt: String(r.started_at), endedAt: (r.ended_at as string | null) ?? null, pausedSeconds: Number(r.paused_seconds ?? 0) || 0,
  }));
}

/** Plans in [from, to] (inclusive). */
export async function listPlanned(db: Db, from: string, to: string): Promise<PlannedWorkout[]> {
  const { data, error } = await db.from("planned_workouts").select(PLANNED_COLUMNS).gte("planned_date", from).lte("planned_date", to).order("planned_date").limit(2000);
  if (error) fail(error, "Your planned workouts could not be loaded");
  return ((data ?? []) as Record<string, unknown>[]).map(plannedFromRow);
}

export async function createPlanned(db: Db, uid: string, input: PlannedInput): Promise<PlannedWorkout> {
  const v = validatePlanned(input); if (v) throw new SafeError("other", v, false);
  const { data, error } = await db.from("planned_workouts").insert({ ...writablePlanned(input as unknown as Record<string, unknown>), user_id: uid }).select(PLANNED_COLUMNS).single();
  if (error) fail(error, "The planned workout could not be saved");
  return plannedFromRow(data as Record<string, unknown>);
}

/** Updates by id only; user_id is never written. Another user's plan matches no row (RLS) and is reported as not found. */
export async function updatePlanned(db: Db, id: string, input: PlannedInput): Promise<PlannedWorkout> {
  const v = validatePlanned(input); if (v) throw new SafeError("other", v, false);
  const { data, error } = await db.from("planned_workouts").update(writablePlanned(input as unknown as Record<string, unknown>)).eq("id", id).select(PLANNED_COLUMNS);
  if (error) fail(error, "The planned workout could not be saved");
  if (!data || data.length === 0) throw notFound();
  return plannedFromRow(data[0] as Record<string, unknown>);
}

export async function deletePlanned(db: Db, id: string): Promise<void> {
  const { data, error } = await db.from("planned_workouts").delete().eq("id", id).select("id");
  if (error) fail(error, "The planned workout could not be deleted");
  if (!data || data.length === 0) throw notFound();
}

const setStatus = async (db: Db, id: string, patch: Record<string, unknown>, what: string): Promise<PlannedWorkout> => {
  const { data, error } = await db.from("planned_workouts").update(patch).eq("id", id).select(PLANNED_COLUMNS);
  if (error) fail(error, what);
  if (!data || data.length === 0) throw notFound();
  return plannedFromRow(data[0] as Record<string, unknown>);
};
const CLEAR = { completed_at: null, completed_activity_id: null, completed_strength_session_id: null, link_origin: null };

/** The user says "I did this" without attaching a recorded session. */
export const markCompleted = (db: Db, id: string, now: Date = new Date()) =>
  setStatus(db, id, { status: "completed", completed_at: now.toISOString(), completed_activity_id: null, completed_strength_session_id: null, link_origin: null }, "The planned workout could not be updated");
export const markSkipped = (db: Db, id: string) => setStatus(db, id, { status: "skipped", ...CLEAR }, "The planned workout could not be updated");
/** Back to "planned": also removes a link, which frees the recorded session for another plan. */
export const reopenPlanned = (db: Db, id: string) => setStatus(db, id, { status: "planned", ...CLEAR }, "The planned workout could not be updated");

/** Links a plan to a recorded session after the user confirmed it (manually or by accepting a suggestion). The client check gives a clear
 *  message; the unique indexes in 15_training_calendar.sql are the real guarantee, and a violation is reported the same way. */
export async function linkPlanned(db: Db, plan: PlannedWorkout, rec: { kind: "activity" | "strength"; id: string }, all: PlannedWorkout[], origin: "manual" | "confirmed_match", now: Date = new Date()): Promise<PlannedWorkout> {
  const problem = linkProblem(plan, rec, all);
  if (problem) throw new SafeError("other", problem, false);
  const patch = {
    status: "completed", completed_at: now.toISOString(), link_origin: origin,
    completed_activity_id: rec.kind === "activity" ? Number(rec.id) : null, completed_strength_session_id: rec.kind === "strength" ? rec.id : null,
  };
  const { data, error } = await db.from("planned_workouts").update(patch).eq("id", plan.id).select(PLANNED_COLUMNS);
  if (error) {
    if (isUniqueViolation(error)) throw new SafeError("other", "That session is already linked to a planned workout.", false);
    fail(error, "The planned workout could not be updated");
  }
  if (!data || data.length === 0) throw notFound();
  return plannedFromRow(data[0] as Record<string, unknown>);
}
