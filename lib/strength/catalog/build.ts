// Compact builder for the bundled exercise catalog. All exercise text in this folder is original APEX content (no third-party copy or assets).
import type { Difficulty, Equipment, Exercise, ExerciseCategory, FitCategory, LoadMode, Measurement, Muscle, Pattern } from "../types.ts";

export interface Opts { aliases?: string; measurement?: Measurement; loadMode?: LoadMode; unilateral?: boolean; difficulty?: Difficulty; rest?: number }

const list = (s: string, sep: string) => s.split(sep).map((t) => t.trim()).filter(Boolean);
const REST: Record<ExerciseCategory, number> = { compound: 150, isolation: 75, core: 60, cardio: 60, plyometric: 90, olympic: 150, mobility: 45 };

function defaultMeasurement(eq: Equipment): Measurement { return eq === "bodyweight" ? "bodyweight_reps" : "weight_reps"; }
function defaultLoadMode(m: Measurement, eq: Equipment): LoadMode {
  const pair = eq === "dumbbell" || eq === "kettlebell";
  switch (m) {
    case "weight_reps": case "weight_duration": case "weight_distance": return pair ? "per_hand" : "total";
    case "weighted_bodyweight": return "added";
    case "assisted_bodyweight": return "assisted";
    default: return "none";
  }
}

/** x(key, name, primary muscles, secondary muscles, equipment, pattern, category, FIT category, "step|step", "cue|cue", "mistake|mistake", options) */
export function x(
  key: string, name: string, primary: string, secondary: string, equipment: Equipment, pattern: Pattern, category: ExerciseCategory, fit: FitCategory,
  instructions: string, cues: string, mistakes: string, o: Opts = {},
): Exercise {
  const measurement = o.measurement ?? defaultMeasurement(equipment);
  return {
    key, name, aliases: o.aliases ? list(o.aliases, ",") : [], primary: list(primary, ",") as Muscle[], secondary: list(secondary, ",") as Muscle[],
    equipment, pattern, category, measurement, loadMode: o.loadMode ?? defaultLoadMode(measurement, equipment), unilateral: o.unilateral ?? false,
    difficulty: o.difficulty ?? "intermediate", instructions: list(instructions, "|"), cues: list(cues, "|"), mistakes: list(mistakes, "|"),
    rest: o.rest ?? REST[category], fit, media: null,
  };
}
