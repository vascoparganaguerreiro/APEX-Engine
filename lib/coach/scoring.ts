// Transparent training-quality scoring. Pure. The model only RATES categories; this file decides which categories have
// evidence, clamps the points, and computes the total. A missing measurement never lowers a score: that category is
// simply left out and the confidence drops instead.
import type { CoachSport, Confidence } from "./schema.ts";

export const SCORE_KEYS = ["objective", "structure", "intensity", "progression", "recovery"] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];
export const SCORE_LABEL: Record<ScoreKey, string> = {
  objective: "Alignment with the objective", structure: "Structure and specificity", intensity: "Intensity and load appropriateness",
  progression: "Progression and history", recovery: "Recovery and scheduling context",
};
// The proposed 25/20/20/20/15 split, adjusted per sport after review (each row sums to 100). Documented judgement, not a validated universal model.
export const WEIGHTS: Record<CoachSport, Record<ScoreKey, number>> = {
  run:      { objective: 25, structure: 20, intensity: 20, progression: 20, recovery: 15 },
  bike:     { objective: 25, structure: 20, intensity: 20, progression: 20, recovery: 15 },
  swim:     { objective: 25, structure: 25, intensity: 15, progression: 20, recovery: 15 },   // technique/structure matter more; intensity is harder to measure
  strength: { objective: 20, structure: 25, intensity: 20, progression: 20, recovery: 15 },   // exercise selection and progressive overload
  football: { objective: 20, structure: 15, intensity: 25, progression: 15, recovery: 25 },   // match/training load and recovery dominate
  other:    { objective: 25, structure: 20, intensity: 20, progression: 20, recovery: 15 },
};
export const RUBRIC_NOTE = "This rubric is a transparent guide to the session, not a scientifically validated universal score. Weights differ by sport and categories without evidence are left out, never scored as zero.";

export interface SessionFacts {
  mode: "completed" | "planned"; sport: CoachSport; date: string; source: "imported" | "manual"; title: string | null;
  duration_s: number | null; distance_m: number | null; avg_hr: number | null; max_hr: number | null; avg_power_w: number | null; pace_s_per_km: number | null;
  load: number | null; rpe: number | null; objective: string; structure: string; notes: string;
}
export interface HistoryInfo { sameSportCount: number }
export interface Evidence { objective: boolean; structure: boolean; intensity: boolean; progression: boolean; recovery: boolean }

export const hasIntensity = (f: SessionFacts): boolean => [f.avg_hr, f.avg_power_w, f.pace_s_per_km, f.load, f.rpe].some((v) => v !== null && v !== undefined && Number(v) > 0);
export const hasMeasuredIntensity = (f: SessionFacts) => f.source === "imported" && [f.avg_hr, f.avg_power_w, f.pace_s_per_km, f.load].some((v) => v !== null && Number(v) > 0);

/** What the Coach must still ask before it may give a score. Empty = enough to proceed. */
export function missingEssentials(f: SessionFacts): string[] {
  const q: string[] = [];
  if (!f.duration_s || f.duration_s <= 0) q.push("How long was the session (duration)?");
  if (!f.objective.trim()) q.push(f.mode === "planned" ? "What is the objective of this planned session?" : "What was the intended objective of this session (for example easy aerobic, threshold intervals, long run)?");
  if (f.mode === "planned") {
    if (f.structure.trim().length < 10) q.push("How is the session structured (warm-up, main set, rest, cool-down)?");
  } else if (!hasIntensity(f)) q.push("How hard did it feel (RPE 1-10), or do you have heart rate, pace or power for it?");
  return q;
}

export function evidenceFor(f: SessionFacts, history: HistoryInfo, recoveryEvidence: boolean): Evidence {
  return {
    objective: f.objective.trim().length > 0,
    structure: f.structure.trim().length >= 10 || f.notes.trim().length >= 20,
    intensity: f.mode === "planned" ? hasIntensity(f) || f.structure.trim().length >= 30 : hasIntensity(f),
    progression: history.sameSportCount >= 3,
    recovery: recoveryEvidence,
  };
}
export const availableKeys = (e: Evidence): ScoreKey[] => SCORE_KEYS.filter((k) => e[k]);

export interface ScoredCategory { key: ScoreKey; label: string; points: number; max: number; reason: string; basis: "measured" | "reported" | "interpretation" }
export interface ExcludedCategory { key: ScoreKey; label: string; max: number; why: string }
export interface ScoreResult { score: number | null; scored: ScoredCategory[]; excluded: ExcludedCategory[]; coverage: number }

const WHY: Record<ScoreKey, string> = {
  objective: "No objective was given.", structure: "No session structure was described.", intensity: "No intensity data (heart rate, pace, power, load or RPE) was available.",
  progression: "Fewer than 3 comparable earlier sessions exist.", recovery: "No recent training or wellness data was shared to judge scheduling and recovery.",
};

export function computeScore(rows: Array<{ key: string; points: number; reason: string; basis: ScoredCategory["basis"] }>, evidence: Evidence, sport: CoachSport): ScoreResult {
  const w = WEIGHTS[sport], byKey = new Map(rows.map((r) => [r.key, r]));
  const scored: ScoredCategory[] = [], excluded: ExcludedCategory[] = [];
  for (const k of SCORE_KEYS) {
    const row = byKey.get(k);
    if (!evidence[k]) { excluded.push({ key: k, label: SCORE_LABEL[k], max: w[k], why: WHY[k] }); continue; }
    if (!row) { excluded.push({ key: k, label: SCORE_LABEL[k], max: w[k], why: "The Coach did not assess this category." }); continue; }
    scored.push({ key: k, label: SCORE_LABEL[k], points: Math.round(Math.min(Math.max(row.points, 0), w[k]) * 10) / 10, max: w[k], reason: row.reason, basis: row.basis });
  }
  const max = scored.reduce((a, c) => a + c.max, 0), got = scored.reduce((a, c) => a + c.points, 0);
  if (scored.length < 2 || max === 0) return { score: null, scored, excluded, coverage: max / 100 };
  return { score: Math.min(100, Math.max(1, Math.round((got / max) * 100))), scored, excluded, coverage: max / 100 };
}

export function categoryFor(score: number, mode: "completed" | "planned"): string {
  const base = score >= 85 ? "Excellent" : score >= 70 ? "Good" : score >= 55 ? "Adequate" : score >= 40 ? "Needs work" : "Poor fit for the objective";
  return mode === "planned" ? `${base} design` : base;
}

/** Confidence from evidence only. The model's own confidence can lower it but never raise it. */
export function confidenceFor(r: ScoreResult, f: SessionFacts, history: HistoryInfo): Confidence {
  if (r.score === null) return "low";
  if (r.coverage >= 0.8 && history.sameSportCount >= 3 && hasMeasuredIntensity(f)) return "high";
  if (r.coverage >= 0.6) return "medium";
  return "low";
}