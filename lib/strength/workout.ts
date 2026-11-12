// Live workout model. Pure and immutable: every action returns a new Workout, so the UI, the offline store, the sync diff and
// Ask APEX's confirmed actions all share exactly the same rules. No I/O; ids and clock are passed in.
import type { Exercise, LoadMode, Measurement, SetType, WeightUnit } from "./types.ts";
import { SET_TYPES, customIdOf, isUuid } from "./types.ts";

export class WorkoutError extends Error {}

export interface SetTarget { repsMin: number | null; repsMax: number | null; weight: number | null; rpe: number | null; rir: number | null; duration_s: number | null; distance_m: number | null }
export interface WSet {
  id: string; position: number; type: SetType; weight: number | null; unit: WeightUnit; reps: number | null; duration_s: number | null; distance_m: number | null;
  rpe: number | null; rir: number | null; side: "left" | "right" | null; completed: boolean; completed_at: string | null; notes: string | null;
  /** From the routine, shown as guidance only. Local to this device; never synced or treated as performed. */
  target?: SetTarget | null;
}
export interface WExercise {
  id: string; position: number; key: string | null; name: string; superset: number | null; rest: number; loadMode: LoadMode; unit: WeightUnit;
  measurement: Measurement; unilateral: boolean; notes: string | null; sets: WSet[];
}
export interface Workout {
  id: string; title: string; routineId: string | null; status: "active" | "completed"; startedAt: string; endedAt: string | null; pausedAt: string | null;
  pausedSeconds: number; timezone: string | null; notes: string | null; effort: number | null; exercises: WExercise[]; currentId: string | null; source: "apex" | "hevy_csv";
}

export interface PlanSet { type: SetType; repsMin: number | null; repsMax: number | null; weight: number | null; rpe: number | null; rir: number | null; duration_s: number | null; distance_m: number | null }
export interface PlanExercise { exercise: Exercise; superset: number | null; rest: number | null; loadMode: LoadMode | null; unit: WeightUnit; notes: string | null; sets: PlanSet[] }

const ms = (iso: string) => Date.parse(iso);
const sortPos = <T extends { position: number }>(a: T[]) => [...a].sort((x, y) => x.position - y.position);
const renumber = <T extends { position: number }>(a: T[]): T[] => a.map((x, i) => (x.position === i ? x : { ...x, position: i }));
const cleanText = (s: string | null | undefined, max: number) => { const t = (s ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max); return t || null; };

// ------------------------------------------------------------------ creation
export function startWorkout(a: { id: string; title?: string; now: string; timezone?: string | null; routineId?: string | null; plan?: PlanExercise[]; newId: () => string; defaultUnit: WeightUnit }): Workout {
  if (!isUuid(a.id)) throw new WorkoutError("Invalid workout id.");
  let w: Workout = {
    id: a.id, title: cleanText(a.title, 120) ?? "Workout", routineId: a.routineId ?? null, status: "active", startedAt: a.now, endedAt: null, pausedAt: null, pausedSeconds: 0,
    timezone: a.timezone ?? null, notes: null, effort: null, exercises: [], currentId: null, source: "apex",
  };
  for (const p of a.plan ?? []) {
    w = addExercise(w, p.exercise, { id: a.newId(), unit: p.unit ?? a.defaultUnit, loadMode: p.loadMode ?? undefined, rest: p.rest ?? undefined, superset: p.superset, notes: p.notes, emptySet: false });
    const ex = w.exercises[w.exercises.length - 1];
    const sets: WSet[] = p.sets.map((s, i) => ({
      ...blankSet(a.newId(), i, ex.unit), type: s.type, weight: s.weight, reps: null, duration_s: null, distance_m: null,
      target: { repsMin: s.repsMin, repsMax: s.repsMax, weight: s.weight, rpe: s.rpe, rir: s.rir, duration_s: s.duration_s, distance_m: s.distance_m },
    }));
    w = mapExercise(w, ex.id, (e) => ({ ...e, sets: sets.length ? sets : [blankSet(a.newId(), 0, e.unit)] }));
  }
  return { ...w, currentId: w.exercises[0]?.id ?? null };
}

