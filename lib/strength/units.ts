// Weight units and the load actually moved. Pure (no I/O). Weights are stored exactly as entered (value + unit) and only converted for
// comparisons and analytics, so switching units never rewrites history.
import type { LoadMode, WeightUnit } from "./types.ts";

export const LB_PER_KG = 1 / 0.45359237;
export const toKg = (w: number, unit: WeightUnit) => (unit === "kg" ? w : w * 0.45359237);
export const fromKg = (kg: number, unit: WeightUnit) => (unit === "kg" ? kg : kg * LB_PER_KG);
export const round = (n: number, dp = 1) => { const f = 10 ** dp; return Math.round(n * f) / f; };

/** Smallest sensible increment for the +/- buttons. */
export const weightStep = (unit: WeightUnit) => (unit === "kg" ? 2.5 : 5);

export function formatWeight(w: number | null, unit: WeightUnit): string {
  if (w === null || !Number.isFinite(w)) return "–";
  return `${round(w, 2)} ${unit}`;
}

/** Load moved in one rep, in kg, when it can be known. per_hand counts both implements. Bodyweight-based modes need the user's
 *  bodyweight; without it the result is null (never guessed). */
export function effectiveLoadKg(weight: number | null, unit: WeightUnit, mode: LoadMode, bodyweightKg: number | null): number | null {
  const w = weight === null ? null : toKg(weight, unit);
  switch (mode) {
    case "total": return w;
    case "per_hand": return w === null ? null : w * 2;
    case "added": return bodyweightKg === null ? null : bodyweightKg + (w ?? 0);
    case "assisted": return bodyweightKg === null ? null : Math.max(0, bodyweightKg - (w ?? 0));
    case "none": return bodyweightKg;
  }
}

/** "External load × reps", the volume figure shown in analytics. Clearly a training-log number, not a physiological load:
 *  per_hand counts both dumbbells; added counts only the added weight; assisted and pure bodyweight sets have no external volume. */
export function setVolumeKg(weight: number | null, unit: WeightUnit, mode: LoadMode, reps: number | null): number {
  if (weight === null || reps === null || reps <= 0 || weight <= 0) return 0;
  const kg = toKg(weight, unit);
  if (mode === "total" || mode === "added") return kg * reps;
  if (mode === "per_hand") return kg * 2 * reps;
  return 0;
}

/** How the weight field is labelled for each load mode, so "per hand" versus "combined" is never ambiguous. */
export const WEIGHT_LABEL: Record<LoadMode, string> = { total: "Weight", per_hand: "Per hand", added: "Added", assisted: "Assist", none: "" };
