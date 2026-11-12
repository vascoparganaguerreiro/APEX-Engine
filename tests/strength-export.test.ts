import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS, ExportUnavailable, FIT_ADAPTER, GARMIN_CONNECT_ADAPTER, ICS_ADAPTER, JSON_ADAPTER } from "../lib/strength/garmin/adapters.ts";
import { DURATION_TYPE, FIT_EPOCH_S, TARGET_TYPE, decodeFit, encodeWorkoutFit, fitCrc } from "../lib/strength/garmin/fit.ts";
import { buildIcs, fold } from "../lib/strength/garmin/ics.ts";
import { describe, intervalWorkout, routineToStructured, validateStructured, type StructuredWorkout } from "../lib/strength/garmin/structured.ts";
import { TEMPLATES, duplicateRoutine, emptyRoutine, fromTemplate, moveRoutineExercise, routineFromRow, routinePayload, set, toPlan, validateRoutine } from "../lib/strength/routines.ts";
import { mapActivityExtras } from "../lib/intervals.ts";
import { uid } from "./strength-fixtures.ts";

const NOW = new Date("2026-11-12T10:00:00Z");

test("routine templates: every required template exists, validates, and has no invented weights", () => {
  for (const k of ["push", "pull", "legs", "upper", "lower", "full_body"]) {
    const r = fromTemplate(k, uid());
    assert.equal(validateRoutine(r, []), null, k);
    assert.ok(r.exercises.length >= 4);
    assert.ok(r.exercises.every((e) => e.sets.every((s) => s.weight === null)), `${k}: no weights`);
    assert.equal(toPlan(r, []).skipped.length, 0);
  }
  assert.ok(Object.keys(TEMPLATES).length >= 6);
});

test("routine editing: duplicate, reorder, validation, and a save/load round trip", () => {
  const r = fromTemplate("push", uid());
  const copy = duplicateRoutine(r, uid());
  assert.notEqual(copy.id, r.id);
  assert.match(copy.name, /copy/);
  copy.exercises[0].sets[0].repsMin = 99;
  assert.notEqual(r.exercises[0].sets[0].repsMin, 99, "a duplicate is a deep copy");
  const moved = moveRoutineExercise(r, 0, 2);
  assert.equal(moved.exercises[2].key, "barbell_bench_press");
  const bad = { ...emptyRoutine(uid()), exercises: [{ key: "squat_that_does_not_exist", superset: null, rest: null, loadMode: null, unit: "kg" as const, notes: null, substitutes: [], sets: [] }] };
  assert.match(validateRoutine(bad, [])!, /no longer exists/);
  const rev = { ...r, exercises: [{ ...r.exercises[0], sets: [set(12, 8)] }] };
  assert.match(validateRoutine(rev, [])!, /reversed/);
  assert.match(validateRoutine({ ...r, name: " " }, [])!, /name/);
  const payload = routinePayload(r) as { exercises: Array<{ position: number; sets: unknown[]; exercise_key: string }> };
  assert.deepEqual(payload.exercises.map((e) => e.position), r.exercises.map((_, i) => i));
  const row = { id: r.id, name: r.name, notes: null, template_key: "push", strength_routine_exercises: payload.exercises.map((e: Record<string, unknown>) => ({ ...e, strength_routine_sets: e.sets })).reverse() };
  const back = routineFromRow(row);
  assert.deepEqual(back.exercises.map((e) => e.key), r.exercises.map((e) => e.key), "order restored from positions");
  assert.deepEqual(back.exercises[0].sets, r.exercises[0].sets);
});

test("FIT CRC matches the published CRC-16/ARC check value", () => {
  assert.equal(fitCrc(new TextEncoder().encode("123456789")), 0xbb3d);
});

