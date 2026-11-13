// Stage 1 of the premium workout logger: the pure keypad logic (edit buffer, commit rule, field order and navigation).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CLOSED, FIELD_MAX, MAX_LENGTH, commitOf, fieldKeysFor, isIntegerField, nextTarget, openField, press,
  type ActiveField, type FieldKey, type KeypadKey, type KeypadState,
} from "../lib/strength/keypad.ts";
import { MEASUREMENTS, LOAD_MODES, type Measurement, type LoadMode } from "../lib/strength/types.ts";
import { MODES_FOR } from "../lib/strength/library.ts";
import { addExercise, addSet, completeSet, setPatchError, startWorkout, updateSet, type Workout } from "../lib/strength/workout.ts";
import { T0, at, ex, uid } from "./strength-fixtures.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const target = (field: FieldKey): ActiveField => ({ exerciseId: "e1", setId: "s1", field });
/** Type keys into a field that has no previous value (or after the old value was replaced). */
const type = (field: FieldKey, keys: KeypadKey[], value: number | null = null): KeypadState => keys.reduce((s, k) => press(s, k), openField(target(field), value));
const typed = (field: FieldKey, str: string, value: number | null = null) => type(field, str.split("").map((c) => (c === "<" ? "backspace" : c)) as KeypadKey[], value).text;

test("digits and the decimal point build the text exactly as typed, including partial decimals", () => {
  assert.equal(typed("weight", "82"), "82");
  assert.equal(typed("weight", "82."), "82.", "a trailing point is kept while typing");
  assert.equal(typed("weight", "82.5"), "82.5");
  assert.equal(typed("weight", "."), "0.", "a point first becomes 0.");
  assert.equal(typed("weight", ".5"), "0.5");
  assert.equal(typed("weight", "82.5."), "82.5", "a second point is ignored");
  assert.equal(typed("weight", "82.555"), "82.55", "at most two decimals");
  assert.equal(typed("weight", "05"), "5", "no leading zeros");
  assert.equal(typed("weight", "00"), "0");
  assert.equal(typed("weight", "0.05"), "0.05");
});

test("whole-number fields (reps, seconds) take digits only", () => {
  for (const f of ["reps", "duration_s"] as const) {
    assert.equal(isIntegerField(f), true); assert.equal(typed(f, "12"), "12"); assert.equal(typed(f, "1.2"), "12", `${f}: the point is ignored`);
    assert.equal(typed(f, "."), "", `${f}: a lone point does nothing`);
  }
  for (const f of ["weight", "distance_m"] as const) assert.equal(isIntegerField(f), false);
  assert.equal(typed("distance_m", "400.5"), "400.5");
});

test("backspace and clear", () => {
  assert.equal(typed("weight", "82.5<"), "82.");
  assert.equal(typed("weight", "82.5<<"), "82");
  assert.equal(typed("weight", "8<<<"), "", "backspace on an empty buffer stays empty");
  assert.equal(type("weight", ["8", "2", "clear"]).text, "");
  assert.equal(type("weight", ["8", "2", "clear", "5"]).text, "5", "typing continues after clear");
});

test("opening a field shows its value; the first key replaces it, later keys append", () => {
  const s = openField(target("weight"), 80);
  assert.deepEqual([s.text, s.replace], ["80", true]);
  assert.equal(press(s, "9").text, "9", "like selecting the old value and typing over it");
  assert.equal(press(press(s, "9"), "2").text, "92");
  assert.equal(press(s, "backspace").text, "", "backspace on a replaceable value clears it, as select-all + delete does");
  assert.equal(press(s, ".").text, "0.");
  assert.equal(openField(target("reps"), null).text, "");
  assert.equal(openField(target("weight"), 82.5).text, "82.5");
  assert.equal(openField(target("weight"), Number.NaN).text, "");
  assert.equal(press(CLOSED, "5"), CLOSED, "a closed keypad ignores keys");
});

test("a key that does not apply changes nothing, and the old value stays replaceable", () => {
  const s = openField(target("reps"), 8);
  assert.equal(press(s, "."), s);
  assert.equal(press(s, "x" as KeypadKey), s);
});

