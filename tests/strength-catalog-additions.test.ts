// Two exercises added to the bundled catalogue: Single-Arm Triceps Pushdown (cable, one side at a time) and Scapular Raise (bodyweight).
import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { CATALOG, MODES_FOR, catalogExercise, normalizeName, searchExercises } from "../lib/strength/library.ts";
import { EQUIPMENT, FIT_CATEGORY, MUSCLES, PATTERNS } from "../lib/strength/types.ts";
import { fromWorkout, lastPerformance } from "../lib/strength/analytics.ts";
import { previousLabel, previousPerSet } from "../lib/strength/previous.ts";
import { MemoryStore, SyncEngine } from "../lib/strength/sync.ts";
import { WorkoutError, addExercise, addSet, completeSet, moveExercise, rowsOf, startWorkout, updateSet, type Workout } from "../lib/strength/workout.ts";
import { FakeStrengthServer, T0, at, clock, transportFor, uid, testOwner } from "./strength-fixtures.ts";

const PUSHDOWN = "single_arm_triceps_pushdown", SCAP = "scapular_raise";
const ex = (k: string) => { const e = catalogExercise(k); assert.ok(e, k); return e!; };
const fresh = (): Workout => startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "kg", timezone: "Europe/Lisbon" });

test("both exercises exist once, with valid keys, and nothing was duplicated", () => {
  assert.equal(CATALOG.length, 167, "165 exercises before, plus these two");
  for (const k of [PUSHDOWN, SCAP]) { assert.equal(CATALOG.filter((e) => e.key === k).length, 1, k); assert.match(k, /^[a-z0-9_]{2,60}$/, "the key the database accepts (13_strength.sql), so no migration is needed"); }
  assert.equal(new Set(CATALOG.map((e) => e.key)).size, CATALOG.length); assert.equal(new Set(CATALOG.map((e) => normalizeName(e.name))).size, CATALOG.length, "no duplicate name");
  // none of their aliases is another exercise's name or alias
  for (const k of [PUSHDOWN, SCAP]) for (const a of ex(k).aliases) {
    const clash = CATALOG.filter((o) => o.key !== k && (normalizeName(o.name) === normalizeName(a) || o.aliases.some((x) => normalizeName(x) === normalizeName(a)))).map((o) => o.key);
    assert.deepEqual(clash, [], `alias "${a}"`);
  }
});

test("Single-Arm Triceps Pushdown: cable, triceps, one side at a time, logged per cable with a total load", () => {
  const e = ex(PUSHDOWN);
  assert.equal(e.name, "Single-Arm Triceps Pushdown (Cable)"); assert.deepEqual(e.primary, ["triceps"]); assert.deepEqual(e.secondary, []);
  assert.equal(e.equipment, "cable"); assert.equal(e.pattern, "isolation_upper"); assert.equal(e.category, "isolation"); assert.equal(e.fit, "triceps_extension");
  assert.equal(e.unilateral, true, "left and right are logged separately"); assert.equal(e.measurement, "weight_reps"); assert.equal(e.loadMode, "total"); assert.ok(MODES_FOR[e.measurement].includes(e.loadMode));
  assert.equal(e.difficulty, "beginner"); assert.equal(e.rest, 75, "the isolation default, like the other pushdowns");
  assert.ok(e.instructions.length >= 2 && e.cues.length >= 1 && e.mistakes.length >= 1); assert.match(e.instructions.join(" "), /one hand/); assert.match(e.instructions.join(" "), /switch arms/);
  assert.ok(e.aliases.includes("one arm triceps pushdown") && e.aliases.includes("single arm pushdown"));
});

