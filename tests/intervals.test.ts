import test from "node:test";
import assert from "node:assert/strict";
import { IntervalsError, authHeader, fetchAthlete, mapActivity, mapSport, mapWellness, normalizeApiKey, normalizeAthleteId } from "../lib/intervals.ts";

test("wellness maps to daily_metrics values", () => {
  assert.deepEqual(mapWellness({ id: "2026-11-09", hrv: 62.4, restingHR: 48, sleepSecs: 27000, sleepScore: 81 }),
    { day: "2026-11-09", hrv_ms: 62.4, rhr_bpm: 48, sleep_minutes: 450, sleep_score: 81 });
  assert.equal(mapWellness({ id: "2026-11-09", weight: 70 }), null);
  assert.equal(mapWellness({ id: "nope", hrv: 60 }), null);
});

test("activities map sport, units and ids", () => {
  assert.equal(mapSport("VirtualRide"), "bike");
  assert.equal(mapSport("TrailRun"), "run");
  assert.equal(mapSport("WeightTraining"), "strength");
  assert.equal(mapSport("Yoga"), "other");
  const a = mapActivity({ id: "i99", start_date: "2026-11-09T08:00:00Z", type: "Run", name: " Easy ", moving_time: 3540,
    distance: 10700.4, average_heartrate: 139.6, icu_training_load: 55.2 });
  assert.deepEqual(a, { external_id: "i99", started_at: "2026-11-09T08:00:00.000Z", sport: "run", title: "Easy",
    duration_s: 3540, distance_m: 10700.4, avg_hr: 140, load: 55 });
  assert.equal(mapActivity({ type: "Run" }), null);
});

const reply = (status: number, body: unknown = {}) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("IntervalsError carries status and name", () => {
  const e = new IntervalsError(401, "nope");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "IntervalsError");
  assert.equal(e.status, 401);
  assert.equal(e.message, "nope");
});

test("athlete id and api key are validated", () => {
  assert.equal(normalizeAthleteId(" i12345 "), "i12345");
  assert.equal(normalizeAthleteId("0"), "0");
  assert.throws(() => normalizeAthleteId("../x"), IntervalsError);
  assert.throws(() => normalizeAthleteId(undefined), IntervalsError);
  assert.equal(normalizeApiKey(" abcdEFGH1234 "), "abcdEFGH1234");
  assert.throws(() => normalizeApiKey("short"), IntervalsError);
  assert.throws(() => normalizeApiKey("has space inside"), IntervalsError);
});

test("auth header uses API_KEY as the user", () => {
  assert.equal(authHeader("secret12"), `Basic ${Buffer.from("API_KEY:secret12").toString("base64")}`);
});

test("fetchAthlete returns the profile on success", async () => {
  const a = await fetchAthlete("i1", "abcdEFGH1234", reply(200, { id: "i1", name: "Ana" }));
  assert.deepEqual(a, { id: "i1", name: "Ana" });
});

test("fetchAthlete maps failures to IntervalsError", async () => {
  await assert.rejects(fetchAthlete("i1", "abcdEFGH1234", reply(401)), (e: IntervalsError) => e.status === 401);
  await assert.rejects(fetchAthlete("i1", "abcdEFGH1234", reply(429)), (e: IntervalsError) => e.status === 429);
  await assert.rejects(fetchAthlete("i1", "abcdEFGH1234", reply(500)), (e: IntervalsError) => e.status === 502);
  const down = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
  await assert.rejects(fetchAthlete("i1", "abcdEFGH1234", down), (e: IntervalsError) => e.status === 502);
});