test("FIT: strength routine encodes to a valid workout file and decodes back", () => {
  const r = fromTemplate("push", uid());
  r.exercises[0].sets[1].weight = 80;
  const w = routineToStructured(r, []);
  assert.equal(validateStructured(w), null);
  const bytes = encodeWorkoutFit(w, NOW);
  const d = decodeFit(bytes);
  assert.ok(d.headerCrcOk && d.fileCrcOk);
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), ".FIT");
  const fileId = d.messages.find((m) => m.global === 0)!;
  assert.deepEqual([fileId.fields[0], fileId.fields[1], fileId.fields[4]], [5, 255, Math.floor(NOW.getTime() / 1000) - FIT_EPOCH_S], "workout file, development manufacturer");
  const wkt = d.messages.find((m) => m.global === 26)!;
  assert.deepEqual([wkt.fields[4], wkt.fields[11], wkt.fields[8]], [10, 20, "Push"], "training / strength_training");
  const steps = d.messages.filter((m) => m.global === 27);
  assert.equal(wkt.fields[6], steps.length);
  assert.deepEqual(steps.map((s) => s.fields[254]), steps.map((_, i) => i));
  const first = steps[0];
  assert.deepEqual([first.fields[0], first.fields[1], first.fields[2], first.fields[7], first.fields[10]], ["Bench Press (Barbell)", DURATION_TYPE.reps, 8, 2, 0], "warm-up of 8 reps, bench_press category");
  const heavy = steps.find((s) => s.fields[12] === 8000);
  assert.ok(heavy, "80 kg target stored as 8000 (scale 100)");
  assert.equal(heavy!.fields[13], 1, "kilograms");
  const rest = steps.find((s) => s.fields[0] === "Rest")!;
  assert.deepEqual([rest.fields[1], rest.fields[2], rest.fields[7]], [DURATION_TYPE.time, 180_000, 1]);
  const db = fromTemplate("full_body", uid());
  db.exercises[1].sets[0].weight = 30;
  const dbSteps = decodeFit(encodeWorkoutFit(routineToStructured(db, []), NOW)).messages.filter((m) => m.global === 27);
  const dbStep = dbSteps.find((s) => s.fields[0] === "Bench Press (Dumbbell)")!;
  assert.equal(dbStep.fields[12], 0xffff, "per-hand dumbbell weight is not written as if it were a total");
  assert.match(String(dbStep.fields[8]), /30 kg per hand/);
});

test("FIT: endurance intervals with heart-rate and pace targets and a repeat block", () => {
  const w = intervalWorkout({ name: "5x3min", sport: "running", warmupMin: 15, cooldownMin: 10, repeats: 5, work: { type: "time", seconds: 180 }, recovery: { type: "distance", meters: 400 }, target: { type: "pace", slowSPerKm: 250, fastSPerKm: 240 } });
  const steps = decodeFit(encodeWorkoutFit(w, NOW)).messages.filter((m) => m.global === 27);
  assert.deepEqual(steps.map((s) => s.fields[7]), [2, 5, 4, 0xff, 3], "warmup, interval, recovery, repeat, cooldown");
  assert.deepEqual([steps[1].fields[3], steps[1].fields[5], steps[1].fields[6]], [TARGET_TYPE.speed, 4000, 4167], "pace stored as speed in mm/s");
  assert.deepEqual([steps[2].fields[1], steps[2].fields[2]], [DURATION_TYPE.distance, 40000]);
  assert.deepEqual([steps[3].fields[1], steps[3].fields[2], steps[3].fields[4]], [DURATION_TYPE.repeat_until_steps_cmplt, 1, 5], "repeat from step 1, 5 times");
  const hr = intervalWorkout({ name: "Z2", sport: "cycling", warmupMin: 0, cooldownMin: 0, repeats: 1, work: { type: "time", seconds: 3600 }, recovery: { type: "open" }, target: { type: "heart_rate", low: 130, high: 145 } });
  const s = decodeFit(encodeWorkoutFit(hr, NOW)).messages.filter((m) => m.global === 27)[0];
  assert.deepEqual([s.fields[3], s.fields[5], s.fields[6]], [TARGET_TYPE.heart_rate, 230, 245], "custom bpm offset by 100");
  assert.deepEqual(decodeFit(encodeWorkoutFit(hr, NOW)).messages.find((m) => m.global === 26)!.fields[4], 2, "cycling");
});