const blankSet = (id: string, position: number, unit: WeightUnit): WSet => ({
  id, position, type: "working", weight: null, unit, reps: null, duration_s: null, distance_m: null, rpe: null, rir: null, side: null, completed: false, completed_at: null, notes: null, target: null,
});

function mapExercise(w: Workout, exId: string, f: (e: WExercise) => WExercise): Workout {
  let found = false;
  const exercises = w.exercises.map((e) => (e.id === exId ? ((found = true), f(e)) : e));
  if (!found) throw new WorkoutError("That exercise is not in this workout.");
  return { ...w, exercises };
}
export const findExercise = (w: Workout, exId: string) => w.exercises.find((e) => e.id === exId) ?? null;

// ------------------------------------------------------------------ exercises
export function addExercise(w: Workout, ex: Exercise, o: { id: string; afterId?: string | null; unit: WeightUnit; loadMode?: LoadMode; rest?: number; superset?: number | null; notes?: string | null; emptySet?: boolean; setId?: string }): Workout {
  if (!isUuid(o.id)) throw new WorkoutError("Invalid exercise id.");
  if (w.exercises.length >= 60) throw new WorkoutError("A workout can hold at most 60 exercises.");
  const list = sortPos(w.exercises);
  const at = o.afterId ? list.findIndex((e) => e.id === o.afterId) + 1 : list.length;
  const item: WExercise = {
    id: o.id, position: 0, key: ex.key, name: ex.name, superset: o.superset ?? null, rest: clampRest(o.rest ?? ex.rest), loadMode: o.loadMode ?? ex.loadMode, unit: o.unit,
    measurement: ex.measurement, unilateral: ex.unilateral, notes: cleanText(o.notes, 1000), sets: [],
  };
  if (o.emptySet !== false) {
    if (!isUuid(o.setId)) throw new WorkoutError("Invalid set id.");
    item.sets = [blankSet(o.setId, 0, o.unit)];
  }
  list.splice(at < 0 ? list.length : at, 0, item);
  return { ...w, exercises: renumber(list), currentId: w.currentId ?? item.id };
}

export function removeExercise(w: Workout, exId: string): Workout {
  if (!findExercise(w, exId)) throw new WorkoutError("That exercise is not in this workout.");
  const exercises = renumber(sortPos(w.exercises.filter((e) => e.id !== exId)));
  return { ...w, exercises, currentId: w.currentId === exId ? exercises[0]?.id ?? null : w.currentId };
}

export function moveExercise(w: Workout, exId: string, toIndex: number): Workout {
  const list = sortPos(w.exercises), from = list.findIndex((e) => e.id === exId);
  if (from < 0) throw new WorkoutError("That exercise is not in this workout.");
  const to = Math.max(0, Math.min(list.length - 1, Math.floor(toIndex)));
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  return { ...w, exercises: renumber(list) };
}

/** Swap an exercise. Sets already completed stay recorded under the ORIGINAL exercise (they were really done with it); the remaining
 *  planned sets move to the substitute, with weights cleared because loads do not transfer between different exercises. */
