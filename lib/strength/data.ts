// Strength Hub data access. Every call runs with the signed-in user's own Supabase client, so row level security limits it to their rows.
// No credentials are read. A missing table or function (migration 13 not applied yet) is reported as NotSetUp, never as a crash.
import { workingExercises, workingSetCount, type HSession } from "./analytics.ts";
import { strengthExcludedIds, type ActivitySource, type Decision, type Link, type StrengthSource } from "./dedup.ts";
import { exerciseFromCustom, type CustomExerciseRow } from "./library.ts";
import { routineFromRow, routinePayload, type Routine } from "./routines.ts";
import { TransportError, type Op, type OpResult, type SendAuth, type Transport } from "./sync.ts";
import { NOT_SET_UP_MESSAGE, SafeError, friendlyError } from "../userError.ts";
import type { Exercise, LoadMode, SetType, WeightUnit } from "./types.ts";
import type { WExercise, WSet, Workout } from "./workout.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Db { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): any }
/** A CONFIRMED missing table / column / function (see isMissing). The message is safe to show; the migration number stays in code and logs. */
export class NotSetUp extends SafeError { constructor() { super("not-set-up", NOT_SET_UP_MESSAGE, false); this.name = "NotSetUp"; } }
interface PgError { message?: string; code?: string; details?: string; hint?: string }
/** PostgREST / Postgres answers for "this table/column/function does not exist". */
export function isMissing(e: PgError | null | undefined): boolean {
  if (!e) return false;
  return ["42P01", "42703", "42883", "PGRST200", "PGRST202", "PGRST204", "PGRST205"].includes(e.code ?? "") || /does not exist|could not find the (table|function|relation)|schema cache/i.test(e.message ?? "");
}
const fail = (e: PgError | null | undefined): never => {
  if (isMissing(e)) throw new NotSetUp();
  const u = friendlyError(e ?? new Error("Request failed"), "That could not be completed", { scope: "strength.data" });     // raw database text never reaches the screen
  throw new SafeError(u.kind, u.message, u.retryable);
};
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// ------------------------------------------------------------------ sync transport (apply_strength_ops)
/** The `sub` (user id) claim of a JWT. Used only to confirm that the token names the user that was verified. */
export function jwtSubject(token: string): string | null {
  try {
    const p = token.split(".")[1]; if (!p) return null;
    const json = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(p.length / 4) * 4, "="))) as { sub?: unknown };
    return typeof json.sub === "string" ? json.sub.toLowerCase() : null;
  } catch { return null; }
}
export function supabaseTransport(db: Db, isOnline: () => boolean = () => true): Transport {
  return {
    async send(ops: Op[], auth?: SendAuth): Promise<OpResult[]> {
      if (!isOnline()) throw new TransportError("offline", "offline");
      let res: { data: unknown; error: PgError | null };
      try {
        let q = db.rpc("apply_strength_ops", { p_ops: ops });
        if (auth) {
          // Bind the request to the session that was verified. supabase-js only fills in Authorization when the request has none, so
          // setting it here means the verified token is used, not whichever session is current when the request is made. If the token
          // names another user, or the builder cannot carry a header, nothing is sent.
          if (jwtSubject(auth.accessToken) !== auth.userId.toLowerCase() || typeof q?.setHeader !== "function") throw new TransportError("auth", "session mismatch");
          q = q.setHeader("Authorization", `Bearer ${auth.accessToken}`);
        }
        res = await q;
      }
      catch (e) { if (e instanceof TransportError) throw e; throw new TransportError("offline", e instanceof Error ? e.message : "network error"); }
      if (res.error) {
        if (isMissing(res.error)) throw new TransportError("not_set_up", "not set up");
        if (/jwt|auth|401/i.test(`${res.error.code} ${res.error.message}`)) throw new TransportError("auth", "signed out");
        if (/fetch|network|timeout/i.test(res.error.message ?? "")) throw new TransportError("offline", res.error.message ?? "network");
        throw new TransportError("server", res.error.message ?? "server error");
      }
      if (!Array.isArray(res.data)) throw new TransportError("server", "unexpected answer");
      return (res.data as Array<Record<string, unknown>>).map((r) => ({ op_id: String(r.op_id), status: r.status === "applied" || r.status === "stale" ? r.status : "rejected", error: r.error ? String(r.error) : undefined }));
    },
  };
}

