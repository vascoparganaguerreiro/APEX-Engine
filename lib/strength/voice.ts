// Deterministic parsing of short spoken set reports ("I just did 8 reps at 80 kilos, add that set"). Works offline and without AI.
// The result is only a PROPOSAL; the user confirms it like any other change. Pure (no I/O).
import { parseProposals, type Proposal, type WorkoutSnapshot } from "./actions.ts";
import type { WeightUnit } from "./types.ts";

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, um: 1, uma: 1, dois: 2, duas: 2, "três": 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, doze: 12, quinze: 15,
};
const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const KG = /^(kg|kgs|kilo|kilos|kilogram|kilograms|quilo|quilos|quilogramas?)$/i, LB = /^(lb|lbs|pound|pounds|libra|libras)$/i;

export interface SpokenSet { reps: number; weight: number | null; unit: WeightUnit | null; rpe: number | null }
export function parseSpokenSet(text: string): SpokenSet | null {
  let t = ` ${text.toLowerCase().replace(/[!?;]/g, " ")} `;
  for (const [w, n] of Object.entries(WORDS)) t = t.replace(new RegExp(`\\b${w}\\b`, "g"), String(n));
  const reps = new RegExp(`${NUM}\\s*(?:reps?|repetitions?|repeti[cç][oõ]es|vezes)\\b`).exec(t);
  const weight = new RegExp(`${NUM}\\s*(kg|kgs|kilos?|kilograms?|quilos?|quilogramas?|lbs?|pounds?|libras?)\\b`).exec(t);
  const rpe = new RegExp(`\\brpe\\s*${NUM}`).exec(t);
  let r = reps ? Number(reps[1].replace(",", ".")) : null;
  let w: number | null = weight ? Number(weight[1].replace(",", ".")) : null;
  let unit: WeightUnit | null = weight ? (KG.test(weight[2]) ? "kg" : LB.test(weight[2]) ? "lb" : null) : null;
  if (r === null) {
    const at = new RegExp(`\\b(\\d{1,3})\\s*(?:x|×|at|@|with|com|a)\\s*${NUM}\\b`).exec(t);           // "8 x 80", "8 at 80"
    if (at) { r = Number(at[1]); if (w === null) { w = Number(at[2].replace(",", ".")); unit = null; } }
  }
  if (r === null || !Number.isInteger(r) || r < 1 || r > 100) return null;
  if (w !== null && !(w >= 0 && w <= 2000)) return null;
  const rv = rpe ? Number(rpe[1].replace(",", ".")) : null;
  return { reps: r, weight: w, unit, rpe: rv !== null && rv >= 1 && rv <= 10 && rv * 2 === Math.round(rv * 2) ? rv : null };
}

/** A spoken set report as a proposed "add set" for the current exercise. Unit defaults to the exercise's unit when not said. */
export function voiceProposal(text: string, snap: WorkoutSnapshot): Proposal | null {
  const s = parseSpokenSet(text);
  const i = snap.exercises.findIndex((e) => e.id === snap.currentExerciseId);
  if (!s || i < 0) return null;
  const e = snap.exercises[i];
  return parseProposals([{ type: "add_set", exercise: `E${i + 1}`, weight: s.weight, unit: s.unit ?? e.unit, reps: s.reps, rpe: s.rpe, set_type: "working" }], snap)[0] ?? null;
}

/** Feature detection for the browser's speech APIs (none of this runs on the server). */
export function speechSupport(w: unknown): { recognition: boolean; synthesis: boolean } {
  const g = (w ?? {}) as Record<string, unknown>;
  return { recognition: typeof g.SpeechRecognition === "function" || typeof g.webkitSpeechRecognition === "function", synthesis: typeof g.speechSynthesis === "object" && g.speechSynthesis !== null };
}
