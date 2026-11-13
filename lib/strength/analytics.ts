// Strength analytics. Pure (no I/O). Everything here is computed from logged sets only; estimates are labelled as estimates.
// No universal "load score" is ever produced: tonnage of unrelated exercises is not added together.
import { addDaysIso, localDay, weekStart } from "../activities.ts";
import { COUNTS_AS_WORK, MUSCLES, type Exercise, type LoadMode, type Muscle, type SetType, type WeightUnit } from "./types.ts";
import { setVolumeKg, toKg } from "./units.ts";
import type { Workout } from "./workout.ts";

export interface HSet { type: SetType; weight: number | null; unit: WeightUnit; reps: number | null; duration_s: number | null; distance_m: number | null; rpe: number | null; completed: boolean;
  /** Which side a one-sided set was done on. Absent in history saved before this was kept: then the side is unknown, never assumed. */
  side?: "left" | "right" | null }
export interface HExercise { key: string | null; name: string; loadMode: LoadMode; sets: HSet[] }
export interface HSession { id: string; title: string; startedAt: string; endedAt: string | null; pausedSeconds: number; source: string; exercises: HExercise[] }

export function fromWorkout(w: Workout): HSession {
  return {
    id: w.id, title: w.title, startedAt: w.startedAt, endedAt: w.endedAt, pausedSeconds: w.pausedSeconds, source: w.source,
    exercises: [...w.exercises].sort((a, b) => a.position - b.position).map((e) => ({ key: e.key, name: e.name, loadMode: e.loadMode, sets: e.sets.map((s) => ({ type: s.type, weight: s.weight, unit: s.unit, reps: s.reps, duration_s: s.duration_s, distance_m: s.distance_m, rpe: s.rpe, completed: s.completed, side: s.side })) })),
  };
}

// ------------------------------------------------------------------ estimated one-rep max
export const E1RM_MAX_REPS = 10;
export const E1RM_FORMULA = "Epley formula: weight × (1 + reps ÷ 30), from completed working sets of 1 to 10 reps. A single is taken as-is. It is an estimate, not a tested max.";
/** Estimated 1RM in kg, or null when the set is not suitable (no load, 0 reps, or more than 10 reps where estimates become unreliable). */
export function e1rm(weightKg: number, reps: number): number | null {
  if (!(weightKg > 0) || !Number.isInteger(reps) || reps < 1 || reps > E1RM_MAX_REPS) return null;
  return reps === 1 ? weightKg : weightKg * (1 + reps / 30);
}
const E1RM_TYPES: ReadonlySet<SetType> = new Set(["working", "failure", "backoff"]);
const loadBased = (m: LoadMode) => m === "total" || m === "per_hand" || m === "added";
const EPS = 1e-6;

/** Completed sets that count as work (warm-ups never count). */
export const workSets = (e: HExercise) => e.sets.filter((s) => s.completed && COUNTS_AS_WORK[s.type]);
/** Working sets of a whole session. The one definition Strength, Today and the Timeline all count with. */
export const workingSetCount = (s: Pick<HSession, "exercises">): number => s.exercises.reduce((n, e) => n + workSets(e).length, 0);
/** Exercises with at least one working set: an exercise that only has warm-ups or unfinished sets is not counted. */
export const workingExercises = (s: Pick<HSession, "exercises">): HExercise[] => s.exercises.filter((e) => workSets(e).length > 0);

export interface BestSet { weight: number; unit: WeightUnit; weightKg: number; reps: number; e1rmKg: number | null }
/** Best set of an exercise in a session: highest estimated 1RM; when nothing is estimable, the heaviest weight then the most reps.
 *  For per-hand exercises the weight is per dumbbell, exactly as entered. */
