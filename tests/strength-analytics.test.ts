import test from "node:test";
import assert from "node:assert/strict";
import { E1RM_FORMULA, bestSet, compareWithPrevious, dashboard, durationSeconds, e1rm, exerciseHistory, muscleWeek, personalRecords, type HExercise, type HSession, type HSet } from "../lib/strength/analytics.ts";
import { catalogExercise } from "../lib/strength/library.ts";

const set = (weight: number | null, reps: number | null, o: Partial<HSet> = {}): HSet => ({ type: "working", weight, unit: "kg", reps, duration_s: null, distance_m: null, rpe: null, completed: true, ...o });
const exr = (key: string, sets: HSet[], loadMode: HExercise["loadMode"] = "total", name = key): HExercise => ({ key, name, loadMode, sets });
const sess = (id: string, startedAt: string, exercises: HExercise[], minutes = 60): HSession => ({ id, title: id, startedAt, endedAt: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(), pausedSeconds: 0, source: "apex", exercises });

test("e1RM: Epley, singles as-is, and no estimate above 10 reps", () => {
  assert.match(E1RM_FORMULA, /Epley/);
  assert.equal(e1rm(100, 1), 100);
  assert.equal(Math.round(e1rm(100, 5)! * 100) / 100, 116.67);
  assert.equal(Math.round(e1rm(80, 10)! * 100) / 100, 106.67);
  assert.equal(e1rm(60, 11), null, "high-rep sets are not extrapolated");
  assert.equal(e1rm(60, 0), null);
  assert.equal(e1rm(0, 5), null);
});

test("best set ignores warm-ups and incomplete sets; units are compared in kg", () => {
  const e = exr("barbell_bench_press", [set(140, 1, { type: "warmup" }), set(100, 5), set(225, 3, { unit: "lb" }), set(120, 5, { completed: false }), set(60, 20)]);
  const b = bestSet(e)!;
  // 140 x 1 is a warm-up and 120 x 5 was not completed; 225 lb x 3 (~112 kg e1RM) loses to 100 kg x 5 (~116.7 kg).
  assert.deepEqual([b.weight, b.unit, b.reps], [100, "kg", 5]);
  const lbOnly = bestSet(exr("barbell_bench_press", [set(225, 3, { unit: "lb" }), set(90, 3)]))!;
  assert.deepEqual([lbOnly.weight, lbOnly.unit], [225, "lb"], "225 lb is heavier than 90 kg once converted");
});

test("best set picks the highest estimate", () => {
  const e = exr("barbell_bench_press", [set(100, 5), set(225, 3, { unit: "lb" }), set(60, 20)]);
  const b = bestSet(e)!;
  assert.deepEqual([b.weight, b.unit, b.reps], [100, "kg", 5]);
  assert.equal(Math.round(b.e1rmKg! * 10) / 10, 116.7);
  const bw = bestSet(exr("push_up", [set(null, 20), set(null, 25)], "none"))!;
  assert.deepEqual([bw.reps, bw.e1rmKg], [25, null], "bodyweight best set is the most reps, with no 1RM estimate");
});

test("history, volume and progression per exercise", () => {
  const h = [
    sess("s1", "2026-10-01T08:00:00Z", [exr("back_squat", [set(100, 5), set(100, 5), set(60, 10, { type: "warmup" })])]),
    sess("s2", "2026-10-08T08:00:00Z", [exr("back_squat", [set(105, 5), set(105, 4)])]),
    sess("s3", "2026-10-15T08:00:00Z", [exr("leg_press", [set(200, 10)])]),
  ];
  const hist = exerciseHistory(h, { key: "back_squat" });
  assert.deepEqual(hist.map((x) => x.sessionId), ["s1", "s2"]);
  assert.equal(hist[0].volumeKg, 1000, "warm-ups are excluded from volume");
  assert.equal(hist[1].reps, 9);
  assert.equal(hist[1].maxWeightKg, 105);
  const db = exerciseHistory([sess("d", "2026-10-01T08:00:00Z", [exr("dumbbell_bench_press", [set(30, 10)], "per_hand")])], { key: "dumbbell_bench_press" });
  assert.equal(db[0].volumeKg, 600, "per hand x 2 dumbbells");
  assert.equal(db[0].maxWeightKg, 30, "the top weight stays per dumbbell, as entered");
});