test("Hanging Scapular Raise: hanging from a pull-up bar with straight arms, bodyweight, counted in reps", () => {
  const e = ex(SCAP);
  assert.equal(e.key, "scapular_raise", "the key is unchanged, so history and saved workouts keep working"); assert.equal(e.name, "Hanging Scapular Raise");
  assert.deepEqual(e.primary, ["upper_back"], "the scapular stabilisers (lower and middle trapezius, serratus) are part of the upper back"); assert.deepEqual(e.secondary, ["shoulders", "lats", "forearms"], "shoulders, lats assisting the downward phase, and grip");
  assert.equal(e.equipment, "bodyweight", "the same as Pull-Up, Chin-Up and Hanging Leg Raise: the bar is in the instructions"); assert.equal(e.pattern, "vertical_pull"); assert.equal(e.category, "isolation"); assert.equal(e.fit, "pull_up");
  assert.equal(e.measurement, "bodyweight_reps"); assert.equal(e.loadMode, "none"); assert.ok(MODES_FOR[e.measurement].includes("added"), "weight can still be added if wanted"); assert.equal(e.unilateral, false);
  assert.equal(e.difficulty, "beginner"); assert.equal(e.rest, 60); assert.ok(e.cues.length >= 3 && e.mistakes.length >= 3);
  const how = e.instructions.join(" ");
  assert.equal(e.instructions.length, 3); assert.match(e.instructions[0], /pull-up bar/); assert.match(e.instructions[0], /arms straight/);
  assert.match(e.instructions[1], /elbows locked straight/); assert.match(e.instructions[1], /scapular depression/); assert.match(e.instructions[2], /scapular elevation/); assert.match(e.instructions[2], /towards the ears/); assert.match(how, /one rep/);
  assert.match(e.mistakes.join(" "), /Bending the elbows/); assert.match(e.cues.join(" "), /Elbows stay straight/);
  for (const a of ["scapular raises", "scapular elevation", "shoulder blade raise"]) assert.ok(e.aliases.includes(a), `the earlier alias "${a}" is kept`);
  for (const a of ["hanging scapular raises", "scapular shrug", "scapular shrugs"]) assert.ok(e.aliases.includes(a), `new alias "${a}"`);
  // "pull-up bar" is not a separate equipment type: the database only accepts the types below for custom exercises (13_strength.sql), so none was invented
  assert.deepEqual(["pull_up", "chin_up", "hanging_leg_raise"].map((k) => ex(k).equipment), ["bodyweight", "bodyweight", "bodyweight"]);
  assert.match(readFileSync(new URL("../13_strength.sql", import.meta.url), "utf8"), /equipment in \('barbell','dumbbell','cable','machine','smith_machine','kettlebell','band','bodyweight','other'\)/);
  assert.equal(CATALOG.filter((x) => /scapul/i.test(x.name + x.key)).length, 1, "one scapular exercise, not two");
});

test("every field is valid and every other exercise is untouched", () => {
  for (const k of [PUSHDOWN, SCAP]) {
    const e = ex(k);
    assert.ok(e.primary.every((m) => MUSCLES.includes(m)) && e.secondary.every((m) => MUSCLES.includes(m))); assert.ok(EQUIPMENT.includes(e.equipment)); assert.ok(PATTERNS.includes(e.pattern));
    assert.ok(e.fit in FIT_CATEGORY); assert.equal(e.media, null); assert.equal(e.custom, undefined);
  }
  // the neighbours they were added next to are exactly as before
  const a = ex("triceps_pushdown"), b = ex("triceps_rope_pushdown"), c = ex("band_pull_apart");
  assert.deepEqual([a.name, a.aliases, a.unilateral, a.loadMode], ["Triceps Pushdown (Cable Bar)", ["pushdown", "cable pushdown"], false, "total"]);
  assert.deepEqual([b.name, b.aliases, b.unilateral], ["Triceps Pushdown (Rope)", ["rope pushdown"], false]);
  assert.deepEqual([c.name, c.fit, c.measurement, c.loadMode], ["Band Pull-Apart", "shoulder_stability", "bodyweight_reps", "none"]);
});