export function bestSet(e: HExercise): BestSet | null {
  let best: BestSet | null = null;
  for (const s of workSets(e)) {
    if (s.reps === null || s.reps < 1) continue;
    const kg = s.weight === null ? 0 : toKg(s.weight, s.unit);
    const est = loadBased(e.loadMode) && e.loadMode !== "added" && E1RM_TYPES.has(s.type) ? e1rm(kg, s.reps) : null;
    const cand: BestSet = { weight: s.weight ?? 0, unit: s.unit, weightKg: kg, reps: s.reps, e1rmKg: est };
    if (!best) { best = cand; continue; }
    const a = cand.e1rmKg ?? -1, b = best.e1rmKg ?? -1;
    if (a > b + EPS || (Math.abs(a - b) <= EPS && (cand.weightKg > best.weightKg + EPS || (Math.abs(cand.weightKg - best.weightKg) <= EPS && cand.reps > best.reps)))) best = cand;
  }
  return best;
}

export interface ExerciseSessionStats { sessionId: string; date: string; startedAt: string; best: BestSet | null; e1rmKg: number | null; maxWeightKg: number | null; volumeKg: number; reps: number; workingSets: number; maxReps: number }
export function exerciseStats(s: HSession, e: HExercise, tz?: string): ExerciseSessionStats {
  const ws = workSets(e);
  const best = bestSet(e);
  let maxW: number | null = null, vol = 0, reps = 0, maxReps = 0, est: number | null = null;
  for (const x of ws) {
    if (x.weight !== null && loadBased(e.loadMode)) { const kg = toKg(x.weight, x.unit); if (maxW === null || kg > maxW) maxW = kg; }
    vol += setVolumeKg(x.weight, x.unit, e.loadMode, x.reps);
    reps += x.reps ?? 0;
    maxReps = Math.max(maxReps, x.reps ?? 0);
    if (loadBased(e.loadMode) && e.loadMode !== "added" && x.weight !== null && x.reps !== null && E1RM_TYPES.has(x.type)) { const v = e1rm(toKg(x.weight, x.unit), x.reps); if (v !== null && (est === null || v > est)) est = v; }
  }
  return { sessionId: s.id, date: localDay(s.startedAt, tz), startedAt: s.startedAt, best, e1rmKg: est, maxWeightKg: maxW, volumeKg: vol, reps, workingSets: ws.length, maxReps };
}

/** Per-session history of one exercise (oldest first), matched by exercise key; unmatched imports can be matched by name. */
export function exerciseHistory(sessions: HSession[], match: { key?: string | null; name?: string }, tz?: string): ExerciseSessionStats[] {
  const out: ExerciseSessionStats[] = [];
  for (const s of [...sessions].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
    const items = s.exercises.filter((e) => (match.key ? e.key === match.key : !e.key && match.name && e.name.toLowerCase() === match.name.toLowerCase()));
    if (!items.length) continue;
    const merged: HExercise = { key: items[0].key, name: items[0].name, loadMode: items[0].loadMode, sets: items.flatMap((e) => e.sets) };
    const st = exerciseStats(s, merged, tz);
    if (st.workingSets > 0) out.push(st);
  }
  return out;
}

/** The most recent earlier session of an exercise, with its completed sets in order: shown as "last time" next to the inputs.
 *  Display only: the app never copies it into a new set without the user tapping it. */
export function lastPerformance(sessions: HSession[], key: string, beforeIso?: string, excludeId?: string): { date: string; startedAt: string; sets: HSet[] } | null {
  const before = beforeIso ? Date.parse(beforeIso) : Infinity;
  const s = sessions.filter((x) => x.id !== excludeId && Date.parse(x.startedAt) < before && x.exercises.some((e) => e.key === key))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  if (!s) return null;
  const sets = s.exercises.filter((e) => e.key === key).flatMap((e) => e.sets.filter((x) => x.completed));
  return sets.length ? { date: s.startedAt.slice(0, 10), startedAt: s.startedAt, sets } : null;
}
export function fmtHSet(s: HSet, mode: LoadMode): string {
  if (s.duration_s && !s.reps) return `${s.weight ? `${s.weight} ${s.unit} · ` : ""}${s.duration_s}s`;
  if (s.distance_m && !s.reps) return `${s.weight ? `${s.weight} ${s.unit} · ` : ""}${s.distance_m} m`;
  const w = s.weight === null ? (mode === "none" ? "BW" : "–") : `${Math.round(s.weight * 100) / 100}${s.unit === "lb" ? " lb" : ""}${mode === "added" ? "+" : mode === "assisted" ? " assist" : ""}`;
  return `${w}×${s.reps ?? "?"}${s.rpe !== null ? `@${s.rpe}` : ""}`;
}