test("personal records only against real earlier history; first time is a baseline", () => {
  const s1 = sess("s1", "2026-10-01T08:00:00Z", [exr("deadlift", [set(150, 5)])]);
  const s2 = sess("s2", "2026-10-08T08:00:00Z", [exr("deadlift", [set(160, 3), set(140, 8)]), exr("pull_up", [set(null, 12)], "none")]);
  const first = personalRecords(s1, [s1]);
  assert.deepEqual([first.prs.length, first.baselines], [0, ["deadlift"]]);
  const r = personalRecords(s2, [s1, s2]);
  const kinds = r.prs.map((p) => p.kind).sort();
  assert.deepEqual(kinds, ["e1rm", "volume", "weight"]);
  const w = r.prs.find((p) => p.kind === "weight")!;
  assert.deepEqual([w.value, w.previous], [160, 150]);
  assert.deepEqual(r.baselines, ["pull_up"]);
  const s3 = sess("s3", "2026-10-15T08:00:00Z", [exr("deadlift", [set(150, 5)])]);
  assert.equal(personalRecords(s3, [s1, s2, s3]).prs.length, 0, "matching an old best is not a record");
  const later = sess("s0", "2026-12-01T08:00:00Z", [exr("deadlift", [set(300, 1)])]);
  assert.equal(personalRecords(s2, [s1, s2, later]).prs.length, 3, "later sessions are not used as the baseline");
});

test("comparison with the previous session states measured changes only", () => {
  const s1 = sess("s1", "2026-10-01T08:00:00Z", [exr("back_squat", [set(100, 5)])]);
  const s2 = sess("s2", "2026-10-08T08:00:00Z", [exr("back_squat", [set(102.5, 5), set(102.5, 5)]), exr("leg_curl", [set(40, 12)])]);
  const c = compareWithPrevious(s2, [s1, s2], "UTC");
  assert.equal(c[0].previousDate, "2026-10-01");
  assert.match(c[0].change!, /100 kg × 5 → 102.5 kg × 5/);
  assert.match(c[0].change!, /working sets 1 → 2/);
  assert.equal(c[1].change, null, "no previous data: nothing is claimed");
});

test("muscle sets: direct and secondary are kept apart; unmatched exercises are not attributed", () => {
  const resolve = (k: string) => catalogExercise(k);
  const s = [
    sess("a", "2026-11-09T08:00:00Z", [exr("barbell_bench_press", [set(100, 5), set(100, 5), set(60, 10, { type: "warmup" })]), exr("unknown_thing", [set(10, 10)])]),
    sess("b", "2026-11-11T08:00:00Z", [exr("triceps_pushdown", [set(30, 12)])]),
    sess("old", "2026-11-01T08:00:00Z", [exr("barbell_bench_press", [set(100, 5)])]),
  ];
  const wk = muscleWeek(s, resolve, "2026-11-09", "UTC");
  assert.deepEqual(wk.chest, { direct: 2, secondary: 0, sessions: 1 });
  assert.deepEqual(wk.triceps, { direct: 1, secondary: 2, sessions: 1 });
  assert.equal(wk.shoulders.secondary, 2);
});

test("dashboard: frequency, consistency, durations and trends without a combined load score", () => {
  const s = [
    sess("a", "2026-11-09T08:00:00Z", [exr("back_squat", [set(100, 5), set(100, 5)])], 50),
    sess("b", "2026-11-11T08:00:00Z", [exr("back_squat", [set(100, 5)])], 70),
    sess("c", "2026-10-01T08:00:00Z", [exr("back_squat", [set(90, 5)])], 60),
    sess("d", "2025-05-01T08:00:00Z", [exr("back_squat", [set(80, 5)])], 60),
  ];
  const d = dashboard(s, "2026-11-12", "UTC");
  assert.equal(d.totalWorkouts, 4);
  assert.equal(d.last30, 2);
  assert.equal(d.thisWeekSets, 3);
  assert.equal(d.avgDurationMin, 60);
  assert.deepEqual(d.consistency12, { weeksTrained: 2, weeks: 12 });
  assert.deepEqual(d.yearly.map((y) => [y.key, y.workouts]), [["2025", 1], ["2026", 3]]);
  assert.ok(!("load" in d) && !("tonnage" in d));
  assert.equal(durationSeconds({ startedAt: "2026-11-09T08:00:00Z", endedAt: null, pausedSeconds: 0 }), null);
});
