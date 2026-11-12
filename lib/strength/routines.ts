// Routines: reusable workout templates. Pure (no I/O).
import { resolveExercise } from "./library.ts";
import { LOAD_MODES, SET_TYPES, customIdOf, isUuid, type Exercise, type LoadMode, type SetType, type WeightUnit } from "./types.ts";
import type { PlanExercise } from "./workout.ts";

export interface RoutineSet { type: SetType; repsMin: number | null; repsMax: number | null; weight: number | null; rpe: number | null; rir: number | null; duration_s: number | null; distance_m: number | null }
export interface RoutineExercise { key: string; superset: number | null; rest: number | null; loadMode: LoadMode | null; unit: WeightUnit; notes: string | null; substitutes: string[]; sets: RoutineSet[] }
export interface Routine { id: string; name: string; notes: string | null; templateKey: string | null; exercises: RoutineExercise[]; updatedAt?: string | null }

export const set = (repsMin: number | null, repsMax: number | null, o: Partial<RoutineSet> = {}): RoutineSet => ({ type: "working", repsMin, repsMax, weight: null, rpe: null, rir: null, duration_s: null, distance_m: null, ...o });
const sets = (n: number, lo: number, hi: number, rir: number | null = 2) => Array.from({ length: n }, () => set(lo, hi, { rir }));
const item = (key: string, s: RoutineSet[], rest: number | null = null, superset: number | null = null): RoutineExercise => ({ key, superset, rest, loadMode: null, unit: "kg", notes: null, substitutes: [], sets: s });

/** Starting points only: the user edits everything. No weights are pre-filled because the app does not know the user's loads. */
export const TEMPLATES: Record<string, { name: string; description: string; exercises: RoutineExercise[] }> = {
  push: { name: "Push", description: "Chest, shoulders and triceps.", exercises: [
    item("barbell_bench_press", [set(8, 8, { type: "warmup", rir: null }), ...sets(3, 5, 8)], 180), item("incline_dumbbell_press", sets(3, 8, 12), 120),
    item("seated_dumbbell_shoulder_press", sets(3, 8, 12), 120), item("dumbbell_lateral_raise", sets(3, 12, 15), 60, 1), item("triceps_rope_pushdown", sets(3, 10, 15), 60, 1)] },
  pull: { name: "Pull", description: "Back and biceps.", exercises: [
    item("pull_up", sets(3, 5, 10), 150), item("barbell_row", sets(3, 6, 10), 150), item("seated_cable_row", sets(3, 8, 12), 90),
    item("face_pull", sets(3, 12, 15), 60, 1), item("dumbbell_curl", sets(3, 8, 12), 60, 1)] },
  legs: { name: "Legs", description: "Quadriceps, hamstrings, glutes and calves.", exercises: [
    item("back_squat", [set(5, 5, { type: "warmup", rir: null }), ...sets(3, 5, 8)], 180), item("romanian_deadlift", sets(3, 6, 10), 150), item("leg_press", sets(3, 10, 12), 120),
    item("lying_leg_curl", sets(3, 10, 15), 75), item("standing_calf_raise", sets(3, 10, 15), 60)] },
  upper: { name: "Upper", description: "Upper body push and pull.", exercises: [
    item("barbell_bench_press", sets(3, 5, 8), 180), item("barbell_row", sets(3, 6, 10), 150), item("overhead_press", sets(3, 6, 10), 150),
    item("lat_pulldown", sets(3, 8, 12), 90), item("ez_bar_curl", sets(2, 10, 12), 60, 1), item("skull_crusher", sets(2, 10, 12), 60, 1)] },
  lower: { name: "Lower", description: "Squat, hinge and single-leg work.", exercises: [
    item("back_squat", sets(3, 5, 8), 180), item("deadlift", sets(2, 3, 5), 180), item("bulgarian_split_squat", sets(3, 8, 12), 90),
    item("seated_leg_curl", sets(3, 10, 15), 75), item("plank", [set(null, null, { duration_s: 45 }), set(null, null, { duration_s: 45 })], 60)] },
  full_body: { name: "Full body", description: "One main lift per pattern.", exercises: [
    item("goblet_squat", sets(3, 8, 12), 120), item("dumbbell_bench_press", sets(3, 8, 12), 120), item("dumbbell_row", sets(3, 8, 12), 90),
    item("dumbbell_romanian_deadlift", sets(3, 8, 12), 120), item("dead_bug", sets(2, 8, 10, null), 60)] },
};

export function fromTemplate(key: string, id: string): Routine {
  const t = TEMPLATES[key];
  if (!t) throw new Error("Unknown template.");
  return { id, name: t.name, notes: null, templateKey: key, exercises: JSON.parse(JSON.stringify(t.exercises)) as RoutineExercise[] };
}
export const emptyRoutine = (id: string): Routine => ({ id, name: "My routine", notes: null, templateKey: null, exercises: [] });
export const duplicateRoutine = (r: Routine, id: string): Routine => ({ ...JSON.parse(JSON.stringify(r)), id, name: `${r.name} (copy)`.slice(0, 80), updatedAt: null });

export function moveRoutineExercise(r: Routine, from: number, to: number): Routine {
  const list = [...r.exercises];
  if (from < 0 || from >= list.length) return r;
  const [x] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(list.length, to)), 0, x);
  return { ...r, exercises: list };
}

