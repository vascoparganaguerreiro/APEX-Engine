import test from "node:test";
import assert from "node:assert/strict";
import { ImportError, buildPayload, buildPreview, detectFormat, matchExercise, parseCsv, parseHevy, parseHevyDate, zonedToUtc } from "../lib/strength/hevy.ts";
import { CATALOG } from "../lib/strength/library.ts";

const HEADER = "title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe";
const CSV = [
  HEADER,
  `"Push Day","26 Mar 2024, 07:43","26 Mar 2024, 08:51","Felt good","Bench Press (Barbell)",,"Pause on chest",0,warmup,40,10,,,`,
  `"Push Day","26 Mar 2024, 07:43","26 Mar 2024, 08:51","Felt good","Bench Press (Barbell)",,"Pause on chest",1,normal,80,8,,,8`,
  `"Push Day","26 Mar 2024, 07:43","26 Mar 2024, 08:51","Felt good","Bench Press (Barbell)",,"Pause on chest",2,failure,80,6,,,10`,
  `"Push Day","26 Mar 2024, 07:43","26 Mar 2024, 08:51","Felt good","Bicep Curl (Dumbbell)",0,,0,normal,14,12,,,`,
  `"Push Day","26 Mar 2024, 07:43","26 Mar 2024, 08:51","Felt good","Plank",,,0,normal,,,,60,`,
  `"Push Day","26 Mar 2024, 07:43","26 Mar 2024, 08:51","Felt good","Some Weird Machine, ""Pro""",,,0,dropset,30,10,,,`,
  `"Legs","28 Mar 2024, 18:00","28 Mar 2024, 19:05",,"Squat (Barbell)",,,0,normal,100,5,,,`,
  `"Legs","28 Mar 2024, 18:00","28 Mar 2024, 19:05",,"Squat (Barbell)",,,1,normal,abc,5,,,`,
  `"Legs","not a date","28 Mar 2024, 19:05",,"Squat (Barbell)",,,0,normal,100,5,,,`,
].join("\r\n");