// ------------------------------------------------------------------ logged sessions
const SESSION_COLS = "id,title,status,started_at,ended_at,paused_at,paused_seconds,timezone,notes,perceived_effort,routine_id,source,source_ref,deleted_at";
const NESTED = `${SESSION_COLS},strength_session_exercises(id,position,exercise_key,custom_exercise_id,exercise_name,superset_group,rest_seconds,load_mode,weight_unit,notes,deleted_at,strength_sets(id,position,set_type,weight,weight_unit,reps,duration_s,distance_m,rpe,rir,side,completed,completed_at,notes,deleted_at))`;

/** Database rows -> the editable Workout model (deleted rows are dropped). Measurement types come from the library when known. */
export function workoutFromRow(r: Record<string, unknown>, resolve: (key: string) => Exercise | null): Workout {
  const exs = ((r.strength_session_exercises ?? []) as Array<Record<string, unknown>>).filter((e) => !e.deleted_at).sort((a, b) => Number(a.position) - Number(b.position) || String(a.id).localeCompare(String(b.id)));
  const exercises: WExercise[] = exs.map((e, i) => {
    const key = e.custom_exercise_id ? `custom:${e.custom_exercise_id}` : (e.exercise_key as string | null) ?? null;
    const lib = key ? resolve(key) : null;
    const sets: WSet[] = ((e.strength_sets ?? []) as Array<Record<string, unknown>>).filter((s) => !s.deleted_at).sort((a, b) => Number(a.position) - Number(b.position)).map((s, j) => ({
      id: String(s.id), position: j, type: s.set_type as SetType, weight: num(s.weight), unit: (s.weight_unit === "lb" ? "lb" : "kg") as WeightUnit, reps: num(s.reps), duration_s: num(s.duration_s),
      distance_m: num(s.distance_m), rpe: num(s.rpe), rir: num(s.rir), side: (s.side as "left" | "right" | null) ?? null, completed: Boolean(s.completed), completed_at: (s.completed_at as string | null) ?? null, notes: (s.notes as string | null) ?? null, target: null,
    }));
    return {
      id: String(e.id), position: i, key, name: String(e.exercise_name), superset: num(e.superset_group), rest: num(e.rest_seconds) ?? lib?.rest ?? 90, loadMode: (e.load_mode as LoadMode) ?? "total",
      unit: e.weight_unit === "lb" ? "lb" : "kg", measurement: lib?.measurement ?? "weight_reps", unilateral: lib?.unilateral ?? false, notes: (e.notes as string | null) ?? null, sets,
    };
  });
  return {
    id: String(r.id), title: String(r.title), routineId: (r.routine_id as string | null) ?? null, status: r.status === "completed" ? "completed" : "active", startedAt: String(r.started_at),
    endedAt: (r.ended_at as string | null) ?? null, pausedAt: (r.paused_at as string | null) ?? null, pausedSeconds: Number(r.paused_seconds ?? 0), timezone: (r.timezone as string | null) ?? null,
    notes: (r.notes as string | null) ?? null, effort: num(r.perceived_effort), exercises, currentId: exercises[0]?.id ?? null, source: r.source === "hevy_csv" ? "hevy_csv" : "apex",
  };
}
export function hsessionFromWorkout(w: Workout): HSession {
  return { id: w.id, title: w.title, startedAt: w.startedAt, endedAt: w.endedAt, pausedSeconds: w.pausedSeconds, source: w.source, exercises: w.exercises.map((e) => ({ key: e.key, name: e.name, loadMode: e.loadMode, sets: e.sets.map((s) => ({ type: s.type, weight: s.weight, unit: s.unit, reps: s.reps, duration_s: s.duration_s, distance_m: s.distance_m, rpe: s.rpe, completed: s.completed })) })) };
}

/** Read every row of an ordered query in pages. PostgREST silently caps a single response (Supabase default max_rows = 1000), so a
 *  plain .limit(20000) can return a truncated list without any error. `build` must apply a deterministic order. */
export async function pageAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PgError | null }>, a: { size?: number; max?: number } = {}): Promise<T[]> {
  const size = a.size ?? 500, max = a.max ?? 10_000, out: T[] = [];
  for (let from = 0; from < max; from += size) {
    const { data, error } = await build(from, Math.min(from + size, max) - 1);
    if (error) fail(error);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < Math.min(size, max - from)) break;
  }
  return out;
}

/** Finished, non-deleted workouts, newest first, as editable workouts. Paged (complete up to `max`), optionally only those containing
 *  some exercise keys (then only those exercises are returned for each session). */
