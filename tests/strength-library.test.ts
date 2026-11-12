import test from "node:test";
import assert from "node:assert/strict";
import { CATALOG, EMPTY_CUSTOM, MODES_FOR, catalogExercise, exerciseFromCustom, normalizeName, resolveExercise, searchExercises, substitutesFor, validateCustom } from "../lib/strength/library.ts";
import { CATEGORIES, EQUIPMENT, FIT_CATEGORY, MEASUREMENTS, MUSCLES, PATTERNS, customKey } from "../lib/strength/types.ts";

test("catalog: at least 150 exercises with unique keys and unique names", () => {
  assert.ok(CATALOG.length >= 150, `only ${CATALOG.length} exercises`);
  assert.equal(new Set(CATALOG.map((e) => e.key)).size, CATALOG.length, "duplicate key");
  assert.equal(new Set(CATALOG.map((e) => normalizeName(e.name))).size, CATALOG.length, "duplicate name");
});

test("catalog: every exercise has complete, valid metadata", () => {
  for (const e of CATALOG) {
    const where = e.key;
    assert.match(e.key, /^[a-z0-9_]{2,60}$/, where);
    assert.ok(e.primary.length >= 1 && e.primary.every((m) => MUSCLES.includes(m)), `${where}: primary muscles`);
    assert.ok(e.secondary.every((m) => MUSCLES.includes(m)), `${where}: secondary muscles`);
    assert.ok(!e.secondary.some((m) => e.primary.includes(m)), `${where}: a muscle is both primary and secondary`);
    assert.ok(EQUIPMENT.includes(e.equipment) && PATTERNS.includes(e.pattern) && CATEGORIES.includes(e.category) && MEASUREMENTS.includes(e.measurement), where);
    assert.ok(MODES_FOR[e.measurement].includes(e.loadMode), `${where}: load mode ${e.loadMode} does not fit ${e.measurement}`);
    assert.ok(e.instructions.length >= 2, `${where}: instructions`);
    assert.ok(e.cues.length >= 1, `${where}: cues`);
    assert.ok(e.mistakes.length >= 1, `${where}: common mistakes`);
    assert.ok(e.rest >= 30 && e.rest <= 300, `${where}: rest`);
    assert.ok(e.fit in FIT_CATEGORY, `${where}: FIT category`);
    assert.equal(e.media, null, `${where}: no third-party media is bundled`);
  }
});

test("catalog: covers every required muscle group and equipment type", () => {
  for (const m of MUSCLES) assert.ok(CATALOG.some((e) => e.primary.includes(m)), `no exercise for ${m}`);
  for (const q of EQUIPMENT) assert.ok(CATALOG.some((e) => e.equipment === q), `no exercise for ${q}`);
});

test("catalog: dumbbell pairs are logged per hand; single implements and bodyweight are not", () => {
  assert.equal(catalogExercise("dumbbell_bench_press")!.loadMode, "per_hand");
  assert.equal(catalogExercise("goblet_squat")!.loadMode, "total");
  assert.equal(catalogExercise("dumbbell_row")!.loadMode, "total");
  assert.equal(catalogExercise("dumbbell_row")!.unilateral, true);
  assert.equal(catalogExercise("push_up")!.loadMode, "none");
  assert.equal(catalogExercise("weighted_pull_up")!.loadMode, "added");
  assert.equal(catalogExercise("assisted_pull_up")!.loadMode, "assisted");
  assert.equal(catalogExercise("plank")!.measurement, "duration");
  assert.equal(catalogExercise("rowing_machine")!.measurement, "distance_duration");
});

test("search: names, abbreviations and aliases", () => {
  assert.equal(searchExercises(CATALOG, { query: "bench press" })[0].key, "barbell_bench_press");
  assert.equal(searchExercises(CATALOG, { query: "db bench" })[0].key, "dumbbell_bench_press");
  assert.equal(searchExercises(CATALOG, { query: "rdl" })[0].key, "romanian_deadlift");
  assert.equal(searchExercises(CATALOG, { query: "OHP" })[0].key, "overhead_press");
  assert.equal(searchExercises(CATALOG, { query: "Farmers walk" })[0].key, "farmer_carry");
  assert.equal(searchExercises(CATALOG, { query: "zzzz nothing" }).length, 0);
  assert.equal(searchExercises(CATALOG, {}).length, CATALOG.length, "an empty query lists everything");
  assert.ok(searchExercises(CATALOG, { query: "curl" }).every((e) => /curl/i.test(e.name) || e.aliases.some((a) => /curl/i.test(a))));
});