export function replaceExercise(w: Workout, exId: string, ex: Exercise, o: { newId: string; unit: WeightUnit }): Workout {
  const cur = findExercise(w, exId);
  if (!cur) throw new WorkoutError("That exercise is not in this workout.");
  const done = cur.sets.filter((s) => s.completed), open = cur.sets.filter((s) => !s.completed);
  const moved = (sets: WSet[], unit: WeightUnit) => renumber(sortPos(sets)).map((s) => ({ ...s, weight: null, unit, reps: null, duration_s: null, distance_m: null, rpe: null, rir: null, target: s.target ? { ...s.target, weight: null } : null }));
  if (done.length === 0) {
    return mapExercise(w, exId, (e) => ({ ...e, key: ex.key, name: ex.name, loadMode: ex.loadMode, measurement: ex.measurement, unilateral: ex.unilateral, rest: clampRest(ex.rest), unit: o.unit, sets: moved(e.sets, o.unit) }));
  }
  let next = mapExercise(w, exId, (e) => ({ ...e, sets: renumber(sortPos(done)) }));
  next = addExercise(next, ex, { id: o.newId, afterId: exId, unit: o.unit, superset: cur.superset, emptySet: false });
  if (open.length) next = mapExercise(next, o.newId, (e) => ({ ...e, sets: moved(open, o.unit) }));
  return { ...next, currentId: o.newId };
}

const clampRest = (s: number) => Math.max(0, Math.min(1800, Math.round(s)));
export function setRest(w: Workout, exId: string, seconds: number): Workout {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 1800) throw new WorkoutError("Rest must be between 0 and 30 minutes.");
  return mapExercise(w, exId, (e) => ({ ...e, rest: clampRest(seconds) }));
}
export function setExerciseNote(w: Workout, exId: string, note: string): Workout { return mapExercise(w, exId, (e) => ({ ...e, notes: cleanText(note, 1000) })); }
export function setExerciseUnit(w: Workout, exId: string, unit: WeightUnit): Workout {
  // New sets use the new unit; already-entered sets keep their own unit, so nothing is silently converted.
  return mapExercise(w, exId, (e) => ({ ...e, unit, sets: e.sets.map((s) => (s.completed || s.weight !== null ? s : { ...s, unit })) }));
}
export function setLoadMode(w: Workout, exId: string, mode: LoadMode): Workout { return mapExercise(w, exId, (e) => ({ ...e, loadMode: mode })); }

/** Group exercises into a superset (2+ exercises). Passing one id clears its grouping. */
export function setSuperset(w: Workout, exIds: string[]): Workout {
  const ids = [...new Set(exIds)];
  if (ids.some((id) => !findExercise(w, id))) throw new WorkoutError("That exercise is not in this workout.");
  if (ids.length === 1) return mapExercise(w, ids[0], (e) => ({ ...e, superset: null }));
  const used = new Set(w.exercises.map((e) => e.superset).filter((g): g is number => g !== null));
  let g = 1; while (used.has(g)) g++;
  if (g > 20) throw new WorkoutError("Too many supersets in one workout.");
  return { ...w, exercises: w.exercises.map((e) => (ids.includes(e.id) ? { ...e, superset: g } : e)) };
}
export function setCurrent(w: Workout, exId: string): Workout { if (!findExercise(w, exId)) throw new WorkoutError("That exercise is not in this workout."); return { ...w, currentId: exId }; }

// ------------------------------------------------------------------ sets
export interface SetPatch { type?: SetType; weight?: number | null; reps?: number | null; duration_s?: number | null; distance_m?: number | null; rpe?: number | null; rir?: number | null; side?: "left" | "right" | null; notes?: string | null; unit?: WeightUnit }