export async function loadWorkouts(db: Db, a: { sinceIso?: string; keys?: string[] | null; max?: number; resolve: (key: string) => Exercise | null }): Promise<Workout[]> {
  const sel = a.keys ? NESTED.replace("strength_session_exercises(", "strength_session_exercises!inner(") : NESTED;
  const rows = await pageAll<Record<string, unknown>>((from, to) => {
    let q = db.from("strength_sessions").select(sel).is("deleted_at", null).eq("status", "completed");
    if (a.sinceIso) q = q.gte("started_at", a.sinceIso);
    if (a.keys) q = q.in("strength_session_exercises.exercise_key", a.keys);
    return q.order("started_at", { ascending: false }).order("id", { ascending: true }).range(from, to);
  }, { size: 200, max: a.max ?? 5000 });
  return rows.map((r) => workoutFromRow(r, a.resolve));
}
export async function loadWorkout(db: Db, id: string, resolve: (key: string) => Exercise | null): Promise<Workout | null> {
  const { data, error } = await db.from("strength_sessions").select(NESTED).eq("id", id).is("deleted_at", null).maybeSingle();
  if (error) fail(error);
  return data ? workoutFromRow(data as Record<string, unknown>, resolve) : null;
}

/** Logged history as analytics sessions, newest first, deleted rows excluded. With `keys`, only sessions (and exercises) for those
 *  exercises (gym assistant); without, every finished workout (analytics, "last time" values). */
export async function loadHistory(db: Db, a: { keys: string[] | null; sinceIso?: string; max?: number; resolve: (key: string) => Exercise | null }): Promise<HSession[]> {
  const [w, links] = await Promise.all([
    loadWorkouts(db, { keys: a.keys, sinceIso: a.sinceIso, max: a.max ?? (a.keys ? 300 : 5000), resolve: a.resolve }),
    loadLinksOrNone(db),                                              // before the duplicate tables exist (or if unreadable) nothing is excluded
  ]);
  // A workout logged twice (APEX + Hevy) and merged is counted ONCE everywhere: Today, "last time", records, the Coach and Ask APEX.
  const dup = strengthExcludedIds(links);
  return w.filter((x) => !dup.has(x.id)).map(hsessionFromWorkout);
}

// ------------------------------------------------------------------ custom exercises
export async function loadCustom(db: Db): Promise<Exercise[]> {
  const { data, error } = await db.from("strength_custom_exercises").select("id,name,aliases,primary_muscles,secondary_muscles,equipment,pattern,category,measurement,load_mode,unilateral,instructions,notes,archived_at").is("archived_at", null).order("name");
  if (error) fail(error);
  return ((data ?? []) as CustomExerciseRow[]).map(exerciseFromCustom);
}
export async function createCustom(db: Db, row: Omit<CustomExerciseRow, "id" | "archived_at">): Promise<Exercise> {
  const { data, error } = await db.from("strength_custom_exercises").insert(row).select("id,name,aliases,primary_muscles,secondary_muscles,equipment,pattern,category,measurement,load_mode,unilateral,instructions,notes,archived_at").single();
  if (error) fail(error);
  return exerciseFromCustom(data as CustomExerciseRow);
}
/** Custom exercises are archived, not deleted, so logged history that uses them stays intact. */
export async function archiveCustom(db: Db, id: string): Promise<void> {
  const { data, error } = await db.from("strength_custom_exercises").update({ archived_at: new Date().toISOString() }).eq("id", id).select("id");
  if (error) fail(error);
  if (!data?.length) throw new Error("Exercise not found.");
}

// ------------------------------------------------------------------ routines
export async function listRoutines(db: Db): Promise<Routine[]> {
  const { data, error } = await db.from("strength_routines").select("id,name,notes,template_key,updated_at,strength_routine_exercises(position,exercise_key,custom_exercise_id,superset_group,rest_seconds,load_mode,weight_unit,notes,substitutes,strength_routine_sets(position,set_type,reps_min,reps_max,target_weight,target_rpe,target_rir,target_duration_s,target_distance_m))").order("updated_at", { ascending: false }).limit(100);
  if (error) fail(error);
  return ((data ?? []) as Array<Record<string, unknown>>).map(routineFromRow);
}
export async function saveRoutine(db: Db, r: Routine): Promise<void> {
  const { error } = await db.rpc("save_strength_routine", { p_routine: routinePayload(r) });
  if (error) fail(error);
}
export async function deleteRoutine(db: Db, id: string): Promise<void> {
  const { data, error } = await db.from("strength_routines").delete().eq("id", id).select("id");
  if (error) fail(error);
  if (!data?.length) throw new Error("Routine not found.");
}