test("filters: muscle, equipment, pattern, category, and secondary involvement", () => {
  const chestDb = searchExercises(CATALOG, { muscle: "chest", equipment: "dumbbell" });
  assert.ok(chestDb.length >= 4);
  assert.ok(chestDb.every((e) => e.primary.includes("chest") && e.equipment === "dumbbell"));
  const hinge = searchExercises(CATALOG, { pattern: "hinge", category: "compound" });
  assert.ok(hinge.some((e) => e.key === "deadlift") && hinge.every((e) => e.pattern === "hinge" && e.category === "compound"));
  const tricepsPrimary = searchExercises(CATALOG, { muscle: "triceps" }).length;
  const tricepsAny = searchExercises(CATALOG, { muscle: "triceps", includeSecondary: true }).length;
  assert.ok(tricepsAny > tricepsPrimary, "secondary involvement widens the result");
  const combined = searchExercises(CATALOG, { query: "press", muscle: "shoulders", equipment: "machine" });
  assert.deepEqual(combined.map((e) => e.key), ["machine_shoulder_press"]);
});

test("custom exercises: validation, catalog clash, and conversion", () => {
  const ok = validateCustom({ ...EMPTY_CUSTOM, name: "  Cable Y-Raise  ", primary: ["shoulders"], secondary: ["upper_back", "shoulders"], equipment: "cable", measurement: "weight_reps", loadMode: "total", aliases: "y raise, , y-raise" }, CATALOG);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.row.name, "Cable Y-Raise");
    assert.deepEqual(ok.row.secondary_muscles, ["upper_back"], "a primary muscle is never repeated as secondary");
    assert.deepEqual(ok.row.aliases, ["y raise", "y-raise"]);
    const ex = exerciseFromCustom({ ...ok.row, id: "11111111-1111-4111-8111-111111111111", archived_at: null });
    assert.equal(ex.key, customKey("11111111-1111-4111-8111-111111111111"));
    assert.equal(ex.custom, true);
    assert.equal(resolveExercise(ex.key, [ex])?.name, "Cable Y-Raise");
    assert.equal(resolveExercise("custom:22222222-2222-4222-8222-222222222222", [ex]), null, "another custom id is not guessed");
  }
  const clash = validateCustom({ ...EMPTY_CUSTOM, name: "bench press (barbell)", primary: ["chest"] }, CATALOG);
  assert.equal(clash.ok, false);
  if (!clash.ok) assert.match(clash.error, /already in the library/);
  assert.equal(validateCustom({ ...EMPTY_CUSTOM, name: "X", primary: [] }, CATALOG).ok, false);
  assert.equal(validateCustom({ ...EMPTY_CUSTOM, name: "X", primary: ["neck" as never] }, CATALOG).ok, false);
  assert.equal(validateCustom({ ...EMPTY_CUSTOM, name: "X", primary: ["chest"], measurement: "duration", loadMode: "per_hand" }, CATALOG).ok, false, "a timed exercise cannot be per hand");
  assert.equal(validateCustom({ ...EMPTY_CUSTOM, name: "X", primary: ["chest"], equipment: "spaceship" }, CATALOG).ok, false);
  assert.equal(resolveExercise("not_a_real_exercise", []), null);
});

test("substitutes: same muscles first, and differences are stated honestly", () => {
  const bench = catalogExercise("barbell_bench_press")!;
  const subs = substitutesFor(bench, CATALOG);
  assert.ok(subs.length > 0);
  assert.ok(subs.every((s) => s.exercise.primary.includes("chest")));
  assert.ok(subs[0].samePattern, "same movement pattern ranks first");
  assert.ok(subs.every((s) => /^(Not identical|Closest match)/.test(s.note)), "never claims a substitute is identical");
  const db = substitutesFor(bench, CATALOG, ["dumbbell"]);
  assert.ok(db.length > 0 && db.every((s) => s.exercise.equipment === "dumbbell"));
  assert.ok(db.every((s) => /dumbbells/.test(s.note)), "an equipment change is called out");
  const fly = substitutesFor(bench, CATALOG).find((s) => s.exercise.pattern !== "horizontal_push");
  if (fly) assert.match(fly.note, /different movement pattern/);
});
