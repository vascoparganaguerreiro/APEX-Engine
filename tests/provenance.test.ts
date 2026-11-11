import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EMPTY_METRICS, buildManualPatch, mergeSync, sameMetrics, type MetricRow } from "../lib/provenance.ts";
import { decryptSecret, encryptSecret } from "../lib/crypto.ts";

const row = (over: Partial<MetricRow> = {}): MetricRow => ({ ...EMPTY_METRICS, ...over });
const none = { hrv: "", rhr: "", sleepH: "" };
const sync = { hrv_ms: 70, rhr_bpm: 48, sleep_minutes: 480, sleep_score: 85 };

test("1. new manual entry saves only the filled fields, marked manual", () => {
  const r = buildManualPatch(null, { hrv: "62", rhr: "", sleepH: "" });
  assert.deepEqual(r.patch, { hrv_ms: 62, hrv_source: "manual" });
  const all = buildManualPatch(null, { hrv: "62", rhr: "50", sleepH: "7.5" });
  assert.equal(all.patch?.sleep_minutes, 450);
  assert.equal(all.patch?.rhr_source, "manual");
});

test("2. editing an existing manual entry updates it", () => {
  const ex = row({ hrv_ms: 60, hrv_source: "manual", rhr_bpm: 52, rhr_source: "manual" });
  const r = buildManualPatch(ex, { hrv: "65", rhr: "52", sleepH: "" });
  assert.deepEqual(r.patch, { hrv_ms: 65, hrv_source: "manual" });   // unchanged RHR is not rewritten
});

test("3. editing only HRV leaves RHR and sleep (and their sources) untouched", () => {
  const ex = row({ hrv_ms: 60, hrv_source: "intervals", rhr_bpm: 50, rhr_source: "intervals",
    sleep_minutes: 450, sleep_source: "intervals", sleep_score: 80, sleep_score_source: "intervals" });
  const r = buildManualPatch(ex, { hrv: "66", rhr: "50", sleepH: "7.5" });
  assert.deepEqual(Object.keys(r.patch!).sort(), ["hrv_ms", "hrv_source"]);
  assert.equal(r.patch!.hrv_source, "manual");
});

test("4. sync never overwrites manual values (and legacy unknown sources count as manual)", () => {
  const ex = row({ hrv_ms: 60, hrv_source: "manual", rhr_bpm: 51, rhr_source: null, sleep_minutes: 400, sleep_source: "manual" });
  const m = mergeSync(ex, sync);
  assert.equal(m.hrv_ms, 60); assert.equal(m.rhr_bpm, 51); assert.equal(m.sleep_minutes, 400);
  assert.equal(m.sleep_score, null);                 // score of the synced night is not attached to a manual night
  assert.ok(sameMetrics(ex, m));                     // nothing to write
});

test("5. sync fills a day with no manual values, and refreshes earlier synced ones", () => {
  const m = mergeSync(null, sync);
  assert.deepEqual([m.hrv_ms, m.rhr_bpm, m.sleep_minutes, m.sleep_score], [70, 48, 480, 85]);
  assert.deepEqual([m.hrv_source, m.rhr_source, m.sleep_source, m.sleep_score_source], ["intervals", "intervals", "intervals", "intervals"]);
  const again = mergeSync(m, { ...sync, hrv_ms: 72 });
  assert.equal(again.hrv_ms, 72);
});

test("6. empty manual fields write nothing and never erase saved values", () => {
  const ex = row({ hrv_ms: 60, hrv_source: "manual" });
  assert.deepEqual(buildManualPatch(ex, none).patch, {});
  assert.deepEqual(buildManualPatch(null, none).patch, {});
  assert.equal(buildManualPatch(null, { hrv: "abc", rhr: "", sleepH: "" }).error, "Please enter valid numbers.");
  assert.ok(buildManualPatch(null, { hrv: "", rhr: "5", sleepH: "" }).error);
});

test("7. missing sleep score is never invented, and a manual sleep change clears an old score", () => {
  const noScore = mergeSync(null, { ...sync, sleep_score: null });
  assert.equal(noScore.sleep_score, null); assert.equal(noScore.sleep_score_source, null);
  const stale = mergeSync(row({ sleep_minutes: 400, sleep_source: "intervals", sleep_score: 90, sleep_score_source: "intervals" }),
    { ...sync, sleep_score: null });
  assert.equal(stale.sleep_score, null);             // new night length, no score: the old one must go
  const ex = row({ sleep_minutes: 450, sleep_source: "intervals", sleep_score: 85, sleep_score_source: "intervals" });
  const p = buildManualPatch(ex, { hrv: "", rhr: "", sleepH: "6" }).patch!;
  assert.equal(p.sleep_minutes, 360); assert.equal(p.sleep_score, null); assert.equal(p.sleep_score_source, null);
  assert.equal(buildManualPatch(ex, { hrv: "", rhr: "", sleepH: "7.5" }).patch?.sleep_score, undefined); // unchanged: score kept
});

test("8. several sources for one day keep per-field provenance", () => {
  const ex = row({ hrv_ms: 60, hrv_source: "manual", rhr_bpm: 49, rhr_source: "intervals" });
  const m = mergeSync(ex, sync);
  assert.deepEqual([m.hrv_ms, m.hrv_source], [60, "manual"]);          // protected
  assert.deepEqual([m.rhr_bpm, m.rhr_source], [48, "intervals"]);      // refreshed
  assert.deepEqual([m.sleep_minutes, m.sleep_source], [480, "intervals"]); // filled
});

test("API key encryption round-trips, is randomised and detects tampering", () => {
  const key = randomBytes(32).toString("base64");
  const a = encryptSecret("my-secret-key", key), b = encryptSecret("my-secret-key", key);
  assert.notEqual(a, b);
  assert.ok(!a.includes("my-secret-key"));
  assert.equal(decryptSecret(a, key), "my-secret-key");
  assert.throws(() => decryptSecret(a.slice(0, -2) + "AA", key));
  assert.throws(() => decryptSecret(a, randomBytes(32).toString("base64")));
  assert.throws(() => encryptSecret("x", "short"));
});
