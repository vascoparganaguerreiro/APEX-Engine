import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_METRICS, applyManual, buildManualPatch, mergeSync, type MetricRow } from "../lib/provenance.ts";

const row = (over: Partial<MetricRow> = {}): MetricRow => ({ ...EMPTY_METRICS, ...over });
const none = { hrv: "", rhr: "", sleepH: "" };
const sync = { hrv_ms: 70, rhr_bpm: 48, sleep_minutes: 480, sleep_score: 85 };

test("new manual entry sends only the filled fields and marks them manual", () => {
  const r = buildManualPatch(null, { hrv: "62", rhr: "", sleepH: "" });
  assert.deepEqual(r.patch, { hrv_ms: 62 });
  const m = applyManual(null, r.patch!);
  assert.deepEqual([m.hrv_ms, m.hrv_source, m.rhr_bpm, m.rhr_source, m.sleep_minutes], [62, "manual", null, null, null]);
  assert.equal(buildManualPatch(null, { hrv: "62", rhr: "50", sleepH: "7.5" }).patch?.sleep_minutes, 450);
});

test("editing an existing manual entry updates it; unchanged fields are not resent", () => {
  const ex = row({ hrv_ms: 60, hrv_source: "manual", rhr_bpm: 52, rhr_source: "manual" });
  assert.deepEqual(buildManualPatch(ex, { hrv: "65", rhr: "52", sleepH: "" }).patch, { hrv_ms: 65 });
});

test("partial update: editing only HRV keeps RHR, sleep, score and every source untouched", () => {
  const ex = row({ hrv_ms: 60, hrv_source: "intervals", rhr_bpm: 50, rhr_source: "intervals",
    sleep_minutes: 450, sleep_source: "intervals", sleep_score: 80, sleep_score_source: "intervals" });
  const patch = buildManualPatch(ex, { hrv: "66", rhr: "50", sleepH: "7.5" }).patch!;
  assert.deepEqual(patch, { hrv_ms: 66 });
  const after = applyManual(ex, patch);
  assert.deepEqual({ ...after, hrv_ms: ex.hrv_ms, hrv_source: ex.hrv_source }, ex);   // everything except HRV is identical
  assert.deepEqual([after.hrv_ms, after.hrv_source], [66, "manual"]);
});

test("empty manual fields write nothing and never erase saved values", () => {
  const ex = row({ hrv_ms: 60, hrv_source: "manual" });
  assert.deepEqual(buildManualPatch(ex, none).patch, {});
  assert.deepEqual(buildManualPatch(null, none).patch, {});
  assert.deepEqual(applyManual(ex, {}), ex);
  assert.equal(buildManualPatch(null, { hrv: "abc", rhr: "", sleepH: "" }).error, "Please enter valid numbers.");
  assert.ok(buildManualPatch(null, { hrv: "", rhr: "5", sleepH: "" }).error);
});

test("sync never overwrites manual values", () => {
  const ex = row({ hrv_ms: 60, hrv_source: "manual", rhr_bpm: 51, rhr_source: "manual", sleep_minutes: 400, sleep_source: "manual" });
  const m = mergeSync(ex, sync);
  assert.deepEqual([m.hrv_ms, m.rhr_bpm, m.sleep_minutes], [60, 51, 400]);
});

test("legacy_unknown and missing provenance are protected from sync, but a manual edit can replace them", () => {
  const ex = row({ hrv_ms: 60, hrv_source: "legacy_unknown", rhr_bpm: 51, rhr_source: null, sleep_minutes: 400, sleep_source: "legacy_unknown" });
  const m = mergeSync(ex, sync);
  assert.deepEqual([m.hrv_ms, m.rhr_bpm, m.sleep_minutes], [60, 51, 400]);
  assert.deepEqual([m.hrv_source, m.rhr_source], ["legacy_unknown", null]);       // no provenance is invented
  const edited = applyManual(ex, { hrv_ms: 61 });
  assert.deepEqual([edited.hrv_ms, edited.hrv_source], [61, "manual"]);
});