// ------------------------------------------------------------------ import
/** Every logged session (deleted ones included and flagged: a deleted import still blocks re-importing the same workout). Paged. */
export async function existingForImport(db: Db): Promise<Array<{ id: string; source: string; sourceRef: string | null; startedAt: string; endedAt: string | null; title: string; deleted: boolean }>> {
  const rows = await pageAll<Record<string, unknown>>((from, to) => db.from("strength_sessions").select("id,source,source_ref,started_at,ended_at,title,deleted_at").order("started_at", { ascending: false }).order("id", { ascending: true }).range(from, to), { size: 1000, max: 50_000 });
  return rows.map((r) => ({ id: String(r.id), source: String(r.source), sourceRef: (r.source_ref as string | null) ?? null, startedAt: String(r.started_at), endedAt: (r.ended_at as string | null) ?? null, title: String(r.title), deleted: Boolean(r.deleted_at) }));
}
export async function importChunk(db: Db, sessions: Array<Record<string, unknown>>): Promise<{ imported: number; skipped: number; rejected: number; errors: Array<{ source_ref: string; error: string }> }> {
  const { data, error } = await db.rpc("import_strength_sessions", { p_source: "hevy_csv", p_sessions: sessions });
  if (error) fail(error);
  const d = (data ?? {}) as Record<string, unknown>;
  return { imported: Number(d.imported ?? 0), skipped: Number(d.skipped ?? 0), rejected: Number(d.rejected ?? 0), errors: (d.errors ?? []) as Array<{ source_ref: string; error: string }> };
}

// ------------------------------------------------------------------ duplicates and merging
/** Activities for duplicate matching. Provenance columns are used when migration 13 added them, otherwise the base columns. */
export async function activitySources(db: Db, sinceIso: string): Promise<ActivitySource[]> {
  const run = (cols: string) => pageAll<Record<string, unknown>>((from, to) => db.from("activities").select(cols).gte("started_at", sinceIso).order("started_at", { ascending: false }).order("id", { ascending: true }).range(from, to), { size: 1000, max: 10_000 });
  let rows: Array<Record<string, unknown>>;
  try { rows = await run("id,started_at,duration_s,elapsed_s,sport,title,origin,origin_device,avg_hr,max_hr,calories,load"); }
  catch (e) { if (!(e instanceof NotSetUp)) throw e; rows = await run("id,started_at,duration_s,sport,title,avg_hr,load"); }   // provenance columns arrive with migration 13
  return rows.map((a) => ({
    kind: "activity" as const, id: Number(a.id), startedAt: String(a.started_at), durationS: num(a.duration_s), elapsedS: num(a.elapsed_s), sport: String(a.sport), title: (a.title as string | null) ?? null,
    origin: (a.origin as string | null) ?? null, device: (a.origin_device as string | null) ?? null, avgHr: num(a.avg_hr), maxHr: num(a.max_hr), calories: num(a.calories), load: num(a.load),
  }));
}
export async function strengthSources(db: Db, sinceIso: string): Promise<StrengthSource[]> {
  const rows = await pageAll<Record<string, unknown>>((from, to) => db.from("strength_sessions").select("id,started_at,ended_at,paused_seconds,title,source,status,strength_session_exercises(exercise_name,deleted_at,strength_sets(id,set_type,completed,deleted_at))")
    .is("deleted_at", null).eq("status", "completed").gte("started_at", sinceIso).order("started_at", { ascending: false }).order("id", { ascending: true }).range(from, to), { size: 500, max: 10_000 });
  return rows.map((s) => {
    // The same helpers Strength and Today count with: only completed, non-warm-up sets are work, and an exercise counts only if it has one.
    const exs = ((s.strength_session_exercises ?? []) as Array<Record<string, unknown>>).filter((e) => !e.deleted_at).map((e) => ({
      key: null, name: String(e.exercise_name), loadMode: "total" as LoadMode,
      sets: ((e.strength_sets ?? []) as Array<Record<string, unknown>>).filter((x) => !x.deleted_at).map((x) => ({
        type: x.set_type as SetType, weight: null, unit: "kg" as WeightUnit, reps: null, duration_s: null, distance_m: null, rpe: null, completed: Boolean(x.completed),
      })),
    }));
    const working = workingExercises({ exercises: exs });
    return {
      kind: "strength" as const, id: String(s.id), startedAt: String(s.started_at), endedAt: (s.ended_at as string | null) ?? null, title: String(s.title), source: s.source === "hevy_csv" ? "hevy_csv" as const : "apex" as const,
      exercises: working.length, sets: workingSetCount({ exercises: exs }), exerciseNames: working.map((e) => e.name), pausedS: Number(s.paused_seconds ?? 0) || 0,
    };
  });
}
export async function loadLinks(db: Db): Promise<Link[]> {
  const rows = await pageAll<Record<string, unknown>>((from, to) => db.from("training_session_links").select("id,training_session_id,activity_id,strength_session_id,role").order("id", { ascending: true }).range(from, to), { size: 1000, max: 50_000 });
  return rows.map((l) => ({ trainingSessionId: String(l.training_session_id), activityId: num(l.activity_id), strengthSessionId: (l.strength_session_id as string | null) ?? null, role: l.role === "primary" ? "primary" : "secondary" }));
}
/** Same, but an empty list when migration 13 is not applied (for modules like Today that must keep working). */
export async function loadLinksOrNone(db: Db): Promise<Link[]> { try { return await loadLinks(db); } catch { return []; } }
export async function loadDecisions(db: Db): Promise<Array<Decision & { id: string; createdAt: string; primaryKind: string | null; confidence: string | null }>> {
  const rows = await pageAll<Record<string, unknown>>((from, to) => db.from("training_merge_decisions").select("id,pair_key,decision,training_session_id,primary_kind,confidence,created_at,reverted_at").order("created_at", { ascending: false }).order("id", { ascending: true }).range(from, to), { size: 1000, max: 50_000 });
  return rows.map((d) => ({ id: String(d.id), pairKey: String(d.pair_key), decision: d.decision === "merged" ? "merged" : "separate", trainingSessionId: (d.training_session_id as string | null) ?? null, revertedAt: (d.reverted_at as string | null) ?? null, createdAt: String(d.created_at), primaryKind: (d.primary_kind as string | null) ?? null, confidence: (d.confidence as string | null) ?? null }));
}
export async function mergeSources(db: Db, sources: Array<{ kind: "activity" | "strength"; id: string | number }>, primaryIndex: 0 | 1, confidence: string): Promise<string> {
  const { data, error } = await db.rpc("merge_training_sources", { p_sources: sources.map((s) => ({ kind: s.kind, id: String(s.id) })), p_primary: primaryIndex, p_confidence: confidence });
  if (error) { if (/duplicate key|unique/i.test(error.message ?? "")) throw new Error("One of these records is already part of another merged session."); fail(error); }
  return String(data);
}
export async function unmerge(db: Db, trainingSessionId: string): Promise<void> { const { error } = await db.rpc("unmerge_training_session", { p_id: trainingSessionId }); if (error) fail(error); }
export async function keepSeparate(db: Db, pairKey: string, confidence: string): Promise<void> {
  const { error } = await db.from("training_merge_decisions").insert({ pair_key: pairKey, decision: "separate", confidence });
  if (error) fail(error);
}
export async function revertDecision(db: Db, id: string): Promise<void> {
  const { data, error } = await db.from("training_merge_decisions").update({ reverted_at: new Date().toISOString() }).eq("id", id).eq("decision", "separate").is("reverted_at", null).select("id");
  if (error) fail(error);
  if (!data?.length) throw new Error("Decision not found.");
}