test("limits mirror the engine's bounds, so the keypad can never type a value setPatchError rejects", () => {
  assert.deepEqual({ ...FIELD_MAX }, { weight: 2000, reps: 1000, duration_s: 86400, distance_m: 1_000_000 });
  const patch = (f: FieldKey, v: number) => setPatchError({ [f]: v });
  for (const f of Object.keys(FIELD_MAX) as FieldKey[]) {
    assert.equal(patch(f, FIELD_MAX[f]), null, `${f} at its limit is accepted by the engine`); assert.notEqual(patch(f, FIELD_MAX[f] + 1), null, `${f} above it is rejected`);
  }
  assert.equal(typed("weight", "2000"), "2000"); assert.equal(typed("weight", "20000"), "2000", "a digit that would pass 2000 is ignored");
  assert.equal(typed("weight", "2000.5"), "2000.", "the point is allowed, but a decimal digit that passes 2000 is ignored");
  assert.equal(commitOf(typed("weight", "2000.5")), 2000);
  assert.equal(typed("reps", "1000"), "1000"); assert.equal(typed("reps", "10000"), "1000");
  assert.equal(typed("duration_s", "86400"), "86400"); assert.equal(typed("duration_s", "86401"), "8640", "the last digit would pass the limit, so it is ignored");
  assert.ok(typed("distance_m", "1".repeat(30)).length <= MAX_LENGTH, "the text never grows without bound");
  // every buffer the keys can produce is something the engine accepts (or is empty)
  const keys: KeypadKey[] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "backspace"];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const f of Object.keys(FIELD_MAX) as FieldKey[]) {
    for (let run = 0; run < 200; run++) {
      let s = openField(target(f), null);
      for (let i = 0; i < 14; i++) {
        s = press(s, keys[Math.floor(rnd() * keys.length)]);
        const c = commitOf(s.text);
        assert.ok(c === null || (c !== undefined && patch(f, c) === null), `${f}: "${s.text}" is valid`);
        if (isIntegerField(f)) assert.ok(c === null || (c !== undefined && Number.isInteger(c)), `${f}: "${s.text}" is whole`);
      }
    }
  }
});

test("commit rule: the same as the current number boxes (NumField), kept exactly", () => {
  assert.equal(commitOf(""), null, "empty saves 'no value'");
  assert.equal(commitOf("   "), null);
  assert.equal(commitOf("82"), 82); assert.equal(commitOf("82."), 82, "a partial decimal saves its value while the text keeps the point");
  assert.equal(commitOf("82,5"), 82.5, "a comma counts as a point (hardware keyboards, some locales)");
  assert.equal(commitOf("0."), 0); assert.equal(commitOf("0.5"), 0.5); assert.equal(commitOf(" 7 "), 7);
  assert.equal(commitOf("."), undefined, "not a number yet: nothing is saved");
  assert.equal(commitOf("abc"), undefined); assert.equal(commitOf("1e999"), undefined, "not finite");
  // The current component does exactly this, so the keypad and a native box can never disagree:
  const field = read("components/strength/WorkoutEditor.tsx");
  assert.match(field, /const t = e\.target\.value\.replace\(",", "\."\)\.trim\(\); if \(t === ""\) onCommit\(null\); else \{ const n = Number\(t\); if \(Number\.isFinite\(n\)\) onCommit\(n\); \}/);
});

test("field order per exercise type matches the editor, for every measurement and weight mode", () => {
  const all = MEASUREMENTS.flatMap((m) => LOAD_MODES.map((mode) => [m, mode] as [Measurement, LoadMode]));
  const expected = (m: Measurement, mode: LoadMode): [FieldKey | null, FieldKey | null] => {
    if (m === "weight_reps" || m === "weighted_bodyweight" || m === "assisted_bodyweight") return ["weight", "reps"];
    if (m === "bodyweight_reps") return [mode === "added" || mode === "assisted" ? "weight" : null, "reps"];
    if (m === "duration") return [null, "duration_s"];
    if (m === "weight_duration") return ["weight", "duration_s"];
    if (m === "distance_duration") return ["distance_m", "duration_s"];
    return ["weight", "distance_m"];
  };
  for (const [m, mode] of all) assert.deepEqual(fieldKeysFor(m, mode), expected(m, mode), `${m} / ${mode}`);
  for (const m of MEASUREMENTS) for (const mode of MODES_FOR[m]) assert.ok(fieldKeysFor(m, mode)[1] !== null, `${m}/${mode} always has a second field`);
  // and the editor's own table lists the same measurements (so a new measurement cannot be added in one place only)
  const src = read("components/strength/WorkoutEditor.tsx");
  const cases = [...src.slice(src.indexOf("function fieldsFor"), src.indexOf("/** A number box")).matchAll(/case "([a-z_]+)"/g)].map((x) => x[1]).sort();
  assert.deepEqual(cases, [...MEASUREMENTS].sort(), "fieldsFor handles every measurement, once");
});

