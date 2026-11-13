// The APEX numeric keypad: pure logic only (no React, no storage, no network). Used by the live workout editor (components/strength/WorkoutEditor.tsx) when the APEX keypad is on: the editor holds the state and draws it, this file decides everything.
//
// Three small pieces, each independently testable:
//   1. The EDIT BUFFER (press): what the keys do to the text of the field being edited. Digits, one decimal point (not for whole-number fields),
//      backspace, clear. The text keeps partial input such as "82." exactly as typed.
//   2. The COMMIT rule (commitOf): which numbers the buffer saves. It is the same rule the current number boxes use (components/strength/WorkoutEditor.tsx
//      NumField): "," counts as ".", an empty box saves "no value", a finite number is saved, anything else saves nothing yet. "82." saves 82 while the
//      text stays "82.". A component later feeds each committed value into the existing updateSet -> save() -> engine.record() path; this file never saves.
//   3. NAVIGATION (nextTarget): the next field for the "Next" key: Weight -> Reps -> the next open set's Weight, then the next exercise. It only reads
//      the workout; it never changes it.
//
// The limits below mirror setPatchError in workout.ts (the database bounds), so the keypad can never type a value the engine would reject.
import type { Measurement, LoadMode } from "./types.ts";
import { updateSet, type Workout } from "./workout.ts";

export type FieldKey = "weight" | "reps" | "duration_s" | "distance_m";
/** The one field the keypad is editing: a single, central piece of state (null = keypad closed). */
export interface ActiveField { exerciseId: string; setId: string; field: FieldKey }

/** Same bounds as setPatchError (workout.ts). */
export const FIELD_MAX: Readonly<Record<FieldKey, number>> = { weight: 2000, reps: 1000, duration_s: 86400, distance_m: 1_000_000 };
/** Whole-number fields: no decimal point. */
export const isIntegerField = (f: FieldKey): boolean => f === "reps" || f === "duration_s";
/** Decimal places allowed while typing (whole-number fields: none). Weights and distances are shown with at most two (units.ts formatWeight). */
export const MAX_DECIMALS = 2;
/** Longest text the buffer holds (digits and the point). */
export const MAX_LENGTH = 9;

export type KeypadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "." | "backspace" | "clear";
export const DIGITS: readonly KeypadKey[] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

export interface KeypadState {
  target: ActiveField | null;
  /** What is typed so far, exactly as typed ("82.", "0.5", ""). */
  text: string;
  /** True right after a field is opened: the first key replaces the old value (like selecting it all), as the native boxes do on focus. */
  replace: boolean;
}
export const CLOSED: KeypadState = Object.freeze({ target: null, text: "", replace: false }) as KeypadState;

/** Start editing a field. The current value (or nothing) is shown; the first key replaces it. */
export function openField(target: ActiveField, value: number | null): KeypadState {
  return { target, text: value === null || !Number.isFinite(value) ? "" : String(value), replace: true };
}

const decimalsOf = (t: string) => (t.includes(".") ? t.length - t.indexOf(".") - 1 : 0);

/** What a key does to the text. Always returns a valid buffer; a key that does not apply (a second point, a digit past the limit) changes nothing. */
export function press(s: KeypadState, key: KeypadKey): KeypadState {
  if (!s.target) return s;
  const field = s.target.field, base = s.replace ? "" : s.text;
  const keep = s;                                            // "nothing happened": same buffer, still showing the old value as replaceable
  const next = (text: string): KeypadState => ({ ...s, text, replace: false });
  switch (key) {
    case "clear": return next("");
    case "backspace": return next(s.replace ? "" : s.text.slice(0, -1));
    case ".": {
      if (isIntegerField(field) || base.includes(".")) return keep;
      return next(base === "" ? "0." : `${base}.`);
    }
    default: {
      if (!DIGITS.includes(key)) return keep;
      const joined = base === "0" ? key : `${base}${key}`;   // no leading zeros: "0" then "5" is "5"
      if (joined.length > MAX_LENGTH || decimalsOf(joined) > MAX_DECIMALS) return keep;
      if (Number(joined) > FIELD_MAX[field]) return keep;
      return next(joined);
    }
  }
}

