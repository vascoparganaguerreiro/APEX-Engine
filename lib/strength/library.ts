// Exercise library: the bundled catalog plus the user's custom exercises, with search and filters. Pure (no I/O).
import { CHEST_SHOULDERS } from "./catalog/upper.ts";
import { BACK_ARMS } from "./catalog/back_arms.ts";
import { LEGS } from "./catalog/legs.ts";
import { CORE_CONDITIONING } from "./catalog/core_conditioning.ts";
import {
  CATEGORIES, EQUIPMENT, EQUIPMENT_LABEL, LOAD_MODES, MEASUREMENTS, MUSCLES, MUSCLE_LABEL, PATTERNS, PATTERN_LABEL, customIdOf, customKey,
  type Equipment, type Exercise, type ExerciseCategory, type FitCategory, type LoadMode, type Measurement, type Muscle, type Pattern,
} from "./types.ts";

export const CATALOG: readonly Exercise[] = Object.freeze([...CHEST_SHOULDERS, ...BACK_ARMS, ...LEGS, ...CORE_CONDITIONING]);
const BY_KEY = new Map(CATALOG.map((e) => [e.key, e]));
export const catalogExercise = (key: string): Exercise | null => BY_KEY.get(key) ?? null;

// ------------------------------------------------------------------ text normalisation and search
const ABBREV: Record<string, string> = { db: "dumbbell", dbs: "dumbbell", bb: "barbell", kb: "kettlebell", ohp: "overhead press", rdl: "romanian deadlift", bw: "bodyweight", ez: "ez", sl: "single leg", "1": "one" };
export function normalizeName(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[()\[\],.'’"/\\-]+/g, " ").replace(/\s+/g, " ").trim();
}
const tokens = (s: string) => normalizeName(s).split(" ").filter(Boolean).map((t) => ABBREV[t] ?? t).join(" ").split(" ").map((t) => t.replace(/s$/, "")).filter(Boolean);

export interface LibraryFilter { query?: string; muscle?: Muscle | ""; equipment?: Equipment | ""; pattern?: Pattern | ""; category?: ExerciseCategory | ""; includeSecondary?: boolean }

function haystack(e: Exercise): { name: string[]; alias: string[]; meta: string[] } {
  return {
    name: tokens(e.name), alias: e.aliases.flatMap(tokens),
    meta: [...e.primary.map((m) => MUSCLE_LABEL[m]), EQUIPMENT_LABEL[e.equipment], PATTERN_LABEL[e.pattern]].flatMap(tokens),
  };
}
/** Relevance of an exercise for a free-text query; 0 means "no match". */
export function scoreExercise(e: Exercise, query: string): number {
  const q = tokens(query);
  if (q.length === 0) return 1;
  const h = haystack(e), full = normalizeName(e.name), nq = normalizeName(query);
  if (full === nq || e.aliases.some((a) => normalizeName(a) === nq)) return 1000;
  let score = 0;
  for (const t of q) {
    const inName = h.name.some((w) => w === t) ? 30 : h.name.some((w) => w.startsWith(t)) ? 20 : 0;
    const inAlias = h.alias.some((w) => w === t) ? 25 : h.alias.some((w) => w.startsWith(t)) ? 15 : 0;
    const inMeta = h.meta.some((w) => w === t || w.startsWith(t)) ? 8 : 0;
    const best = Math.max(inName, inAlias, inMeta);
    if (best === 0) return 0;                                    // every query word must match something
    score += best;
  }
  if (full.startsWith(nq)) score += 50;
  return score;
}

export function searchExercises(all: readonly Exercise[], f: LibraryFilter): Exercise[] {
  const q = (f.query ?? "").trim();
  const out: Array<{ e: Exercise; s: number }> = [];
  for (const e of all) {
    if (f.muscle && !(e.primary.includes(f.muscle) || (f.includeSecondary && e.secondary.includes(f.muscle)))) continue;
    if (f.equipment && e.equipment !== f.equipment) continue;
    if (f.pattern && e.pattern !== f.pattern) continue;
    if (f.category && e.category !== f.category) continue;
    const s = scoreExercise(e, q);
    if (s > 0) out.push({ e, s });
  }
  return out.sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name)).map((x) => x.e);
}

/** Exercises that train the same primary muscle, so the user can swap one in. The note says honestly how the swap differs. */
export interface Substitute { exercise: Exercise; samePattern: boolean; note: string }
export function substitutesFor(target: Exercise, all: readonly Exercise[], available?: readonly Equipment[], limit = 8): Substitute[] {
  const out: Array<Substitute & { s: number }> = [];
  for (const e of all) {
    if (e.key === target.key) continue;
    if (available && available.length && !available.includes(e.equipment)) continue;
    const shared = e.primary.filter((m) => target.primary.includes(m)).length;
    if (shared === 0) continue;
    const samePattern = e.pattern === target.pattern;
    const s = shared * 10 + (samePattern ? 20 : 0) + (e.measurement === target.measurement ? 3 : 0);
    const diffs: string[] = [];
    if (!samePattern) diffs.push(`different movement pattern (${PATTERN_LABEL[e.pattern].toLowerCase()} instead of ${PATTERN_LABEL[target.pattern].toLowerCase()})`);
    const lost = target.primary.filter((m) => !e.primary.includes(m));
    if (lost.length) diffs.push(`less direct work for ${lost.map((m) => MUSCLE_LABEL[m].toLowerCase()).join(", ")}`);
    const gained = e.primary.filter((m) => !target.primary.includes(m));
    if (gained.length) diffs.push(`more emphasis on ${gained.map((m) => MUSCLE_LABEL[m].toLowerCase()).join(", ")}`);
    if (e.equipment !== target.equipment) diffs.push(`uses ${EQUIPMENT_LABEL[e.equipment].toLowerCase()}, so loads are not directly comparable`);
    out.push({ exercise: e, samePattern, s, note: diffs.length ? `Not identical: ${diffs.join("; ")}.` : "Closest match: same pattern and target muscles, but weights may still differ." });
  }
  return out.sort((a, b) => b.s - a.s || a.exercise.name.localeCompare(b.exercise.name)).slice(0, limit).map(({ s: _s, ...rest }) => rest);
}