/** Validate before saving; the database enforces the same bounds. */
export function validateRoutine(r: Routine, custom: readonly Exercise[]): string | null {
  if (!isUuid(r.id)) return "Invalid routine.";
  const name = r.name.trim();
  if (!name || name.length > 80) return "Give the routine a name (up to 80 characters).";
  if ((r.notes ?? "").length > 2000) return "Notes are too long.";
  if (r.exercises.length > 100) return "A routine can hold at most 100 exercises.";
  for (const [i, e] of r.exercises.entries()) {
    const ex = resolveExercise(e.key, custom);
    const label = ex?.name ?? `Exercise ${i + 1}`;
    if (!ex) return `${label}: this exercise no longer exists.`;
    if (e.sets.length > 50) return `${label}: at most 50 sets.`;
    if (e.rest !== null && (!Number.isInteger(e.rest) || e.rest < 0 || e.rest > 1800)) return `${label}: rest must be 0 to 1800 seconds.`;
    if (e.superset !== null && (!Number.isInteger(e.superset) || e.superset < 1 || e.superset > 20)) return `${label}: invalid superset.`;
    if (e.loadMode !== null && !LOAD_MODES.includes(e.loadMode)) return `${label}: invalid weight setting.`;
    if (e.substitutes.length > 6) return `${label}: at most 6 substitutes.`;
    for (const s of e.sets) {
      if (!SET_TYPES.includes(s.type)) return `${label}: unknown set type.`;
      const bad = (v: number | null, lo: number, hi: number, int: boolean) => v !== null && (!Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v)));
      if (bad(s.repsMin, 0, 1000, true) || bad(s.repsMax, 0, 1000, true)) return `${label}: reps must be whole numbers.`;
      if (s.repsMin !== null && s.repsMax !== null && s.repsMin > s.repsMax) return `${label}: the rep range is reversed.`;
      if (bad(s.weight, 0, 2000, false)) return `${label}: weight must be 0 to 2000.`;
      if (bad(s.rpe, 1, 10, false) || (s.rpe !== null && s.rpe * 2 !== Math.round(s.rpe * 2))) return `${label}: RPE must be 1 to 10 in steps of 0.5.`;
      if (bad(s.rir, 0, 10, true)) return `${label}: RIR must be 0 to 10.`;
      if (bad(s.duration_s, 1, 86400, true)) return `${label}: invalid time.`;
      if (bad(s.distance_m, 0.01, 1_000_000, false)) return `${label}: invalid distance.`;
    }
  }
  return null;
}

/** JSON for the save_strength_routine database function. */
export function routinePayload(r: Routine): Record<string, unknown> {
  return {
    id: r.id, name: r.name.trim(), notes: r.notes?.trim() || null, template_key: r.templateKey,
    exercises: r.exercises.map((e, i) => {
      const custom = customIdOf(e.key);
      return {
        position: i, exercise_key: custom ? null : e.key, custom_exercise_id: custom, superset_group: e.superset, rest_seconds: e.rest, load_mode: e.loadMode, weight_unit: e.unit, notes: e.notes, substitutes: e.substitutes,
        sets: e.sets.map((s, j) => ({ position: j, set_type: s.type, reps_min: s.repsMin, reps_max: s.repsMax, target_weight: s.weight, target_rpe: s.rpe, target_rir: s.rir, target_duration_s: s.duration_s, target_distance_m: s.distance_m })),
      };
    }),
  };
}

/** Rebuild a routine from its database rows (routine + nested exercises + sets). */
export function routineFromRow(r: Record<string, unknown>): Routine {
  const exs = ((r.strength_routine_exercises ?? []) as Array<Record<string, unknown>>).sort((a, b) => Number(a.position) - Number(b.position));
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(r.id), name: String(r.name), notes: (r.notes as string | null) ?? null, templateKey: (r.template_key as string | null) ?? null, updatedAt: (r.updated_at as string | null) ?? null,
    exercises: exs.map((e) => ({
      key: e.custom_exercise_id ? `custom:${e.custom_exercise_id}` : String(e.exercise_key), superset: n(e.superset_group), rest: n(e.rest_seconds), loadMode: (e.load_mode as LoadMode | null) ?? null,
      unit: e.weight_unit === "lb" ? "lb" : "kg", notes: (e.notes as string | null) ?? null, substitutes: (e.substitutes as string[] | null) ?? [],
      sets: ((e.strength_routine_sets ?? []) as Array<Record<string, unknown>>).sort((a, b) => Number(a.position) - Number(b.position)).map((s) => ({
        type: s.set_type as SetType, repsMin: n(s.reps_min), repsMax: n(s.reps_max), weight: n(s.target_weight), rpe: n(s.target_rpe), rir: n(s.target_rir), duration_s: n(s.target_duration_s), distance_m: n(s.target_distance_m),
      })),
    })),
  };
}

/** Turn a routine into a live-workout plan. Exercises that no longer exist are skipped and reported, never replaced silently. */
export function toPlan(r: Routine, custom: readonly Exercise[]): { plan: PlanExercise[]; skipped: string[] } {
  const plan: PlanExercise[] = [], skipped: string[] = [];
  for (const e of r.exercises) {
    const ex = resolveExercise(e.key, custom);
    if (!ex) { skipped.push(e.key); continue; }
    plan.push({ exercise: ex, superset: e.superset, rest: e.rest, loadMode: e.loadMode, unit: e.unit, notes: e.notes, sets: e.sets.map((s) => ({ ...s })) });
  }
  return { plan, skipped };
}

export const repRange = (s: Pick<RoutineSet, "repsMin" | "repsMax">) => (s.repsMin === null && s.repsMax === null ? null : s.repsMin === s.repsMax || s.repsMax === null ? `${s.repsMin}` : s.repsMin === null ? `≤${s.repsMax}` : `${s.repsMin}–${s.repsMax}`);
