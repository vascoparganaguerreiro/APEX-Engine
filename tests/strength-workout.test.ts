import test from "node:test";
import assert from "node:assert/strict";
import {
  WorkoutError, addExercise, addSet, afterSet, completeSet, currentExercise, elapsedSeconds, finish, moveExercise, nextExercise, pause, progress, removeExercise,
  removeSet, replaceExercise, resume, rowsOf, rpeRirMismatch, setDetails, setExerciseUnit, setPatchError, setSuperset, startWorkout, uncompleteSet, updateSet,
  type Workout,
} from "../lib/strength/workout.ts";
import { effectiveLoadKg, fromKg, setVolumeKg, toKg } from "../lib/strength/units.ts";
import { T0, at, ex, uid } from "./strength-fixtures.ts";

const fresh = (): Workout => startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "kg", timezone: "Europe/Lisbon" });
const withBench = () => { const w = addExercise(fresh(), ex("barbell_bench_press"), { id: uid(), unit: "kg", setId: uid() }); return { w, e: w.exercises[0] }; };

test("units: kg/lb conversion and the load actually moved", () => {
  assert.equal(Math.round(toKg(225, "lb") * 100) / 100, 102.06);
  assert.equal(Math.round(fromKg(100, "lb") * 10) / 10, 220.5);
  assert.equal(effectiveLoadKg(30, "kg", "per_hand", null), 60, "two dumbbells");
  assert.equal(effectiveLoadKg(30, "kg", "total", null), 30);
  assert.equal(effectiveLoadKg(20, "kg", "added", 80), 100, "weighted pull-up");
  assert.equal(effectiveLoadKg(30, "kg", "assisted", 80), 50, "assistance is subtracted");
  assert.equal(effectiveLoadKg(30, "kg", "assisted", null), null, "never guessed without bodyweight");
  assert.equal(effectiveLoadKg(null, "kg", "none", null), null);
  assert.equal(setVolumeKg(30, "kg", "per_hand", 10), 600, "per hand counts both dumbbells");
  assert.equal(setVolumeKg(30, "kg", "assisted", 10), 0, "assisted sets have no external volume");
  assert.equal(setVolumeKg(null, "kg", "total", 10), 0);
});

test("set validation mirrors the database bounds; RPE/RIR disagreement is flagged, not corrected", () => {
  assert.equal(setPatchError({ weight: 80, reps: 8, rpe: 8.5, rir: 2 }), null);
  assert.match(setPatchError({ reps: 2.5 })!, /whole number/);
  assert.match(setPatchError({ rpe: 8.3 })!, /steps of 0.5/);
  assert.match(setPatchError({ rpe: 11 })!, /RPE/);
  assert.match(setPatchError({ rir: -1 })!, /RIR/);
  assert.match(setPatchError({ weight: 5000 })!, /Weight/);
  assert.match(setPatchError({ weight: Number.NaN })!, /Weight/);
  assert.equal(rpeRirMismatch(8, 2), false);
  assert.equal(rpeRirMismatch(6, 0), true);
});

test("logging: enter weight and reps, complete, and the next set is prefilled but editable", () => {
  let { w, e } = withBench();
  const s1 = e.sets[0].id;
  assert.throws(() => completeSet(w, e.id, s1, at(1)), /reps/);
  w = updateSet(w, e.id, s1, { weight: 80, reps: 8, rpe: 8 });
  w = addSet(w, e.id, uid());
  w = addSet(w, e.id, uid());
  const s2 = w.exercises[0].sets[1];
  assert.deepEqual([s2.weight, s2.reps, s2.completed, s2.type], [80, 8, false, "working"], "a new set copies the previous values");
  w = updateSet(w, e.id, s2.id, { weight: null, reps: null });
  w = completeSet(w, e.id, s1, at(3));
  const after = w.exercises[0].sets;
  assert.equal(after[0].completed, true);
  assert.equal(after[0].completed_at, at(3));
  assert.deepEqual([after[1].weight, after[1].reps], [80, 8], "empty values of the next set are prefilled after completing");
  w = updateSet(w, e.id, after[1].id, { weight: 82.5 });
  assert.equal(w.exercises[0].sets[1].weight, 82.5, "and can be changed freely");
  w = uncompleteSet(w, e.id, s1);
  assert.equal(w.exercises[0].sets[0].completed, false);
  w = removeSet(w, e.id, after[2].id);
  assert.deepEqual(w.exercises[0].sets.map((s) => s.position), [0, 1]);
});