// ------------------------------------------------------------------ custom exercises
export interface CustomExerciseRow {
  id: string; name: string; aliases: string[] | null; primary_muscles: string[]; secondary_muscles: string[] | null; equipment: string; pattern: string; category: string;
  measurement: string; load_mode: string; unilateral: boolean; instructions: string | null; notes: string | null; archived_at: string | null;
}
export function exerciseFromCustom(r: CustomExerciseRow): Exercise {
  const instructions = (r.instructions ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  return {
    key: customKey(r.id), name: r.name, aliases: r.aliases ?? [], primary: r.primary_muscles as Muscle[], secondary: (r.secondary_muscles ?? []) as Muscle[],
    equipment: r.equipment as Equipment, pattern: r.pattern as Pattern, category: r.category as ExerciseCategory, measurement: r.measurement as Measurement,
    loadMode: r.load_mode as LoadMode, unilateral: Boolean(r.unilateral), difficulty: "intermediate", instructions, cues: r.notes ? [r.notes] : [], mistakes: [],
    rest: r.category === "isolation" ? 75 : 120, fit: "unknown" as FitCategory, custom: true, media: null,
  };
}

export interface CustomDraft {
  name: string; aliases: string; primary: Muscle[]; secondary: Muscle[]; equipment: string; pattern: string; category: string; measurement: string;
  loadMode: string; unilateral: boolean; instructions: string; notes: string;
}
export const EMPTY_CUSTOM: CustomDraft = { name: "", aliases: "", primary: [], secondary: [], equipment: "dumbbell", pattern: "isolation_upper", category: "isolation", measurement: "weight_reps", loadMode: "per_hand", unilateral: false, instructions: "", notes: "" };

const clean = (s: string, max: number) => s.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
/** Load modes that make sense for each measurement type. */
export const MODES_FOR: Record<Measurement, readonly LoadMode[]> = {
  weight_reps: ["total", "per_hand"], weight_duration: ["total", "per_hand"], weight_distance: ["total", "per_hand"],
  weighted_bodyweight: ["added"], assisted_bodyweight: ["assisted"], bodyweight_reps: ["none", "added"], duration: ["none"], distance_duration: ["none"],
};

/** Validate a custom exercise before it is saved. The same rules are enforced again by CHECK constraints in the database. */
export function validateCustom(d: CustomDraft, existing: readonly Exercise[]): { ok: true; row: Omit<CustomExerciseRow, "id" | "archived_at"> } | { ok: false; error: string } {
  const name = clean(d.name, 80);
  if (!name) return { ok: false, error: "Give the exercise a name." };
  const nn = normalizeName(name);
  const clash = existing.find((e) => normalizeName(e.name) === nn);
  if (clash) return { ok: false, error: clash.custom ? "You already have a custom exercise with this name." : `"${clash.name}" is already in the library. Use it instead, so your history stays in one place.` };
  if (d.primary.length < 1 || d.primary.length > 4 || d.primary.some((m) => !MUSCLES.includes(m))) return { ok: false, error: "Choose 1 to 4 primary muscles." };
  if (d.secondary.some((m) => !MUSCLES.includes(m)) || d.secondary.length > 6) return { ok: false, error: "Choose up to 6 secondary muscles." };
  const secondary = d.secondary.filter((m) => !d.primary.includes(m));
  if (!(EQUIPMENT as readonly string[]).includes(d.equipment)) return { ok: false, error: "Choose the equipment." };
  if (!(PATTERNS as readonly string[]).includes(d.pattern)) return { ok: false, error: "Choose a movement pattern." };
  if (!(CATEGORIES as readonly string[]).includes(d.category)) return { ok: false, error: "Choose a category." };
  if (!(MEASUREMENTS as readonly string[]).includes(d.measurement)) return { ok: false, error: "Choose what you record for each set." };
  if (!(LOAD_MODES as readonly string[]).includes(d.loadMode) || !MODES_FOR[d.measurement as Measurement].includes(d.loadMode as LoadMode)) return { ok: false, error: "That weight setting does not fit the measurement type." };
  const aliases = d.aliases.split(",").map((a) => clean(a, 60)).filter(Boolean).slice(0, 8);
  return { ok: true, row: {
    name, aliases, primary_muscles: d.primary, secondary_muscles: secondary, equipment: d.equipment, pattern: d.pattern, category: d.category, measurement: d.measurement,
    load_mode: d.loadMode, unilateral: d.unilateral, instructions: d.instructions.trim().slice(0, 2000) || null, notes: clean(d.notes, 500) || null,
  } };
}

/** Find an exercise by key in the catalog or in the user's custom list. Unknown keys return null, never a guess. */
export function resolveExercise(key: string, custom: readonly Exercise[]): Exercise | null {
  if (customIdOf(key)) return custom.find((e) => e.key === key) ?? null;
  return catalogExercise(key);
}