test("search finds them by their names and the way people type them, and does not displace the originals", () => {
  const top = (q: string) => searchExercises(CATALOG, { query: q })[0]?.key;
  for (const q of ["single arm triceps pushdown", "Single-Arm Triceps Pushdown", "one arm pushdown", "single arm cable pushdown", "one-arm triceps pushdown"]) assert.equal(top(q), PUSHDOWN, q);
  for (const q of ["scapular raise", "scapular raises", "Scapular Raises", "scapular elevation", "shoulder blade raise", "hanging scapular raise", "Hanging Scapular Raises", "scapular shrug", "scapular shrugs"]) assert.equal(top(q), SCAP, q);
  assert.equal(top("hanging leg raise"), "hanging_leg_raise", "the other hanging exercise is not displaced"); assert.match(top("shrug") ?? "", /^(barbell|dumbbell)_shrug$/, "a plain 'shrug' still goes to the weighted shrugs, not to this exercise");
  assert.ok(searchExercises(CATALOG, { query: "hanging" }).slice(0, 6).some((e) => e.key === SCAP), "it shows up when you look for hanging exercises");
  assert.equal(top("pushdown"), "triceps_pushdown", "the generic alias still goes to the bar pushdown"); assert.equal(top("rope pushdown"), "triceps_rope_pushdown");
  const pushdowns = searchExercises(CATALOG, { query: "triceps pushdown" }).map((e) => e.key);
  assert.ok(["triceps_pushdown", "triceps_rope_pushdown", PUSHDOWN].every((k) => pushdowns.includes(k)), "all three pushdowns are listed");
  assert.ok(searchExercises(CATALOG, { muscle: "triceps", equipment: "cable" }).some((e) => e.key === PUSHDOWN));
  assert.ok(searchExercises(CATALOG, { muscle: "upper_back", equipment: "bodyweight" }).some((e) => e.key === SCAP)); assert.ok(searchExercises(CATALOG, { pattern: "vertical_pull" }).some((e) => e.key === SCAP));
  assert.ok(searchExercises(CATALOG, { muscle: "shoulders", includeSecondary: true }).some((e) => e.key === SCAP));
});

test("single-arm pushdown logs left and right: sides alternate, each is saved, and both sides must be done", () => {
  const e0 = ex(PUSHDOWN);
  let w = addExercise(fresh(), e0, { id: uid(), unit: "kg", setId: uid() });
  const id = w.exercises[0].id;
  assert.equal(w.exercises[0].unilateral, true); assert.deepEqual([w.exercises[0].measurement, w.exercises[0].loadMode], ["weight_reps", "total"]);
  w = updateSet(w, id, w.exercises[0].sets[0].id, { side: "left", weight: 15, reps: 12 });
  w = addSet(w, id, uid()); w = addSet(w, id, uid()); w = addSet(w, id, uid());
  assert.deepEqual(w.exercises[0].sets.map((s) => s.side), ["left", "right", "left", "right"], "sides alternate automatically after the first");
  assert.deepEqual(w.exercises[0].sets.map((s) => [s.weight, s.reps]), [[15, 12], [15, 12], [15, 12], [15, 12]], "a new set copies the previous load");
  assert.throws(() => completeSet(updateSet(w, id, w.exercises[0].sets[1].id, { weight: null, reps: null }), id, w.exercises[0].sets[1].id, at(1)), WorkoutError, "a set still needs its reps");
  w = completeSet(w, id, w.exercises[0].sets[0].id, at(1)); w = completeSet(w, id, w.exercises[0].sets[1].id, at(2));
  assert.deepEqual(w.exercises[0].sets.map((s) => s.completed), [true, true, false, false]);
  assert.equal(rowsOf(w).filter((r) => r.kind === "set").every((r, i) => (r.data as { side: string }).side === ["left", "right", "left", "right"][i]), true, "the side is saved with each set");
});

test("hanging scapular raise logs with reps only, no weight needed", () => {
  let w = addExercise(fresh(), ex(SCAP), { id: uid(), unit: "kg", setId: uid() });
  const e = w.exercises[0], s = e.sets[0];
  assert.deepEqual([e.measurement, e.loadMode, e.unilateral], ["bodyweight_reps", "none", false]);
  assert.throws(() => completeSet(w, e.id, s.id, at(1)), WorkoutError, "reps are needed");
  w = updateSet(w, e.id, s.id, { reps: 15 }); w = completeSet(w, e.id, s.id, at(1));
  assert.deepEqual([w.exercises[0].sets[0].reps, w.exercises[0].sets[0].weight, w.exercises[0].sets[0].completed], [15, null, true]);
});

