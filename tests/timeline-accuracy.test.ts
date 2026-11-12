// P1.2: the Timeline counts and times a strength workout exactly like Strength and Today do. Uses the synthetic gym workout of the lifecycle
// test (bench: warm-up 40x10 then working 60x8, 60x8, 60x6; cable row 3x30x12; 40 min on the clock, 10 min paused). Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addExercise, addSet, completeSet, finish, pause, resume, startWorkout, updateSet, type Workout } from "../lib/strength/workout.ts";
import { durationSeconds, fromWorkout, workingExercises, workingSetCount } from "../lib/strength/analytics.ts";
import { displayDurationS, interval, mergedView, trainingItems, type ActivitySource, type Link, type StrengthSource } from "../lib/strength/dedup.ts";
import { strengthSources, type Db } from "../lib/strength/data.ts";
import { strengthSummary } from "../lib/today/model.ts";
import { T0, at, ex, uid } from "./strength-fixtures.ts";

function syntheticWorkout(): Workout {
  let w = startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "kg" });
  w = addExercise(w, ex("barbell_bench_press"), { id: uid(), unit: "kg", setId: uid() });
  w = addExercise(w, ex("seated_cable_row"), { id: uid(), unit: "kg", setId: uid() });
  const [b, r] = w.exercises;
  w = addSet(w, b.id, uid(), { type: "warmup" });
  const warm = w.exercises[0].sets[1];
  w = updateSet(w, b.id, b.sets[0].id, { weight: 60, reps: 8 });
  w = updateSet(w, b.id, warm.id, { weight: 40, reps: 10, type: "warmup" });
  const s2 = uid(), s3 = uid(); w = addSet(w, b.id, s2, { type: "working" }); w = addSet(w, b.id, s3, { type: "working" });
  w = updateSet(w, b.id, s2, { weight: 60, reps: 8 }); w = updateSet(w, b.id, s3, { weight: 60, reps: 6 });
  for (const s of w.exercises[0].sets) w = completeSet(w, b.id, s.id, at(5));
  w = updateSet(w, r.id, r.sets[0].id, { weight: 30, reps: 12 });
  const r2 = uid(), r3 = uid(); w = addSet(w, r.id, r2); w = addSet(w, r.id, r3);
  for (const s of w.exercises[1].sets) w = completeSet(w, r.id, s.id, at(9));
  w = pause(w, at(20)); w = resume(w, at(30));
  return finish(w, at(40), { discardIncomplete: true });
}

type Row = Record<string, unknown>;
/** The workout as the database returns it for the Timeline query, plus optional extra exercises / sets that older or imported data can hold. */
function rowOf(w: Workout, extra: { exercises?: Row[]; sets?: Row[]; deletedSet?: boolean; noPause?: boolean } = {}): Row {
  const exs: Row[] = w.exercises.map((e) => ({ exercise_name: e.name, deleted_at: null, strength_sets: e.sets.map((s) => ({ id: s.id, set_type: s.type, completed: s.completed, deleted_at: null })) }));
  if (extra.sets) (exs[0].strength_sets as Row[]).push(...extra.sets);
  if (extra.deletedSet) (exs[1].strength_sets as Row[]).push({ id: uid(), set_type: "working", completed: true, deleted_at: "2026-11-10T10:00:00Z" });
  exs.push(...(extra.exercises ?? []));
  return { id: w.id, started_at: w.startedAt, ended_at: w.endedAt, paused_seconds: extra.noPause ? 0 : w.pausedSeconds, title: "TEST - APEX gym smoke", source: "apex", status: "completed", strength_session_exercises: exs };
}
function fakeDb(rows: Row[]): Db {
  return { rpc() { return null; }, from() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = { select() { return b; }, is() { return b; }, eq() { return b; }, gte() { return b; }, order() { return b; }, range(from: number, to: number) { return Promise.resolve({ data: rows.slice(from, to + 1), error: null }); } };
    return b;
  } };
}
const messy = (w: Workout) => rowOf(w, {
  deletedSet: true,
  sets: [{ id: uid(), set_type: "working", completed: false, deleted_at: null }],                                                             // an unfinished set in bench
  exercises: [
    { exercise_name: "Face pull", deleted_at: null, strength_sets: [{ id: uid(), set_type: "warmup", completed: true, deleted_at: null }] },      // only a warm-up
    { exercise_name: "Curl", deleted_at: null, strength_sets: [{ id: uid(), set_type: "working", completed: false, deleted_at: null }] },          // only an unfinished set
    { exercise_name: "Removed", deleted_at: "2026-11-10T10:00:00Z", strength_sets: [{ id: uid(), set_type: "working", completed: true, deleted_at: null }] },
  ],
});

test("the synthetic workout: Strength's own numbers (6 working sets, 2 exercises, 30 min worked)", () => {
  const w = syntheticWorkout(), h = fromWorkout(w);
  assert.deepEqual([workingSetCount(h), workingExercises(h).length, durationSeconds(h), w.pausedSeconds], [6, 2, 30 * 60, 600]);
});