// ------------------------------------------------------------------ wearable device (Profile)
export interface Device { model: "forerunner_965" | "other_garmin" | "other"; lastExportAt: string | null; lastExportKind: string | null; lastExportNote: string | null }
export async function loadDevice(db: Db): Promise<Device | null> {
  const { data, error } = await db.from("wearable_devices").select("model,last_export_at,last_export_kind,last_export_note").maybeSingle();
  if (error) fail(error);
  return data ? { model: data.model, lastExportAt: data.last_export_at ?? null, lastExportKind: data.last_export_kind ?? null, lastExportNote: data.last_export_note ?? null } : null;
}
export async function saveDevice(db: Db, uid: string, patch: Partial<{ model: Device["model"]; last_export_at: string; last_export_kind: string; last_export_note: string | null }>): Promise<void> {
  const { error } = await db.from("wearable_devices").upsert({ user_id: uid, ...patch }, { onConflict: "user_id" });
  if (error) fail(error);
}
/** Garmin data reaching APEX through Intervals.icu: the newest activity labelled as coming from Garmin (needs the 13 provenance columns). */
export async function garminSyncStatus(db: Db): Promise<{ lastGarminActivity: string | null; provenance: boolean }> {
  const r = await db.from("activities").select("started_at").ilike("origin", "%garmin%").order("started_at", { ascending: false }).limit(1);
  if (r.error) return { lastGarminActivity: null, provenance: false };
  return { lastGarminActivity: r.data?.[0]?.started_at ?? null, provenance: true };
}