test("structured validation rejects impossible workouts", () => {
  const base: StructuredWorkout = { name: "x", sport: "running", steps: [{ kind: "step", name: "Run", intensity: "active", duration: { type: "time", seconds: 600 }, target: { type: "heart_rate", low: 150, high: 140 } }] };
  assert.match(validateStructured(base)!, /low ≤ high/);
  assert.match(validateStructured({ ...base, steps: [] })!, /no steps/);
  assert.match(validateStructured({ ...base, steps: [{ kind: "repeat", times: 1, steps: [] }] })!, /2 to 99/);
  assert.match(validateStructured({ ...base, name: "" })!, /name/);
  const big: StructuredWorkout = { ...base, steps: Array.from({ length: 101 }, () => ({ kind: "step" as const, name: "a", intensity: "active" as const, duration: { type: "open" as const }, target: { type: "open" as const } })) };
  assert.match(validateStructured(big)!, /more than 100/);
});

test("ICS: valid calendar text, escaping, folding, and all-day or timed events", () => {
  const w = { ...routineToStructured(fromTemplate("legs", uid()), []), name: "Legs; heavy, day" };
  const ics = buildIcs([{ uid: "a", workout: w, date: "2026-11-14" }, { uid: "b", workout: w, date: "2026-11-15", startTime: "07:30", durationMin: 75 }], NOW);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
  assert.match(ics, /SUMMARY:Legs\\; heavy\\, day/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261114\r\nDTEND;VALUE=DATE:20261115/);
  assert.match(ics, /DTSTART:20261115T073000\r\nDURATION:PT75M/);
  assert.match(ics, /DTSTAMP:20261112T100000Z/);
  for (const line of ics.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, "every physical line is folded to 75 octets");
  assert.equal(fold("é".repeat(60)).split("\r\n ").join(""), "é".repeat(60), "folding never splits a character");
  assert.throws(() => buildIcs([{ uid: "c", workout: w, date: "14/11/2026" }], NOW));
  assert.match(describe(w), /Squat \(Barbell\): 5 reps/);
});

test("export adapters are honest about their status; Garmin Connect never pretends to send", () => {
  assert.deepEqual(ADAPTERS.map((a) => [a.id, a.status]), [["fit", "experimental"], ["ics", "available"], ["json", "available"], ["garmin_connect", "requires_approval"]]);
  const w = { ...routineToStructured(fromTemplate("pull", uid()), []), scheduledDate: "2026-11-20" };
  assert.equal(FIT_ADAPTER.export(w, NOW).filename, "Pull.fit");
  assert.match(FIT_ADAPTER.instructions, /not yet confirmed on a Forerunner 965/);
  assert.match(new TextDecoder().decode(ICS_ADAPTER.export(w, NOW).bytes), /BEGIN:VEVENT/);
  assert.throws(() => ICS_ADAPTER.export({ ...w, scheduledDate: null }, NOW), ExportUnavailable);
  assert.equal(JSON.parse(new TextDecoder().decode(JSON_ADAPTER.export(w, NOW).bytes)).format, "apex-structured-workout");
  assert.throws(() => GARMIN_CONNECT_ADAPTER.export(w, NOW), /not available/);
  assert.throws(() => FIT_ADAPTER.export({ ...w, steps: [] }, NOW), ExportUnavailable);
});

test("Intervals provenance extras: origin and watch measurements only when present and plausible", () => {
  assert.deepEqual(mapActivityExtras({ source: "GARMIN_CONNECT", device_name: "Forerunner 965", elapsed_time: 3900.4, max_heartrate: 171, calories: 512 }),
    { origin: "GARMIN_CONNECT", origin_device: "Forerunner 965", elapsed_s: 3900, max_hr: 171, calories: 512 });
  assert.deepEqual(mapActivityExtras({ source: "", max_heartrate: 400, calories: -5 }), { origin: null, origin_device: null, elapsed_s: null, max_hr: null, calories: null });
});