/** The value the text saves, by the current number-box rule: null = "no value yet" (empty), a number = save it, undefined = save nothing (not a number yet). */
export function commitOf(text: string): number | null | undefined {
  const t = text.replace(",", ".").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** The two value fields of a set, in order, for an exercise type (null = no field there, e.g. plain bodyweight). Mirrors fieldsFor in WorkoutEditor.tsx. */
export function fieldKeysFor(m: Measurement, mode: LoadMode): [FieldKey | null, FieldKey | null] {
  switch (m) {
    case "weight_reps": case "weighted_bodyweight": case "assisted_bodyweight": return ["weight", "reps"];
    case "bodyweight_reps": return [mode === "added" || mode === "assisted" ? "weight" : null, "reps"];
    case "duration": return [null, "duration_s"];
    case "weight_duration": return ["weight", "duration_s"];
    case "distance_duration": return ["distance_m", "duration_s"];
    case "weight_distance": return ["weight", "distance_m"];
  }
}

/** The field the "Next" key moves to, or null when there is none (the keypad then closes). Order: the set's first field, then its second, then the first
 *  field of the next set that is not done yet in the same exercise, then of the next exercise. Done sets are skipped; nothing is created or changed. */
export function nextTarget(w: Workout, from: ActiveField): ActiveField | null {
  const exercises = [...w.exercises].sort((a, b) => a.position - b.position);
  const ei = exercises.findIndex((e) => e.id === from.exerciseId);
  if (ei < 0) return null;
  const cur = exercises[ei];
  const sets = [...cur.sets].sort((a, b) => a.position - b.position);
  const si = sets.findIndex((s) => s.id === from.setId);
  if (si < 0) return null;
  const [f1, f2] = fieldKeysFor(cur.measurement, cur.loadMode);
  if (from.field === f1 && f2 !== null) return { exerciseId: cur.id, setId: from.setId, field: f2 };
  const firstOf = (e: typeof cur, setId: string): ActiveField | null => {
    const [a, b] = fieldKeysFor(e.measurement, e.loadMode), field = a ?? b;
    return field === null ? null : { exerciseId: e.id, setId, field };
  };
  for (const s of sets.slice(si + 1)) if (!s.completed) { const t = firstOf(cur, s.id); if (t) return t; }
  for (const e of exercises.slice(ei + 1)) {
    for (const s of [...e.sets].sort((a, b) => a.position - b.position)) if (!s.completed) { const t = firstOf(e, s.id); if (t) return t; }
  }
  return null;
}

// ------------------------------------------------------------------ putting it together (what the editor calls)
/** Everything the keypad can be told to do: a key of the buffer, move on ("Next"), or close. */
export type KeypadAction = KeypadKey | "next" | "close";

/** A hardware keyboard key (KeyboardEvent.key) as a keypad action, or null when it means nothing here. A comma counts as the decimal point. */
export function actionFromKey(key: string): KeypadAction | null {
  if (key.length === 1 && key >= "0" && key <= "9") return key as KeypadKey;
  switch (key) {
    case ".": case ",": return ".";
    case "Backspace": return "backspace";
    case "Delete": return "clear";
    case "Enter": return "next";
    case "Escape": return "close";
    default: return null;
  }
}

/** The text as shown to the person: with their own decimal separator (the buffer itself always uses "."). */
export const showText = (text: string, separator: "." | ","): string => (separator === "," ? text.replace(".", ",") : text);

/** The value now stored in a field, or null when it is empty or the target is not in the workout. */
export function fieldValue(w: Workout, t: ActiveField): number | null {
  return w.exercises.find((e) => e.id === t.exerciseId)?.sets.find((s) => s.id === t.setId)?.[t.field] ?? null;
}
export const targetExists = (w: Workout, t: ActiveField) => w.exercises.some((e) => e.id === t.exerciseId && e.sets.some((s) => s.id === t.setId));

/** One key press: updates the buffer and, when the text is a valid number (or empty), saves it into the set with the engine's own updateSet, exactly as a
 *  native number box does on every keystroke (a weight carries the exercise's unit). Returns the same objects when nothing changed. Throws what updateSet
 *  throws (the editor shows it); the keys can never produce a value the engine rejects. */
export function applyKey(w: Workout, kp: KeypadState, key: KeypadKey): { w: Workout; kp: KeypadState } {
  const t = kp.target;
  if (!t) return { w, kp };
  if (!targetExists(w, t)) return { w, kp: CLOSED };
  const next = press(kp, key);
  if (next === kp) return { w, kp };
  const value = commitOf(next.text);
  if (value === undefined) return { w, kp: next };
  const unit = w.exercises.find((e) => e.id === t.exerciseId)!.unit;
  return { w: updateSet(w, t.exerciseId, t.setId, { [t.field]: value, ...(t.field === "weight" ? { unit } : {}) }), kp: next };
}

/** "Next": the next field opened (with its current value), or CLOSED when there is none. */
export function advance(w: Workout, kp: KeypadState): KeypadState {
  if (!kp.target) return CLOSED;
  const t = nextTarget(w, kp.target);
  return t ? openField(t, fieldValue(w, t)) : CLOSED;
}
/** Open a field by tapping it. */
export const tapField = (w: Workout, t: ActiveField): KeypadState => (targetExists(w, t) ? openField(t, fieldValue(w, t)) : CLOSED);