/** Validate values for one set. Returns an error message or null. Bounds mirror the database CHECK constraints. */
export function setPatchError(p: SetPatch): string | null {
  const bad = (v: unknown, lo: number, hi: number, int = false) => v !== null && v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v)));
  if (p.type !== undefined && !SET_TYPES.includes(p.type)) return "Unknown set type.";
  if (bad(p.weight, 0, 2000)) return "Weight must be between 0 and 2000.";
  if (bad(p.reps, 0, 1000, true)) return "Reps must be a whole number between 0 and 1000.";
  if (bad(p.duration_s, 0, 86400, true)) return "Time must be between 0 seconds and 24 hours.";
  if (bad(p.distance_m, 0, 1_000_000)) return "Distance must be between 0 and 1000 km.";
  if (bad(p.rpe, 1, 10) || (typeof p.rpe === "number" && Math.round(p.rpe * 2) !== p.rpe * 2)) return "RPE must be between 1 and 10, in steps of 0.5.";
  if (bad(p.rir, 0, 10, true)) return "RIR must be a whole number between 0 and 10.";
  if (p.side !== undefined && p.side !== null && p.side !== "left" && p.side !== "right") return "Side must be left or right.";
  if (p.unit !== undefined && p.unit !== "kg" && p.unit !== "lb") return "Unit must be kg or lb.";
  return null;
}
/** RPE and RIR describe the same thing (RPE 8 is about 2 reps in reserve). A large disagreement is flagged, never auto-corrected. */
export function rpeRirMismatch(rpe: number | null, rir: number | null): boolean { return rpe !== null && rir !== null && Math.abs(rpe + rir - 10) > 1.5; }

export function addSet(w: Workout, exId: string, id: string, o: { type?: SetType } = {}): Workout {
  if (!isUuid(id)) throw new WorkoutError("Invalid set id.");
  return mapExercise(w, exId, (e) => {
    if (e.sets.length >= 50) throw new WorkoutError("An exercise can hold at most 50 sets.");
    const sets = sortPos(e.sets), last = sets[sets.length - 1];
    const type: SetType = o.type ?? (last && (last.type === "warmup" || last.type === "backoff") ? last.type : "working");
    const s: WSet = { ...blankSet(id, sets.length, last?.unit ?? e.unit), type };
    if (last) Object.assign(s, { weight: last.weight, unit: last.unit, reps: last.reps, duration_s: last.duration_s, distance_m: last.distance_m, side: e.unilateral && last.side ? (last.side === "left" ? "right" : "left") : null });
    return { ...e, sets: [...sets, s] };
  });
}

export function updateSet(w: Workout, exId: string, setId: string, patch: SetPatch): Workout {
  const err = setPatchError(patch);
  if (err) throw new WorkoutError(err);
  return mapExercise(w, exId, (e) => {
    if (!e.sets.some((s) => s.id === setId)) throw new WorkoutError("That set is not in this exercise.");
    return { ...e, sets: e.sets.map((s) => (s.id === setId ? { ...s, ...patch, notes: patch.notes !== undefined ? cleanText(patch.notes, 500) : s.notes } : s)) };
  });
}

/** What a set must contain before it can be marked complete. */
export function completionError(s: WSet, measurement: Measurement, mode: LoadMode): string | null {
  const needReps = ["weight_reps", "bodyweight_reps", "weighted_bodyweight", "assisted_bodyweight"].includes(measurement);
  if (needReps && (s.reps === null || s.reps < 1)) return "Enter the reps first.";
  if ((measurement === "weight_reps" || measurement === "weight_duration" || measurement === "weight_distance") && (mode === "total" || mode === "per_hand") && s.weight === null) return "Enter the weight first.";
  if ((measurement === "duration" || measurement === "weight_duration") && (s.duration_s === null || s.duration_s < 1)) return "Enter the time first.";
  if ((measurement === "distance_duration" || measurement === "weight_distance") && !(s.distance_m && s.distance_m > 0) && !(s.duration_s && s.duration_s > 0)) return "Enter the distance or time first.";
  return null;
}

