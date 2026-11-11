import test from "node:test";
import assert from "node:assert/strict";
import { filterActivities, summarizeActivities, addDaysIso, formatDistance, formatDuration, paceLabel, weekStart, weekTotals, localDay, type Activity } from "../lib/activities.ts";

const act = (over: Partial<Activity>): Activity => ({
  id: 1, started_at: "2026-11-09T08:00:00Z", sport: "run", title: null, duration_s: 3600, distance_m: 10000,
  avg_hr: 140, load: 60, note: null, ai_summary: null, ai_summary_at: null, ...over,
});

test("durations and distances read naturally", () => {
  assert.equal(formatDuration(3540), "59m");
  assert.equal(formatDuration(3900), "1h 05m");
  assert.equal(formatDuration(3599), "1h 00m");
  assert.equal(formatDuration(null), "â€”");
  assert.equal(formatDistance(10700), "10.7 km");
  assert.equal(formatDistance(850), "850 m");
  assert.equal(formatDistance(null), "â€”");
});

test("pace: run min/km, bike km/h, swim min/100m", () => {
  assert.equal(paceLabel("run", 3540, 10700), "5:31/km");
  assert.equal(paceLabel("run", 3000, 10000), "5:00/km");
  assert.equal(paceLabel("bike", 3600, 30000), "30.0 km/h");
  assert.equal(paceLabel("swim", 1800, 1500), "2:00/100m");
  assert.equal(paceLabel("strength", 3600, null), null);
  assert.equal(paceLabel("run", 0, 1000), null);
});

test("weeks start on Monday", () => {
  assert.equal(weekStart("2026-11-09"), "2026-11-09");  // Monday
  assert.equal(weekStart("2026-11-15"), "2026-11-09");  // Sunday
  assert.equal(weekStart("2026-11-10"), "2026-11-09");
  assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
});

test("week totals only count that week and only distance sports", () => {
  const acts = [
    act({ id: 1, started_at: "2026-11-09T08:00:00Z" }),
    act({ id: 2, started_at: "2026-11-12T08:00:00Z", sport: "bike", duration_s: 7200, distance_m: 60000, load: 90 }),
    act({ id: 3, started_at: "2026-11-14T08:00:00Z", sport: "strength", duration_s: 3000, distance_m: null, load: null }),
    act({ id: 4, started_at: "2026-11-02T08:00:00Z" }), // previous week
  ];
  const t = weekTotals(acts, "2026-11-09", "UTC");
  assert.equal(t.sessions, 3);
  assert.equal(t.minutes, 230);
  assert.equal(t.load, 150);
  assert.deepEqual(t.km, { run: 10, bike: 60 });
  assert.equal(localDay("2026-11-09T23:30:00Z", "Europe/Prague"), "2026-11-10");
});

test("filter by sport and search text", () => {
  const acts = [
    act({ id: 1, title: "Easy run", sport: "run" }),
    act({ id: 2, title: "Hill repeats", sport: "run", note: "felt strong" }),
    act({ id: 3, title: "Long ride", sport: "bike" }),
  ];
  assert.equal(filterActivities(acts, "all", "").length, 3);
  assert.deepEqual(filterActivities(acts, "run", "").map((a) => a.id), [1, 2]);
  assert.deepEqual(filterActivities(acts, "all", " STRONG ").map((a) => a.id), [2]);
  assert.deepEqual(filterActivities(acts, "bike", "run").map((a) => a.id), []);
});

test("summary totals and pace only for a single sport", () => {
  const acts = [
    act({ id: 1, duration_s: 3000, distance_m: 10000, load: 50 }),
    act({ id: 2, duration_s: 3000, distance_m: 10000, load: 40.4 }),
  ];
  const s = summarizeActivities(acts, "run");
  assert.equal(s.sessions, 2);
  assert.equal(s.distanceM, 20000);
  assert.equal(s.durationS, 6000);
  assert.equal(s.load, 90);
  assert.equal(s.pace, "5:00/km");
  assert.equal(summarizeActivities(acts, "all").pace, null);
});