test("sync fills an empty day, refreshes earlier synced values, and null never erases", () => {
  const m = mergeSync(null, sync);
  assert.deepEqual([m.hrv_ms, m.rhr_bpm, m.sleep_minutes, m.sleep_score], [70, 48, 480, 85]);
  assert.deepEqual([m.hrv_source, m.rhr_source, m.sleep_source, m.sleep_score_source], ["intervals", "intervals", "intervals", "intervals"]);
  assert.equal(mergeSync(m, { ...sync, hrv_ms: 72 }).hrv_ms, 72);
  const kept = mergeSync(m, { hrv_ms: null, rhr_bpm: null, sleep_minutes: null, sleep_score: null });
  assert.deepEqual(kept, m);
});

test("sleep score is independent: a manual sleep correction keeps it; a missing score is never invented", () => {
  const ex = row({ sleep_minutes: 450, sleep_source: "intervals", sleep_score: 85, sleep_score_source: "intervals" });
  const after = applyManual(ex, buildManualPatch(ex, { hrv: "", rhr: "", sleepH: "6" }).patch!);
  assert.deepEqual([after.sleep_minutes, after.sleep_source], [360, "manual"]);
  assert.deepEqual([after.sleep_score, after.sleep_score_source], [85, "intervals"]);   // measured score and provenance preserved
  const noScore = mergeSync(null, { ...sync, sleep_score: null });
  assert.deepEqual([noScore.sleep_score, noScore.sleep_score_source], [null, null]);
  // A score measured by the device may arrive even when the duration was corrected by hand, and keeps its own source.
  const withManualSleep = mergeSync(row({ sleep_minutes: 400, sleep_source: "manual" }), sync);
  assert.deepEqual([withManualSleep.sleep_minutes, withManualSleep.sleep_score, withManualSleep.sleep_score_source], [400, 85, "intervals"]);
});

test("several sources for one day keep per-field provenance", () => {
  const ex = row({ hrv_ms: 60, hrv_source: "manual", rhr_bpm: 49, rhr_source: "intervals" });
  const m = mergeSync(ex, sync);
  assert.deepEqual([m.hrv_ms, m.hrv_source], [60, "manual"]);
  assert.deepEqual([m.rhr_bpm, m.rhr_source], [48, "intervals"]);
  assert.deepEqual([m.sleep_minutes, m.sleep_source], [480, "intervals"]);
});

// The real guarantee is Postgres executing one statement at a time per row (see 06_metric_provenance.sql).
// These tests check the RULES are order-independent when each operation is applied atomically to the latest row.
test("concurrent manual edit and sync: a manual value wins in either commit order", () => {
  const start = row({ hrv_ms: 60, hrv_source: "intervals" });
  const manual = { hrv_ms: 66 };
  const syncThenManual = applyManual(mergeSync(start, sync), manual);
  const manualThenSync = mergeSync(applyManual(start, manual), sync);
  assert.deepEqual([syncThenManual.hrv_ms, syncThenManual.hrv_source], [66, "manual"]);
  assert.deepEqual([manualThenSync.hrv_ms, manualThenSync.hrv_source], [66, "manual"]);
  // fields the user did not touch still receive the synced values in both orders
  assert.equal(syncThenManual.rhr_bpm, 48);
  assert.equal(manualThenSync.rhr_bpm, 48);
});

test("the SQL functions encode the same rules (static check of 06_metric_provenance.sql)", async () => {
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(new URL("../06_metric_provenance.sql", import.meta.url), "utf8");
  assert.match(sql, /apply_synced_metrics/);
  assert.match(sql, /d\.hrv_ms is null or d\.hrv_source = 'intervals'/);
  assert.match(sql, /legacy_unknown/);
  assert.ok(!/sleep_score\s*=\s*null/i.test(sql.replace(/--.*$/gm, "")), "manual writes must not clear the sleep score");
  assert.match(sql, /on conflict \(user_id, day\) do update/i);
});