/** Mark a set done. Empty values of the next open set of the same exercise are prefilled from it (easy to change, never forced). */
export function completeSet(w: Workout, exId: string, setId: string, now: string): Workout {
  const e = findExercise(w, exId);
  const s = e?.sets.find((x) => x.id === setId);
  if (!e || !s) throw new WorkoutError("That set is not in this workout.");
  const err = completionError(s, e.measurement, e.loadMode);
  if (err) throw new WorkoutError(err);
  return mapExercise(w, exId, (ex) => {
    const sorted = sortPos(ex.sets), i = sorted.findIndex((x) => x.id === setId);
    const nextId = sorted.slice(i + 1).find((x) => !x.completed && x.type === s.type)?.id ?? null;
    const fill = (a: number | null, b: number | null) => (a === null ? b : a);
    const sets = sorted.map((x) => {
      if (x.id === setId) return { ...x, completed: true, completed_at: now };
      if (x.id === nextId) return { ...x, weight: fill(x.weight, s.weight), unit: x.weight === null ? s.unit : x.unit, reps: fill(x.reps, s.reps), duration_s: fill(x.duration_s, s.duration_s), distance_m: fill(x.distance_m, s.distance_m) };
      return x;
    });
    return { ...ex, sets };
  });
}
export function uncompleteSet(w: Workout, exId: string, setId: string): Workout {
  return mapExercise(w, exId, (e) => ({ ...e, sets: e.sets.map((s) => (s.id === setId ? { ...s, completed: false, completed_at: null } : s)) }));
}
export function removeSet(w: Workout, exId: string, setId: string): Workout {
  return mapExercise(w, exId, (e) => {
    if (!e.sets.some((s) => s.id === setId)) throw new WorkoutError("That set is not in this exercise.");
    return { ...e, sets: renumber(sortPos(e.sets.filter((s) => s.id !== setId))) };
  });
}

// ------------------------------------------------------------------ time, pause and finish
export function elapsedSeconds(w: Workout, now: string): number {
  const end = w.endedAt ? ms(w.endedAt) : ms(now);
  const paused = w.pausedSeconds + (w.pausedAt && !w.endedAt ? Math.max(0, ms(now) - ms(w.pausedAt)) / 1000 : 0);
  return Math.max(0, Math.round((end - ms(w.startedAt)) / 1000 - paused));
}
export function pause(w: Workout, now: string): Workout {
  if (w.status !== "active") throw new WorkoutError("Only an active workout can be paused.");
  return w.pausedAt ? w : { ...w, pausedAt: now };
}
export function resume(w: Workout, now: string): Workout {
  if (!w.pausedAt) return w;
  return { ...w, pausedAt: null, pausedSeconds: w.pausedSeconds + Math.max(0, Math.round((ms(now) - ms(w.pausedAt)) / 1000)) };
}
export function finish(w: Workout, now: string, o: { discardIncomplete: boolean }): Workout {
  if (w.status !== "active") throw new WorkoutError("This workout is already finished.");
  let x = resume(w, now);
  if (!x.exercises.some((e) => e.sets.some((s) => s.completed))) throw new WorkoutError("Complete at least one set, or cancel the workout instead.");
  if (o.discardIncomplete) {
    x = { ...x, exercises: renumber(sortPos(x.exercises.map((e) => ({ ...e, sets: renumber(sortPos(e.sets.filter((s) => s.completed))) })).filter((e) => e.sets.length > 0))) };
  }
  return { ...x, status: "completed", endedAt: ms(now) < ms(x.startedAt) ? x.startedAt : now };
}
export function setDetails(w: Workout, d: { title?: string; notes?: string | null; effort?: number | null; startedAt?: string; endedAt?: string | null }): Workout {
  if (d.effort !== undefined && d.effort !== null && (!Number.isInteger(d.effort) || d.effort < 1 || d.effort > 10)) throw new WorkoutError("Effort must be a whole number from 1 to 10.");
  const startedAt = d.startedAt ?? w.startedAt, endedAt = d.endedAt === undefined ? w.endedAt : d.endedAt;
  if (Number.isNaN(ms(startedAt)) || (endedAt !== null && (Number.isNaN(ms(endedAt)) || ms(endedAt) < ms(startedAt)))) throw new WorkoutError("The end time must be after the start time.");
  if (w.status === "completed" && endedAt === null) throw new WorkoutError("A finished workout needs an end time.");
  return { ...w, title: d.title !== undefined ? cleanText(d.title, 120) ?? w.title : w.title, notes: d.notes !== undefined ? cleanText(d.notes, 4000) : w.notes, effort: d.effort === undefined ? w.effort : d.effort, startedAt, endedAt };
}