test("previous performance: same exercise only, and left matches left, right matches right", () => {
  let last = addExercise(fresh(), ex(PUSHDOWN), { id: uid(), unit: "kg", setId: uid() }), id = last.exercises[0].id;
  last = updateSet(last, id, last.exercises[0].sets[0].id, { side: "left", weight: 12.5, reps: 12 });
  last = addSet(last, id, uid()); last = addSet(last, id, uid()); last = addSet(last, id, uid());
  last = updateSet(last, id, last.exercises[0].sets[1].id, { weight: 12.5, reps: 11 });
  for (const s of last.exercises[0].sets) last = completeSet(last, id, s.id, at(1));
  const hist = [{ ...fromWorkout({ ...last, status: "completed", endedAt: at(30) }) }];
  const prev = lastPerformance(hist, PUSHDOWN, "2026-12-01T00:00:00.000Z", "now");
  assert.ok(prev && prev.sets.length === 4);
  const now = [{ type: "working" as const, side: "left" as const }, { type: "working" as const, side: "right" as const }, { type: "working" as const, side: "left" as const }];
  const matched = previousPerSet(prev!.sets, now);
  assert.deepEqual(matched.map((m) => m?.side), ["left", "right", "left"]); assert.deepEqual(matched.map((m) => previousLabel(m, "total")), ["12.5×12", "12.5×11", "12.5×12"]);
  assert.equal(lastPerformance(hist, "triceps_pushdown", undefined, "now"), null, "the bar pushdown never borrows its history"); assert.equal(lastPerformance(hist, SCAP, undefined, "now"), null);
  // scapular raise: matched on its own key, shown as body weight
  let s = addExercise(fresh(), ex(SCAP), { id: uid(), unit: "kg", setId: uid() }); const sid = s.exercises[0].id;
  s = updateSet(s, sid, s.exercises[0].sets[0].id, { reps: 20 }); s = completeSet(s, sid, s.exercises[0].sets[0].id, at(1));
  const sp = lastPerformance([fromWorkout({ ...s, status: "completed", endedAt: at(9) })], SCAP, undefined, "now");
  assert.equal(previousLabel(previousPerSet(sp!.sets, [{ type: "working" }])[0], "none"), "BW×20");
});

test("history, saving and reordering work: the keys are saved, recovered after a reload, and survive a drag", async () => {
  let w = fresh();
  for (const k of ["barbell_bench_press", PUSHDOWN, SCAP]) { w = addExercise(w, ex(k), { id: uid(), unit: "kg", setId: uid() }); const e = w.exercises[w.exercises.length - 1]; w = updateSet(w, e.id, e.sets[0].id, { reps: 10, ...(k === SCAP ? {} : { weight: 20 }), ...(k === PUSHDOWN ? { side: "right" as const } : {}) }); w = completeSet(w, e.id, e.sets[0].id, at(1)); }
  const keys = (x: Workout) => [...x.exercises].sort((a, b) => a.position - b.position).map((e) => e.key);
  assert.deepEqual(keys(w), ["barbell_bench_press", PUSHDOWN, SCAP]);
  const rows = rowsOf(w).filter((r) => r.kind === "exercise").map((r) => (r.data as { exercise_key: string }).exercise_key);
  assert.deepEqual(rows, ["barbell_bench_press", PUSHDOWN, SCAP]); for (const k of rows) assert.match(k, /^[a-z0-9_]{2,60}$/);
  // dragging them around keeps everything: the same move the drag uses
  const dragged = moveExercise(moveExercise(w, w.exercises[2].id, 0), w.exercises[1].id, 2);
  assert.deepEqual(keys(dragged), [SCAP, "barbell_bench_press", PUSHDOWN]);
  const sig = (x: Workout) => JSON.stringify([...x.exercises].sort((a, b) => a.id.localeCompare(b.id)).map((e) => ({ ...e, position: 0 })));
  assert.equal(sig(dragged), sig(w), "sets, sides, reps, completion and timestamps are exactly as before");
  // autosave and recovery with the new exercises in the middle of a reorder
  const server = new FakeStrengthServer(), store = new MemoryStore(), t = transportFor(server);
  let engine = new SyncEngine(store, t, clock(), testOwner()); await engine.load(); await engine.record(dragged, { active: true });
  engine = new SyncEngine(store, t, clock(), testOwner()); await engine.load();
  const back = engine.local.workouts[engine.local.activeId!];
  assert.deepEqual(keys(back), [SCAP, "barbell_bench_press", PUSHDOWN]); assert.equal(sig(back), sig(dragged));
  assert.equal(back.exercises.find((e) => e.key === PUSHDOWN)!.sets[0].side, "right"); assert.equal(back.exercises.find((e) => e.key === PUSHDOWN)!.unilateral, true);
  await engine.flush(); assert.equal(server.live("exercise").length, 3);
});
