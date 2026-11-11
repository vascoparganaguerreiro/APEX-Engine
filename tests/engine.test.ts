// Run with: node --test tests/   (Node 22+ runs TypeScript directly)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trendSeries, banister, estimateLoad, hrvBaseline, loadSeries, projectTsb, racePhase, readiness, tsbState, addDays, daysBetween } from "../lib/engine.ts";

const ref = JSON.parse(readFileSync(new URL("./reference.json", import.meta.url), "utf8"));
const close = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("readiness matches the Python engine on every reference case", () => {
  for (const c of ref.readiness) {
    const r = readiness({
      hrv: c.in.hrv, rhr: c.in.rhr, sleepH: c.in.sleep_h,
      hrvPrior: c.in.hrv_prior, rhrPrior: c.in.rhr_prior, sleepGoalH: 8,
    });
    if (c.out === null) { assert.equal(r, null); continue; }
    assert.ok(r);
    assert.equal(r.score, c.out.score);
    assert.equal(r.verdict, c.out.verdict);
    assert.equal(r.baselineDays, c.out.baselineDays);
    if (c.out.hrvZ === null) assert.equal(r.hrvZ, null); else close(r.hrvZ as number, c.out.hrvZ);
  }
});

test("banister matches Python", () => {
  const got = banister([50, 0, 80, 120, 0, 0, 60], 10, 5);
  got.forEach((row, i) => row.forEach((v, j) => close(v, ref.banister[i][j])));
});

test("race-day projection matches Python", () => {
  close(projectTsb(73, 49, 34, 47), ref.projection[0]);
  close(projectTsb(73, 49, 34, 47, 5), ref.projection[1]);
  close(projectTsb(60, 70, 30, 60, 10), ref.projection[2]);
});

test("race phases match Python", () => {
  for (const [d, t, phase] of ref.phases) assert.equal(racePhase(d, t), phase);
});

test("baseline needs three days", () => {
  assert.equal(hrvBaseline([60, 62]), null);
  assert.ok(hrvBaseline([60, 62, 64]));
});

test("no data gives no readiness; no baseline is neutral, not a crash", () => {
  assert.equal(readiness({ hrv: null, rhr: null, sleepH: null }), null);
  const r = readiness({ hrv: 60, rhr: 50, sleepH: 8 });
  assert.ok(r && r.baselineDays === 0);
});

test("load helpers", () => {
  assert.equal(estimateLoad(60, 6), 60);
  assert.equal(tsbState(10), "Peak form window");
  assert.equal(tsbState(-40), "Overtraining risk");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(daysBetween("2026-11-09", "2026-12-13"), 34);
  const s = loadSeries({ "2026-01-01": 100 }, "2026-01-01", "2026-01-10");
  assert.equal(s.length, 10);
  assert.equal(s[0].load, 100);
  assert.equal(s[5].load, 0);
});

test("trendSeries warms up before the window and attaches HRV", () => {
  const s = trendSeries({ "2026-11-01": 100 }, { "2026-11-02": 60 }, "2026-11-01", "2026-11-03");
  assert.equal(s.length, 3);
  assert.equal(s[0].day, "2026-11-01");
  assert.ok(s[0].atl > s[0].ctl);              // one hard day: fatigue above fitness
  assert.equal(s[1].hrv, 60);
  assert.equal(s[2].hrv, null);
  const warm = trendSeries({ "2026-10-01": 100, "2026-10-02": 100 }, {}, "2026-11-01", "2026-11-01");
  assert.ok(warm[0].ctl > 0);                  // earlier training still counts
});