// ------------------------------------------------------------------ personal records
export type PRKind = "weight" | "e1rm" | "reps" | "volume";
export interface PR { exerciseKey: string | null; exerciseName: string; kind: PRKind; value: number; previous: number; unit: "kg" | "reps" }
export const PR_LABEL: Record<PRKind, string> = { weight: "Heaviest weight", e1rm: "Best estimated 1RM", reps: "Most reps in a set", volume: "Most volume in a session" };

/** Records set in `session` compared with strictly earlier sessions. An exercise done for the first time has no previous value, so it is
 *  reported as a baseline, never as a record. */
export function personalRecords(session: HSession, history: HSession[]): { prs: PR[]; baselines: string[] } {
  const before = history.filter((h) => h.id !== session.id && Date.parse(h.startedAt) < Date.parse(session.startedAt));
  const prs: PR[] = [], baselines: string[] = [];
  const seen = new Set<string>();
  for (const e of session.exercises) {
    const id = e.key ?? `name:${e.name.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const match = e.key ? { key: e.key } : { name: e.name };
    const prior = exerciseHistory(before, match);
    const cur = exerciseHistory([session], match)[0];
    if (!cur) continue;
    if (prior.length === 0) { baselines.push(e.name); continue; }
    const max = (f: (x: ExerciseSessionStats) => number | null) => prior.reduce<number | null>((m, x) => { const v = f(x); return v === null ? m : m === null || v > m ? v : m; }, null);
    const check = (kind: PRKind, now: number | null, prev: number | null, unit: "kg" | "reps") => { if (now !== null && prev !== null && now > prev + 1e-6) prs.push({ exerciseKey: e.key, exerciseName: e.name, kind, value: now, previous: prev, unit }); };
    if (loadBased(e.loadMode)) {
      check("weight", cur.maxWeightKg, max((x) => x.maxWeightKg), "kg");
      if (e.loadMode !== "added") check("e1rm", cur.e1rmKg, max((x) => x.e1rmKg), "kg");
      check("volume", cur.volumeKg > 0 ? cur.volumeKg : null, max((x) => (x.volumeKg > 0 ? x.volumeKg : null)), "kg");
    } else {
      check("reps", cur.maxReps || null, max((x) => x.maxReps || null), "reps");
    }
  }
  return { prs, baselines };
}

// ------------------------------------------------------------------ comparison with the previous session of the same exercise
export interface Comparison { exerciseName: string; previousDate: string | null; change: string | null; basis: "measured" }
export function compareWithPrevious(session: HSession, history: HSession[], tz?: string): Comparison[] {
  const before = history.filter((h) => h.id !== session.id && Date.parse(h.startedAt) < Date.parse(session.startedAt));
  return session.exercises.map((e) => {
    const match = e.key ? { key: e.key } : { name: e.name };
    const prev = exerciseHistory(before, match, tz).pop() ?? null, cur = exerciseHistory([session], match, tz)[0] ?? null;
    if (!prev || !cur) return { exerciseName: e.name, previousDate: prev?.date ?? null, change: null, basis: "measured" as const };
    const parts: string[] = [];
    if (cur.best && prev.best && cur.best.weightKg > 0) parts.push(`top set ${fmtSet(prev.best)} → ${fmtSet(cur.best)}`);
    parts.push(`working sets ${prev.workingSets} → ${cur.workingSets}`, `total reps ${prev.reps} → ${cur.reps}`);
    return { exerciseName: e.name, previousDate: prev.date, change: parts.join(", "), basis: "measured" as const };
  });
}
const fmtSet = (b: BestSet) => `${Math.round(b.weight * 100) / 100} ${b.unit} × ${b.reps}`;

// ------------------------------------------------------------------ muscles (estimates by design)
export const MUSCLE_NOTE = "Muscle volume is an estimate: each completed working set counts 1 for the exercise's primary muscles. Secondary involvement is shown separately and never added in as if it were direct work.";
export interface MuscleWeek { direct: number; secondary: number; sessions: number }
export function muscleWeek(sessions: HSession[], resolve: (key: string) => Exercise | null, weekMonday: string, tz?: string): Record<Muscle, MuscleWeek> {
  const out = Object.fromEntries(MUSCLES.map((m) => [m, { direct: 0, secondary: 0, sessions: 0 }])) as Record<Muscle, MuscleWeek>;
  const end = addDaysIso(weekMonday, 6);
  for (const s of sessions) {
    const d = localDay(s.startedAt, tz);
    if (d < weekMonday || d > end) continue;
    const hit = new Set<Muscle>();
    for (const e of s.exercises) {
      const ex = e.key ? resolve(e.key) : null;
      if (!ex) continue;                                                  // unmatched imports are not attributed to any muscle
      const n = workSets(e).length;
      if (!n) continue;
      for (const m of ex.primary) { out[m].direct += n; hit.add(m); }
      for (const m of ex.secondary) out[m].secondary += n;
    }
    for (const m of hit) out[m].sessions++;
  }
  return out;
}

// ------------------------------------------------------------------ dashboard
export const durationSeconds = (s: Pick<HSession, "startedAt" | "endedAt" | "pausedSeconds">): number | null =>
  s.endedAt ? Math.max(0, Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000) - (s.pausedSeconds || 0)) : null;

export interface Period { key: string; workouts: number; minutes: number; workingSets: number }
export interface Dashboard {
  totalWorkouts: number; last30: number; perWeek12: number; consistency12: { weeksTrained: number; weeks: number };
  thisWeekSets: number; avgWeeklySets4: number; avgDurationMin: number | null; monthly: Period[]; yearly: Period[]; weekly: Period[];
}
export function dashboard(sessions: HSession[], today: string, tz?: string): Dashboard {
  const days = sessions.map((s) => ({ s, d: localDay(s.startedAt, tz), sets: s.exercises.reduce((n, e) => n + workSets(e).length, 0), sec: durationSeconds(s) }));
  const since = (n: number) => addDaysIso(today, -n + 1);
  const thisMonday = weekStart(today);
  const weeks12 = Array.from({ length: 12 }, (_, i) => addDaysIso(thisMonday, -7 * i));
  const inWeek = (d: string, m: string) => d >= m && d <= addDaysIso(m, 6);
  const group = (key: (d: string) => string) => {
    const m = new Map<string, Period>();
    for (const x of days) { const k = key(x.d); const p = m.get(k) ?? { key: k, workouts: 0, minutes: 0, workingSets: 0 }; p.workouts++; p.minutes += Math.round((x.sec ?? 0) / 60); p.workingSets += x.sets; m.set(k, p); }
    return [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
  };
  const durations = days.map((x) => x.sec).filter((v): v is number => v !== null && v > 0);
  const last12 = days.filter((x) => x.d >= weeks12[11] && x.d <= today);
  const weekSets = (m: string) => days.filter((x) => inWeek(x.d, m)).reduce((n, x) => n + x.sets, 0);
  return {
    totalWorkouts: days.length,
    last30: days.filter((x) => x.d >= since(30) && x.d <= today).length,
    perWeek12: Math.round((last12.length / 12) * 10) / 10,
    consistency12: { weeksTrained: weeks12.filter((m) => days.some((x) => inWeek(x.d, m))).length, weeks: 12 },
    thisWeekSets: weekSets(thisMonday),
    avgWeeklySets4: Math.round((weeks12.slice(0, 4).reduce((n, m) => n + weekSets(m), 0) / 4) * 10) / 10,
    avgDurationMin: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60) : null,
    monthly: group((d) => d.slice(0, 7)), yearly: group((d) => d.slice(0, 4)), weekly: group((d) => weekStart(d)),
  };
}
