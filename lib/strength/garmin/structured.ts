// Device-neutral structured workouts: the single representation every export (FIT file, calendar, JSON, a future Garmin Training API
// adapter) is built from. Pure (no I/O).
import { resolveExercise } from "../library.ts";
import { FIT_CATEGORY, type Exercise, type FitCategory } from "../types.ts";
import type { Routine } from "../routines.ts";

export const WORKOUT_SPORTS = ["running", "cycling", "swimming", "strength", "hiit", "cardio", "custom"] as const;
export type WorkoutSport = (typeof WORKOUT_SPORTS)[number];
export type Intensity = "warmup" | "active" | "interval" | "recovery" | "rest" | "cooldown";
export type Duration = { type: "time"; seconds: number } | { type: "distance"; meters: number } | { type: "reps"; reps: number } | { type: "open" };
export type Target =
  | { type: "open" } | { type: "heart_rate"; low: number; high: number } | { type: "pace"; slowSPerKm: number; fastSPerKm: number }
  | { type: "power"; low: number; high: number } | { type: "cadence"; low: number; high: number };
export interface Step {
  kind: "step"; name: string; intensity: Intensity; duration: Duration; target: Target; notes?: string | null;
  exercise?: { name: string; fit: FitCategory; weightKg: number | null } | null;
}
export interface Repeat { kind: "repeat"; times: number; steps: Step[] }
export interface StructuredWorkout { name: string; sport: WorkoutSport; description?: string | null; steps: Array<Step | Repeat>; scheduledDate?: string | null }

export const MAX_STEPS = 100;
export const flatCount = (w: StructuredWorkout) => w.steps.reduce((n, s) => n + (s.kind === "repeat" ? s.steps.length + 1 : 1), 0);

export function validateStructured(w: StructuredWorkout): string | null {
  if (!w.name.trim() || w.name.length > 60) return "The workout needs a name of up to 60 characters.";
  if (!WORKOUT_SPORTS.includes(w.sport)) return "Unknown sport.";
  if (w.steps.length === 0) return "The workout has no steps.";
  if (flatCount(w) > MAX_STEPS) return `The workout has more than ${MAX_STEPS} steps; split it into two.`;
  if (w.scheduledDate && !/^\d{4}-\d{2}-\d{2}$/.test(w.scheduledDate)) return "Invalid date.";
  const check = (s: Step): string | null => {
    if (!s.name.trim()) return "Every step needs a name.";
    const d = s.duration;
    if (d.type === "time" && !(Number.isInteger(d.seconds) && d.seconds >= 1 && d.seconds <= 86400)) return `${s.name}: time must be 1 s to 24 h.`;
    if (d.type === "distance" && !(d.meters > 0 && d.meters <= 1_000_000)) return `${s.name}: invalid distance.`;
    if (d.type === "reps" && !(Number.isInteger(d.reps) && d.reps >= 1 && d.reps <= 1000)) return `${s.name}: reps must be 1 to 1000.`;
    const t = s.target;
    if (t.type === "heart_rate" && !(t.low >= 30 && t.high <= 250 && t.low <= t.high)) return `${s.name}: heart-rate target must be 30–250 bpm, low ≤ high.`;
    if (t.type === "pace" && !(t.fastSPerKm >= 60 && t.slowSPerKm <= 1800 && t.fastSPerKm <= t.slowSPerKm)) return `${s.name}: pace target is invalid.`;
    if (t.type === "power" && !(t.low >= 0 && t.high <= 3000 && t.low <= t.high)) return `${s.name}: power target is invalid.`;
    if (t.type === "cadence" && !(t.low >= 0 && t.high <= 300 && t.low <= t.high)) return `${s.name}: cadence target is invalid.`;
    if (s.exercise && s.exercise.weightKg !== null && !(s.exercise.weightKg >= 0 && s.exercise.weightKg <= 655)) return `${s.name}: weight must be 0–655 kg for a device file.`;
    return null;
  };
  for (const s of w.steps) {
    if (s.kind === "repeat") {
      if (!(Number.isInteger(s.times) && s.times >= 2 && s.times <= 99)) return "A repeat must run 2 to 99 times.";
      if (s.steps.length === 0) return "A repeat block is empty.";
      for (const x of s.steps) { const e = check(x); if (e) return e; }
    } else { const e = check(s); if (e) return e; }
  }
  return null;
}

/** A routine as a strength workout: each planned set becomes an exercise step (reps), followed by its rest. Weights are included only when
 *  the routine has a target weight; per-hand dumbbell targets are labelled as such in the step notes. */