test("Timeline source: warm-ups, unfinished sets, deleted sets and exercises with no working set are not counted", async () => {
  const w = syntheticWorkout();
  const [s] = await strengthSources(fakeDb([messy(w)]), "2026-01-01T00:00:00Z");
  assert.deepEqual([s.exercises, s.sets, s.pausedS], [2, 6, 600]);
  assert.equal(s.exerciseNames.length, 2, "only working exercises are named");
  assert.ok(!s.exerciseNames.some((n) => ["Face pull", "Curl", "Removed"].includes(n)));
  // (before this change the same rows counted 4 exercises and 9 sets: warm-ups and unfinished sets were included)
  const clean = (await strengthSources(fakeDb([rowOf(w)]), "2026-01-01T00:00:00Z"))[0];
  assert.deepEqual([clean.exercises, clean.sets], [2, 6], "a normal finished workout is counted the same with or without the extra rows");
});

test("Timeline item agrees with Strength and Today: same sets, same exercises, same active duration (pause subtracted)", async () => {
  const w = syntheticWorkout(), h = fromWorkout(w);
  const [s] = await strengthSources(fakeDb([messy(w)]), "2026-01-01T00:00:00Z");
  const [item] = trainingItems([s], []);
  assert.equal(item.detail, "2 exercises, 6 sets");
  assert.equal(item.durationS, durationSeconds(h)); assert.equal(item.durationS, 30 * 60, "40 min on the clock minus 10 min paused");
  // Today
  const today = strengthSummary([{ id: w.id, title: w.title, startedAt: w.startedAt, endedAt: w.endedAt, pausedSeconds: w.pausedSeconds, sets: workingSetCount(h), exercises: workingExercises(h).length }], "2026-11-12", "UTC");
  assert.equal(today.last?.durationS, item.durationS, "Today and the Timeline show the same duration");
  assert.equal(today.last?.sets, s.sets); assert.equal(today.last?.exercises, s.exercises);
  assert.equal(displayDurationS(s), item.durationS);
});

test("an unpaused workout, and older sources without pausedS, keep the wall-clock duration", async () => {
  const w = syntheticWorkout();
  const [s] = await strengthSources(fakeDb([rowOf(w, { noPause: true })]), "2026-01-01T00:00:00Z");
  assert.equal(s.pausedS, 0); assert.equal(trainingItems([s], [])[0].durationS, 40 * 60);
  const legacy: StrengthSource = { kind: "strength", id: "s1", startedAt: T0, endedAt: at(45), title: "Old", source: "hevy_csv", exercises: 3, sets: 9, exerciseNames: [] };   // no pausedS
  assert.equal(trainingItems([legacy], [])[0].durationS, 45 * 60);
  assert.equal(displayDurationS({ ...legacy, endedAt: null }), null, "no end time: no duration, never invented");
});

test("overlap matching still uses the wall clock; a merge keeps the activity's duration, or the strength log's active time when it is primary", async () => {
  const w = syntheticWorkout();
  const [s] = await strengthSources(fakeDb([rowOf(w)]), "2026-01-01T00:00:00Z");
  const i = interval(s); assert.equal(Math.round(((i.end ?? 0) - i.start) / 1000), 40 * 60, "interval() is unchanged (wall clock)");
  const act: ActivitySource = { kind: "activity", id: 7, startedAt: at(-2), durationS: 44 * 60, elapsedS: null, sport: "strength", title: "Strength", origin: "GARMIN_CONNECT", device: "Forerunner 965", avgHr: 112, maxHr: 158, calories: 420, load: 45 };
  const links: Link[] = [{ trainingSessionId: "t1", activityId: 7, strengthSessionId: null, role: "primary" }, { trainingSessionId: "t1", activityId: null, strengthSessionId: s.id, role: "secondary" }];
  const merged = trainingItems([act, s], links);
  assert.equal(merged.length, 1); assert.equal(merged[0].durationS, 44 * 60, "the Garmin activity is primary: its own duration");
  assert.equal(merged[0].detail.startsWith("2 exercises, 6 sets"), true, "the strength log still supplies the working counts");
  const asStrengthPrimary = trainingItems([act, s], [{ ...links[0], role: "secondary" }, { ...links[1], role: "primary" }]);
  assert.equal(asStrengthPrimary[0].durationS, 30 * 60);
  const v = mergedView(act, s, s);
  assert.equal(v.durationS.value, 30 * 60); assert.equal(v.sets?.value, 6);
  assert.deepEqual(v.exercises?.value.length, 2);
});

test("wiring: Strength, Today and the Timeline source all use the shared helpers; the extra columns are selected", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const data = read("lib/strength/data.ts");
  assert.match(data, /strength_sessions"\)\.select\("id,started_at,ended_at,paused_seconds,/); assert.match(data, /strength_sets\(id,set_type,completed,deleted_at\)/);
  assert.match(data, /workingExercises\(\{ exercises: exs \}\)/); assert.match(data, /workingSetCount\(\{ exercises: exs \}\)/);
  assert.match(read("lib/today/load.ts"), /sets: workingSetCount\(s\), exercises: workingExercises\(s\)\.length/);
  const page = read("app/(app)/strength/page.tsx");
  assert.ok(page.includes("{workingExercises(s).length} exercises") && page.includes("{workingSetCount(s)} working sets"));
  assert.match(read("lib/strength/dedup.ts"), /durationSeconds\(\{ startedAt: s\.startedAt, endedAt: s\.endedAt, pausedSeconds: s\.pausedS \?\? 0 \}\)/);
});