// ------------------------------------------------------------------ navigation: current, next, progress, rest
export function currentExercise(w: Workout): WExercise | null {
  const list = sortPos(w.exercises);
  const cur = list.find((e) => e.id === w.currentId);
  if (cur && cur.sets.some((s) => !s.completed)) return cur;
  return list.find((e) => e.sets.some((s) => !s.completed)) ?? cur ?? list[list.length - 1] ?? null;
}
export function nextExercise(w: Workout): WExercise | null {
  const list = sortPos(w.exercises), cur = currentExercise(w);
  if (!cur) return null;
  return list.slice(cur.position + 1).find((e) => e.sets.some((s) => !s.completed) && (cur.superset === null || e.superset !== cur.superset)) ?? null;
}
export function progress(w: Workout): { done: number; total: number; exercisesDone: number; exercises: number } {
  let done = 0, total = 0, exercisesDone = 0;
  for (const e of w.exercises) { const d = e.sets.filter((s) => s.completed).length; done += d; total += e.sets.length; if (e.sets.length && d === e.sets.length) exercisesDone++; }
  return { done, total, exercisesDone, exercises: w.exercises.length };
}
/** After completing a set: in a superset, go straight to the next exercise of the group (no rest) until the round is done. */
export function afterSet(w: Workout, exId: string): { restSeconds: number; goTo: string } {
  const list = sortPos(w.exercises), e = list.find((x) => x.id === exId);
  if (!e) throw new WorkoutError("That exercise is not in this workout.");
  if (e.superset === null) return { restSeconds: e.rest, goTo: e.id };
  const group = list.filter((x) => x.superset === e.superset);
  const i = group.findIndex((x) => x.id === e.id);
  for (let k = 1; k < group.length; k++) {
    const cand = group[(i + k) % group.length];
    if ((i + k) < group.length && cand.sets.some((s) => !s.completed)) return { restSeconds: 0, goTo: cand.id };
  }
  const first = group.find((x) => x.sets.some((s) => !s.completed)) ?? e;
  return { restSeconds: group[group.length - 1].rest, goTo: first.id };
}

// ------------------------------------------------------------------ database rows (what the sync layer sends)
export type RowKind = "session" | "exercise" | "set";
export interface Row { kind: RowKind; id: string; data: Record<string, unknown> }
export function rowsOf(w: Workout): Row[] {
  const out: Row[] = [{ kind: "session", id: w.id, data: {
    title: w.title, status: w.status, started_at: w.startedAt, ended_at: w.endedAt, paused_at: w.pausedAt, paused_seconds: w.pausedSeconds,
    timezone: w.timezone, notes: w.notes, perceived_effort: w.effort, routine_id: w.routineId,
  } }];
  for (const e of sortPos(w.exercises)) {
    const customId = e.key ? customIdOf(e.key) : null;
    out.push({ kind: "exercise", id: e.id, data: {
      session_id: w.id, position: e.position, exercise_key: e.key && !customId ? e.key : null, custom_exercise_id: customId, exercise_name: e.name,
      superset_group: e.superset, rest_seconds: e.rest, load_mode: e.loadMode, weight_unit: e.unit, notes: e.notes,
    } });
    for (const s of sortPos(e.sets)) out.push({ kind: "set", id: s.id, data: {
      session_id: w.id, session_exercise_id: e.id, position: s.position, set_type: s.type, weight: s.weight, weight_unit: s.unit, reps: s.reps,
      duration_s: s.duration_s, distance_m: s.distance_m, rpe: s.rpe, rir: s.rir, side: s.side, completed: s.completed, completed_at: s.completed_at, notes: s.notes,
    } });
  }
  return out;
}