test("bodyweight, assisted, timed and distance exercises need the right fields", () => {
  let w = fresh();
  for (const k of ["push_up", "assisted_pull_up", "plank", "rowing_machine", "dumbbell_bench_press", "farmer_carry"]) w = addExercise(w, ex(k), { id: uid(), unit: "kg", setId: uid() });
  const [push, assist, plank, row, db, carry] = w.exercises;
  assert.throws(() => completeSet(w, push.id, push.sets[0].id, T0), /reps/);
  w = updateSet(w, push.id, push.sets[0].id, { reps: 15 });
  w = completeSet(w, push.id, push.sets[0].id, T0);                                     // no weight needed
  w = updateSet(w, assist.id, assist.sets[0].id, { reps: 8 });
  w = completeSet(w, assist.id, assist.sets[0].id, T0);                                 // assistance optional
  assert.throws(() => completeSet(w, plank.id, plank.sets[0].id, T0), /time/);
  w = updateSet(w, plank.id, plank.sets[0].id, { duration_s: 60 });
  w = completeSet(w, plank.id, plank.sets[0].id, T0);
  w = updateSet(w, row.id, row.sets[0].id, { distance_m: 2000 });
  w = completeSet(w, row.id, row.sets[0].id, T0);
  w = updateSet(w, db.id, db.sets[0].id, { reps: 10 });
  assert.throws(() => completeSet(w, db.id, db.sets[0].id, T0), /weight/, "a dumbbell set needs its weight");
  assert.equal(db.loadMode, "per_hand", "dumbbell weight is entered per hand");
  w = updateSet(w, carry.id, carry.sets[0].id, { weight: 32, distance_m: 40 });
  w = completeSet(w, carry.id, carry.sets[0].id, T0);
  assert.equal(progress(w).done, 5);
});

test("unilateral sets alternate sides; switching units never converts existing sets", () => {
  let w = addExercise(fresh(), ex("bulgarian_split_squat"), { id: uid(), unit: "kg", setId: uid() });
  const e = w.exercises[0];
  w = updateSet(w, e.id, e.sets[0].id, { weight: 20, reps: 10, side: "left" });
  w = addSet(w, e.id, uid());
  assert.equal(w.exercises[0].sets[1].side, "right");
  w = setExerciseUnit(w, e.id, "lb");
  assert.deepEqual(w.exercises[0].sets.map((s) => [s.weight, s.unit]), [[20, "kg"], [20, "kg"]]);
  w = addSet(w, e.id, uid());
  assert.equal(w.exercises[0].unit, "lb");
});

test("routine start, ordering, replacement and supersets", () => {
  const plan = [
    { exercise: ex("barbell_bench_press"), superset: null, rest: 180, loadMode: null, unit: "kg" as const, notes: "pause reps", sets: [
      { type: "warmup" as const, repsMin: 8, repsMax: 8, weight: 40, rpe: null, rir: null, duration_s: null, distance_m: null },
      { type: "working" as const, repsMin: 6, repsMax: 8, weight: null, rpe: 8, rir: 2, duration_s: null, distance_m: null }] },
    { exercise: ex("barbell_row"), superset: null, rest: null, loadMode: null, unit: "kg" as const, notes: null, sets: [] },
  ];
  let w = startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "kg", routineId: uid(), plan });
  assert.equal(w.exercises.length, 2);
  assert.equal(w.exercises[0].rest, 180);
  assert.deepEqual(w.exercises[0].sets.map((s) => [s.type, s.weight, s.reps]), [["warmup", 40, null], ["working", null, null]], "targets are guidance; reps are not invented");
  assert.equal(w.exercises[0].sets[1].target?.repsMax, 8);
  assert.equal(w.exercises[1].sets.length, 1, "an exercise without planned sets still gets one empty set");
  w = moveExercise(w, w.exercises[1].id, 0);
  assert.equal(w.exercises[0].name, "Bent-Over Row (Barbell)");
  // replace with completed sets: they stay with the original exercise
  const bench = w.exercises[1];
  w = updateSet(w, bench.id, bench.sets[0].id, { reps: 8 });
  w = completeSet(w, bench.id, bench.sets[0].id, at(5));
  const newId = uid();
  w = replaceExercise(w, bench.id, ex("dumbbell_bench_press"), { newId, unit: "kg" });
  assert.equal(w.exercises[1].name, "Bench Press (Barbell)");
  assert.equal(w.exercises[1].sets.length, 1, "the completed warm-up stays with the barbell bench");
  assert.equal(w.exercises[2].name, "Bench Press (Dumbbell)");
  assert.deepEqual([w.exercises[2].sets.length, w.exercises[2].sets[0].weight], [1, null], "remaining sets move without carrying the barbell load");
  // superset: no rest between A and B, rest after the round
  w = setSuperset(w, [w.exercises[0].id, w.exercises[2].id]);
  const [a, , b] = w.exercises;
  assert.equal(a.superset, b.superset);
  assert.deepEqual(afterSet(w, a.id), { restSeconds: 0, goTo: b.id });
  assert.equal(afterSet(w, b.id).restSeconds, b.rest);
  w = removeExercise(w, w.exercises[1].id);
  assert.deepEqual(w.exercises.map((e) => e.position), [0, 1]);
  assert.throws(() => removeExercise(w, uid()), WorkoutError);
});