test("CSV parser: quotes, escaped quotes, commas inside fields, CRLF and BOM", () => {
  const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""",3\n\n4,5,6');
  assert.deepEqual(rows, [["a", "b", "c"], ["x, y", 'say "hi"', "3"], ["4", "5", "6"]]);
  assert.throws(() => parseCsv('a,"unterminated'), ImportError);
  assert.throws(() => parseCsv("a\nb\nc\nd", 2), /more than 2 rows/);
});

test("format detection: Hevy columns, units, and helpful errors for other files", () => {
  const ok = detectFormat(HEADER.split(","));
  assert.ok(ok.ok);
  if (ok.ok) { assert.equal(ok.format.weightUnit, "kg"); assert.equal(ok.format.distanceUnit, "km"); assert.ok(ok.format.has.rpe && ok.format.has.endTime); }
  const lb = detectFormat(["title", "start_time", "exercise_title", "set_index", "weight_lbs", "reps", "distance_miles"]);
  assert.ok(lb.ok && lb.format.weightUnit === "lb" && lb.format.distanceUnit === "mi");
  const strong = detectFormat(["Date", "Workout Name", "Exercise Name", "Set Order", "Weight", "Reps"]);
  assert.ok(!strong.ok && /Strong/.test(strong.error));
  const other = detectFormat(["foo", "bar"]);
  assert.ok(!other.ok && /missing: title, start_time, exercise_title/.test(other.error));
});

test("dates: Hevy local times are converted with the user's time zone, DST-aware; unknown formats are rejected", () => {
  assert.equal(parseHevyDate("26 Mar 2024, 07:43", "Europe/Lisbon"), "2024-03-26T07:43:00.000Z", "before the 31 March 2024 change Lisbon is UTC+0");
  assert.equal(parseHevyDate("15 Apr 2024, 07:43", "Europe/Lisbon"), "2024-04-15T06:43:00.000Z", "summer time: UTC+1");
  assert.equal(parseHevyDate("10 Jan 2024, 07:43", "Europe/Lisbon"), "2024-01-10T07:43:00.000Z");
  assert.equal(parseHevyDate("Mar 26, 2024, 7:43 PM", "UTC"), "2024-03-26T19:43:00.000Z");
  assert.equal(parseHevyDate("2024-03-26 07:43:00", "America/New_York"), "2024-03-26T11:43:00.000Z");
  assert.equal(parseHevyDate("2024-03-26T07:43:00Z", "Asia/Tokyo"), "2024-03-26T07:43:00.000Z", "an explicit zone wins");
  assert.equal(parseHevyDate("31 Feb 2024, 07:43", "UTC"), null);
  assert.equal(parseHevyDate("yesterday", "UTC"), null);
  // 01:30 happens twice in Lisbon on 27 Oct 2024; the second (standard-time) occurrence is always chosen.
  assert.equal(zonedToUtc(2024, 10, 27, 1, 30, 0, "Europe/Lisbon"), "2024-10-27T01:30:00.000Z", "ambiguous DST hour resolves deterministically");
});

test("exercise matching: exact, alias and word-order matches only; anything else is left to the user", () => {
  assert.equal(matchExercise("Bench Press (Barbell)").exercise?.key, "barbell_bench_press");
  assert.equal(matchExercise("Bicep Curl (Dumbbell)").exercise?.key, "dumbbell_curl", "bicep/biceps plural handled by word matching");
  assert.equal(matchExercise("OHP").how, "alias");
  assert.equal(matchExercise("ohp").exercise?.key, "overhead_press");
  assert.equal(matchExercise("lat pulldown").exercise, null, "a partial name is not guessed");
  assert.equal(matchExercise("Some Weird Machine").exercise, null);
  assert.equal(matchExercise("Press").exercise, null, "ambiguous names are not guessed");
});

test("parsing: workouts, exercises, set types, units and per-row issues", () => {
  const p = parseHevy(CSV, "Europe/Lisbon");
  assert.equal(p.workouts.length, 2);
  const push = p.workouts[0];
  assert.deepEqual([push.title, push.startedAt, push.endedAt, push.notes], ["Push Day", "2024-03-26T07:43:00.000Z", "2024-03-26T08:51:00.000Z", "Felt good"]);
  assert.deepEqual(push.exercises.map((e) => e.name), ["Bench Press (Barbell)", "Bicep Curl (Dumbbell)", "Plank", 'Some Weird Machine, "Pro"']);
  assert.deepEqual(push.exercises[0].sets.map((s) => [s.type, s.weight, s.reps, s.rpe]), [["warmup", 40, 10, null], ["working", 80, 8, 8], ["failure", 80, 6, 10]]);
  assert.equal(push.exercises[0].notes, "Pause on chest");
  assert.equal(push.exercises[1].superset, 1);
  assert.deepEqual([push.exercises[2].sets[0].duration_s, push.exercises[2].sets[0].weight], [60, null], "bodyweight/timed rows keep empty weights empty");
  assert.equal(push.exercises[3].sets[0].type, "drop");
  assert.equal(p.workouts[1].exercises[0].sets.length, 1, "the row with an unreadable weight was skipped, not guessed");
  assert.ok(p.issues.some((i) => i.line === 9 && /could not be read/.test(i.message)));
  assert.ok(p.issues.some((i) => i.line === 10 && /Unrecognised date/.test(i.message)));
  assert.throws(() => parseHevy("title,start_time\n", "UTC"), /no workout rows|missing/);
});

test("preview: already imported, overlapping APEX logs, and what the file does not contain", () => {
  const p = parseHevy(CSV, "Europe/Lisbon");
  const existing = [
    { id: "1", source: "hevy_csv", sourceRef: p.workouts[0].ref, startedAt: p.workouts[0].startedAt, endedAt: null, title: "Push Day" },
    { id: "2", source: "apex", sourceRef: null, startedAt: "2024-03-28T18:10:00.000Z", endedAt: "2024-03-28T19:00:00.000Z", title: "Leg day (APEX)" },
  ];
  const pv = buildPreview(p, existing, CATALOG);
  assert.deepEqual(pv.workouts.map((w) => [w.status, w.include]), [["already_imported", false], ["overlaps_apex", false]]);
  assert.equal(pv.workouts[1].overlapWith, "Leg day (APEX)");
  assert.deepEqual(pv.counts, { new: 0, already: 1, overlaps: 1 });
  assert.equal(pv.weightUnit, "kg");
  const unmatched = pv.names.filter((n) => !n.exercise).map((n) => n.importedName);
  assert.deepEqual(unmatched, ['Some Weird Machine, "Pro"']);
  const bare = parseHevy("title,start_time,exercise_title,set_index,reps\nA,26 Mar 2024 07:00,Push-Up,0,10", "UTC");
  assert.deepEqual(buildPreview(bare, [], CATALOG).missing, ["end times (durations will be unknown)", "RPE", "weights"]);
});

test("payload: only confirmed workouts, mapped keys, dumbbell convention chosen by the user, chunked; repeat imports are no-ops", () => {
  const p = parseHevy(CSV, "Europe/Lisbon");
  const pv = buildPreview(p, [], CATALOG);
  assert.deepEqual(pv.workouts.map((w) => w.include), [true, true]);
  pv.workouts[1].include = false;
  const map = Object.fromEntries(pv.names.map((n) => [n.importedName, n.exercise?.key ?? null]));
  const chunks = buildPayload(pv, map, CATALOG, { dumbbellWeights: "per_hand" }, 1);
  assert.equal(chunks.length, 1);
  const s = chunks[0][0] as { source_ref: string; exercises: Array<Record<string, unknown>> };
  assert.equal(s.source_ref, "hevy|26 Mar 2024, 07:43|Push Day", "stable fingerprint from the file itself, independent of time zone");
  assert.equal(s.exercises[0].exercise_key, "barbell_bench_press");
  assert.equal(s.exercises[1].load_mode, "per_hand");
  assert.equal(s.exercises[3].exercise_key, null, "an unmapped exercise keeps its imported name");
  assert.equal(s.exercises[3].exercise_name, 'Some Weird Machine, "Pro"');
  const combined = buildPayload(pv, map, CATALOG, { dumbbellWeights: "combined" })[0][0] as { exercises: Array<Record<string, unknown>> };
  assert.equal(combined.exercises[1].load_mode, "total");
  // second import of the same file: the first workout is now known
  const again = buildPreview(p, [{ id: "x", source: "hevy_csv", sourceRef: s.source_ref, startedAt: "", endedAt: null, title: "" }], CATALOG);
  assert.equal(buildPayload(again, map, CATALOG, { dumbbellWeights: "per_hand" }).flat().length, 1, "only the not-yet-imported workout remains");
});