export function routineToStructured(r: Routine, custom: readonly Exercise[], o: { scheduledDate?: string | null } = {}): StructuredWorkout {
  const steps: Step[] = [];
  for (const e of r.exercises) {
    const ex = resolveExercise(e.key, custom);
    if (!ex) continue;
    const mode = e.loadMode ?? ex.loadMode;
    e.sets.forEach((s, i) => {
      const reps = s.repsMax ?? s.repsMin;
      const kg = s.weight === null ? null : e.unit === "kg" ? s.weight : s.weight * 0.45359237;
      const range = s.repsMin !== null && s.repsMax !== null && s.repsMin !== s.repsMax ? `${s.repsMin}-${s.repsMax} reps` : null;
      const notes = [s.type === "warmup" ? "Warm-up" : null, range, s.rpe !== null ? `RPE ${s.rpe}` : null, s.rir !== null ? `RIR ${s.rir}` : null,
        s.weight !== null ? `${s.weight} ${e.unit}${mode === "per_hand" ? " per hand" : ""}` : null, e.notes].filter(Boolean).join(", ");
      steps.push({
        kind: "step", name: ex.name.slice(0, 50), intensity: s.type === "warmup" ? "warmup" : "active",
        duration: s.duration_s ? { type: "time", seconds: s.duration_s } : reps ? { type: "reps", reps } : { type: "open" }, target: { type: "open" }, notes: notes || null,
        exercise: { name: ex.name, fit: ex.fit, weightKg: mode === "per_hand" || kg === null ? null : Math.round(kg * 100) / 100 },
      });
      const rest = e.rest ?? ex.rest;
      if (rest > 0 && !(i === e.sets.length - 1 && e === r.exercises[r.exercises.length - 1])) steps.push({ kind: "step", name: "Rest", intensity: "rest", duration: { type: "time", seconds: rest }, target: { type: "open" } });
    });
  }
  return { name: r.name.slice(0, 60), sport: "strength", description: r.notes, steps, scheduledDate: o.scheduledDate ?? null };
}

/** Simple endurance builder: warm-up, N x (work + recovery), cool-down. */
export interface IntervalSpec {
  name: string; sport: Exclude<WorkoutSport, "strength">; warmupMin: number; cooldownMin: number; repeats: number;
  work: Duration; recovery: Duration; target: Target; scheduledDate?: string | null;
}
export function intervalWorkout(s: IntervalSpec): StructuredWorkout {
  const steps: Array<Step | Repeat> = [];
  if (s.warmupMin > 0) steps.push({ kind: "step", name: "Warm-up", intensity: "warmup", duration: { type: "time", seconds: Math.round(s.warmupMin * 60) }, target: { type: "open" } });
  const work: Step = { kind: "step", name: "Work", intensity: "interval", duration: s.work, target: s.target };
  const rec: Step = { kind: "step", name: "Recover", intensity: "recovery", duration: s.recovery, target: { type: "open" } };
  if (s.repeats >= 2) steps.push({ kind: "repeat", times: s.repeats, steps: [work, rec] }); else steps.push(work);
  if (s.cooldownMin > 0) steps.push({ kind: "step", name: "Cool-down", intensity: "cooldown", duration: { type: "time", seconds: Math.round(s.cooldownMin * 60) }, target: { type: "open" } });
  return { name: s.name, sport: s.sport, steps, scheduledDate: s.scheduledDate ?? null };
}

const fmtDur = (d: Duration) => d.type === "time" ? (d.seconds % 60 === 0 ? `${d.seconds / 60} min` : `${d.seconds} s`) : d.type === "distance" ? (d.meters >= 1000 ? `${d.meters / 1000} km` : `${d.meters} m`) : d.type === "reps" ? `${d.reps} reps` : "until lap button";
const pace = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}/km`;
const fmtTarget = (t: Target) => t.type === "heart_rate" ? ` @ ${t.low}-${t.high} bpm` : t.type === "pace" ? ` @ ${pace(t.fastSPerKm)}-${pace(t.slowSPerKm)}` : t.type === "power" ? ` @ ${t.low}-${t.high} W` : t.type === "cadence" ? ` @ ${t.low}-${t.high} rpm` : "";
/** Plain-text description used for calendars and for typing the workout into Garmin Connect by hand. */
export function describe(w: StructuredWorkout): string {
  const line = (s: Step) => `${s.name}: ${fmtDur(s.duration)}${fmtTarget(s.target)}${s.notes ? ` (${s.notes})` : ""}`;
  const lines: string[] = [];
  for (const s of w.steps) {
    if (s.kind === "repeat") { lines.push(`Repeat ${s.times}x:`); for (const x of s.steps) lines.push(`  - ${line(x)}`); }
    else lines.push(`- ${line(s)}`);
  }
  return [w.description ?? "", ...lines].filter(Boolean).join("\n");
}
export const fitCategoryCode = (c: FitCategory) => FIT_CATEGORY[c];