// ---------------------------------------------------------------- navigation
const fresh = (): Workout => startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "kg", timezone: "Europe/Lisbon" });
function build() {
  let w = addExercise(fresh(), ex("barbell_bench_press"), { id: uid(), unit: "kg", setId: uid() });
  const bench = w.exercises[0].id;
  w = addSet(w, bench, uid()); w = addSet(w, bench, uid());
  w = addExercise(w, ex("bulgarian_split_squat"), { id: uid(), unit: "kg", setId: uid() });
  const squat = w.exercises[1].id;
  return { w, bench, squat, sets: (id: string) => w.exercises.find((e) => e.id === id)!.sets.map((s) => s.id) };
}
const at_ = (exerciseId: string, setId: string, field: FieldKey): ActiveField => ({ exerciseId, setId, field });

test("Next: Weight -> Reps -> the next set's Weight -> ... -> the next exercise -> end", () => {
  const { w, bench, squat, sets } = build();
  const [b1, b2, b3] = sets(bench), [q1] = sets(squat);
  assert.deepEqual(nextTarget(w, at_(bench, b1, "weight")), at_(bench, b1, "reps"));
  assert.deepEqual(nextTarget(w, at_(bench, b1, "reps")), at_(bench, b2, "weight"));
  assert.deepEqual(nextTarget(w, at_(bench, b2, "reps")), at_(bench, b3, "weight"));
  assert.deepEqual(nextTarget(w, at_(bench, b3, "reps")), at_(squat, q1, "weight"), "after the last set, the next exercise");
  assert.equal(nextTarget(w, at_(squat, q1, "reps")), null, "after the very last field the keypad closes");
});

test("Next skips sets that are already done, and unknown targets close the keypad", () => {
  let { w, bench, squat, sets } = build();
  const [b1, b2, b3] = sets(bench), [q1] = sets(squat);
  w = updateSet(w, bench, b2, { weight: 80, reps: 8 }); w = completeSet(w, bench, b2, at(1));
  assert.deepEqual(nextTarget(w, at_(bench, b1, "reps")), at_(bench, b3, "weight"), "the done middle set is skipped");
  w = updateSet(w, bench, b3, { weight: 80, reps: 8 }); w = completeSet(w, bench, b3, at(2));
  assert.deepEqual(nextTarget(w, at_(bench, b1, "reps")), at_(squat, q1, "weight"));
  assert.equal(nextTarget(w, at_("nope", b1, "weight")), null);
  assert.equal(nextTarget(w, at_(bench, "nope", "weight")), null);
});

test("Next follows the exercise's own fields: timed and bodyweight exercises", () => {
  let w = addExercise(fresh(), ex("plank"), { id: uid(), unit: "kg", setId: uid() });
  const plank = w.exercises[0]; w = addSet(w, plank.id, uid());
  const [p1, p2] = w.exercises[0].sets.map((s) => s.id);
  assert.deepEqual(fieldKeysFor(plank.measurement, plank.loadMode), [null, "duration_s"]);
  assert.deepEqual(nextTarget(w, at_(plank.id, p1, "duration_s")), at_(plank.id, p2, "duration_s"), "only one field per set: straight to the next set");
  let b = addExercise(fresh(), ex("pull_up"), { id: uid(), unit: "kg", setId: uid() });
  const pu = b.exercises[0]; b = addSet(b, pu.id, uid());
  const [u1, u2] = b.exercises[0].sets.map((s) => s.id);
  if (fieldKeysFor(pu.measurement, pu.loadMode)[0] === null) assert.deepEqual(nextTarget(b, at_(pu.id, u1, "reps")), at_(pu.id, u2, "reps"), "no weight field: reps to reps");
  else assert.deepEqual(nextTarget(b, at_(pu.id, u1, "weight")), at_(pu.id, u1, "reps"));
});

test("navigation and the keys never change a workout, and this module is pure", () => {
  const { w, bench, sets } = build(); const before = JSON.stringify(w);
  nextTarget(w, at_(bench, sets(bench)[0], "weight"));
  assert.equal(JSON.stringify(w), before);
  assert.doesNotMatch(read("lib/strength/keypad.ts"), /localStorage|indexedDB|fetch\(|supabase|document\.|window\.|import .* from "react"/, "no UI, storage or network");
});