test("current/next exercise and progress through the routine", () => {
  let w = fresh();
  for (const k of ["back_squat", "leg_press", "leg_extension"]) w = addExercise(w, ex(k), { id: uid(), unit: "kg", setId: uid() });
  assert.equal(currentExercise(w)?.name, "Squat (Barbell)");
  assert.equal(nextExercise(w)?.name, "Leg Press (Machine)");
  const sq = w.exercises[0];
  w = updateSet(w, sq.id, sq.sets[0].id, { weight: 100, reps: 5 });
  w = completeSet(w, sq.id, sq.sets[0].id, at(4));
  assert.equal(currentExercise(w)?.name, "Leg Press (Machine)", "moves on once all sets are done");
  assert.deepEqual(progress(w), { done: 1, total: 3, exercisesDone: 1, exercises: 3 });
});

test("pause, resume, duration and finishing", () => {
  let { w, e } = withBench();
  w = pause(w, at(10));
  assert.equal(elapsedSeconds(w, at(15)), 600, "paused time is not counted");
  w = resume(w, at(15));
  assert.equal(w.pausedSeconds, 300);
  assert.equal(elapsedSeconds(w, at(20)), 900);
  assert.throws(() => finish(w, at(30), { discardIncomplete: true }), /at least one set/);
  w = updateSet(w, e.id, e.sets[0].id, { weight: 60, reps: 10 });
  w = completeSet(w, e.id, e.sets[0].id, at(21));
  w = addSet(w, e.id, uid());
  w = pause(w, at(25));
  const done = finish(w, at(30), { discardIncomplete: true });
  assert.equal(done.status, "completed");
  assert.equal(done.pausedAt, null, "finishing while paused closes the pause");
  assert.equal(elapsedSeconds(done, at(99)), 30 * 60 - 300 - 300);
  assert.equal(done.exercises[0].sets.length, 1, "unfinished sets were discarded on request");
  assert.throws(() => finish(done, at(31), { discardIncomplete: false }), /already finished/);
  const edited = setDetails(done, { title: "Push day", effort: 8, notes: "felt strong" });
  assert.deepEqual([edited.title, edited.effort], ["Push day", 8]);
  assert.throws(() => setDetails(done, { endedAt: at(-5) }), /after the start/);
  assert.throws(() => setDetails(done, { effort: 11 }), /1 to 10/);
});

test("rows for sync: one row per session, exercise and set, with units kept per set", () => {
  let { w, e } = withBench();
  w = updateSet(w, e.id, e.sets[0].id, { weight: 100, reps: 5, unit: "kg" });
  const rows = rowsOf(w);
  assert.deepEqual(rows.map((r) => r.kind), ["session", "exercise", "set"]);
  assert.equal(rows[1].data.exercise_key, "barbell_bench_press");
  assert.equal(rows[1].data.custom_exercise_id, null);
  assert.equal(rows[2].data.session_exercise_id, e.id);
  assert.equal(rows[2].data.weight_unit, "kg");
  const custom = addExercise(fresh(), { ...ex("cable_fly"), key: "custom:11111111-1111-4111-8111-111111111111", custom: true }, { id: uid(), unit: "lb", setId: uid() });
  const cr = rowsOf(custom)[1].data;
  assert.deepEqual([cr.exercise_key, cr.custom_exercise_id], [null, "11111111-1111-4111-8111-111111111111"]);
});
