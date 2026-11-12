// Strength Hub: shared vocabulary. Pure (no imports, no I/O). Every list here is mirrored by a CHECK constraint in 13_strength.sql.

export const MUSCLES = [
  "chest", "upper_back", "lats", "shoulders", "biceps", "triceps", "forearms",
  "quadriceps", "hamstrings", "glutes", "calves", "abdominals", "obliques", "lower_back", "full_body",
] as const;
export type Muscle = (typeof MUSCLES)[number];
export const MUSCLE_LABEL: Record<Muscle, string> = {
  chest: "Chest", upper_back: "Upper back", lats: "Lats", shoulders: "Shoulders", biceps: "Biceps", triceps: "Triceps", forearms: "Forearms",
  quadriceps: "Quadriceps", hamstrings: "Hamstrings", glutes: "Glutes", calves: "Calves", abdominals: "Abdominals", obliques: "Obliques",
  lower_back: "Lower back", full_body: "Full body",
};

export const EQUIPMENT = ["barbell", "dumbbell", "cable", "machine", "smith_machine", "kettlebell", "band", "bodyweight", "other"] as const;
export type Equipment = (typeof EQUIPMENT)[number];
export const EQUIPMENT_LABEL: Record<Equipment, string> = {
  barbell: "Barbell", dumbbell: "Dumbbells", cable: "Cable", machine: "Machine", smith_machine: "Smith machine", kettlebell: "Kettlebell",
  band: "Resistance bands", bodyweight: "Bodyweight", other: "Other",
};

export const PATTERNS = [
  "horizontal_push", "vertical_push", "horizontal_pull", "vertical_pull", "squat", "hinge", "lunge",
  "isolation_upper", "isolation_lower", "core", "carry", "conditioning", "olympic",
] as const;
export type Pattern = (typeof PATTERNS)[number];
export const PATTERN_LABEL: Record<Pattern, string> = {
  horizontal_push: "Horizontal push", vertical_push: "Vertical push", horizontal_pull: "Horizontal pull", vertical_pull: "Vertical pull",
  squat: "Squat", hinge: "Hinge", lunge: "Lunge / single leg", isolation_upper: "Upper-body isolation", isolation_lower: "Lower-body isolation",
  core: "Core", carry: "Carry", conditioning: "Conditioning", olympic: "Olympic / power",
};

export const CATEGORIES = ["compound", "isolation", "core", "cardio", "plyometric", "mobility", "olympic"] as const;
export type ExerciseCategory = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<ExerciseCategory, string> = {
  compound: "Compound", isolation: "Isolation", core: "Core", cardio: "Cardio", plyometric: "Plyometric", mobility: "Mobility", olympic: "Olympic lift",
};

/** What a set of this exercise records. */
export const MEASUREMENTS = [
  "weight_reps", "bodyweight_reps", "weighted_bodyweight", "assisted_bodyweight", "duration", "weight_duration", "distance_duration", "weight_distance",
] as const;
export type Measurement = (typeof MEASUREMENTS)[number];
export const MEASUREMENT_LABEL: Record<Measurement, string> = {
  weight_reps: "Weight × reps", bodyweight_reps: "Bodyweight reps", weighted_bodyweight: "Bodyweight + added weight", assisted_bodyweight: "Assisted bodyweight",
  duration: "Time", weight_duration: "Weight × time", distance_duration: "Distance and time", weight_distance: "Weight × distance",
};

/** How the entered weight relates to the load actually moved.
 *  total: the whole load (barbell incl. bar, machine stack). per_hand: one dumbbell/kettlebell per hand, entered per hand.
 *  added: weight added to bodyweight (weighted pull-up). assisted: assistance that REDUCES the load (assisted pull-up machine). none: no external load. */
export const LOAD_MODES = ["total", "per_hand", "added", "assisted", "none"] as const;
export type LoadMode = (typeof LOAD_MODES)[number];
export const LOAD_MODE_LABEL: Record<LoadMode, string> = {
  total: "Total weight", per_hand: "Per hand (each dumbbell)", added: "Added to bodyweight", assisted: "Assistance (subtracted)", none: "No external weight",
};

export const SET_TYPES = ["warmup", "working", "drop", "failure", "backoff"] as const;
export type SetType = (typeof SET_TYPES)[number];
export const SET_TYPE_LABEL: Record<SetType, string> = { warmup: "Warm-up", working: "Working", drop: "Drop set", failure: "Failure", backoff: "Back-off" };
export const SET_TYPE_SHORT: Record<SetType, string> = { warmup: "W", working: "", drop: "D", failure: "F", backoff: "B" };
/** Sets that count as "working sets" for volume and muscle analytics. Warm-ups never do. */
export const COUNTS_AS_WORK: Record<SetType, boolean> = { warmup: false, working: true, drop: true, failure: true, backoff: true };

export const WEIGHT_UNITS = ["kg", "lb"] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];

export const DIFFICULTIES = ["beginner", "intermediate", "advanced"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Garmin FIT exercise_category codes (FIT SDK profile, "exercise_category" type). Used only for the optional workout file export. */
export const FIT_CATEGORY = {
  bench_press: 0, calf_raise: 1, cardio: 2, carry: 3, chop: 4, core: 5, crunch: 6, curl: 7, deadlift: 8, flye: 9, hip_raise: 10, hip_stability: 11,
  hip_swing: 12, hyperextension: 13, lateral_raise: 14, leg_curl: 15, leg_raise: 16, lunge: 17, olympic_lift: 18, plank: 19, plyo: 20, pull_up: 21,
  push_up: 22, row: 23, shoulder_press: 24, shoulder_stability: 25, shrug: 26, sit_up: 27, squat: 28, total_body: 29, triceps_extension: 30,
  warm_up: 31, run: 32, unknown: 65534,
} as const;
export type FitCategory = keyof typeof FIT_CATEGORY;

export interface Exercise {
  /** Stable id. Catalog: a slug ("barbell_bench_press"). Custom: "custom:<uuid>". Never reused for a different movement. */
  key: string;
  name: string;
  aliases: string[];
  primary: Muscle[];
  secondary: Muscle[];
  equipment: Equipment;
  pattern: Pattern;
  category: ExerciseCategory;
  measurement: Measurement;
  loadMode: LoadMode;
  unilateral: boolean;
  difficulty: Difficulty;
  instructions: string[];
  cues: string[];
  mistakes: string[];
  /** Sensible default rest between working sets, in seconds. */
  rest: number;
  fit: FitCategory;
  custom?: boolean;
  /** Optional visual demonstration (original or appropriately licensed asset only). None are bundled yet. */
  media?: { kind: "image" | "video"; url: string; credit: string } | null;
}

export const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export const CUSTOM_PREFIX = "custom:";
export const isCatalogKey = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9_]{2,60}$/.test(s);
export const customKey = (id: string) => `${CUSTOM_PREFIX}${id}`;
export const customIdOf = (key: string): string | null => (key.startsWith(CUSTOM_PREFIX) && isUuid(key.slice(CUSTOM_PREFIX.length)) ? key.slice(CUSTOM_PREFIX.length) : null);
