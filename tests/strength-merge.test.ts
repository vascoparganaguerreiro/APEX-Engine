import test from "node:test";
import assert from "node:assert/strict";
import { findCandidates, loadExcludedActivityIds, mergedView, pairKey, scorePair, secondaryIds, strengthExcludedIds, trainingItems, type ActivitySource, type Link, type StrengthSource } from "../lib/strength/dedup.ts";
import { dailyLoads } from "../lib/activities.ts";

const act = (id: number, start: string, minutes: number | null, o: Partial<ActivitySource> = {}): ActivitySource => ({
  kind: "activity", id, startedAt: start, durationS: minutes === null ? null : minutes * 60, elapsedS: null, sport: "strength", title: "Strength", origin: "GARMIN_CONNECT", device: "Forerunner 965",
  avgHr: 112, maxHr: 158, calories: 420, load: 45, ...o,
});
const str = (id: string, start: string, minutes: number | null, o: Partial<StrengthSource> = {}): StrengthSource => ({
  kind: "strength", id, startedAt: start, endedAt: minutes === null ? null : new Date(Date.parse(start) + minutes * 60_000).toISOString(), title: "Push Day", source: "hevy_csv",
  exercises: 5, sets: 18, exerciseNames: ["Bench Press (Barbell)"], ...o,
});

test("high confidence: Garmin strength activity and Hevy log of the same session (timestamps not identical)", () => {
  const c = scorePair(act(1, "2026-11-10T18:02:00Z", 65), str("s", "2026-11-10T18:05:00Z", 61));
  assert.equal(c.confidence, "high");
  assert.ok(c.overlap > 0.9);
  assert.match(c.reasons.join(" "), /overlaps/);
});

test("medium: partial overlap, a generic activity type, or a missing duration with near-identical starts", () => {
  assert.equal(scorePair(act(1, "2026-11-10T18:00:00Z", 60), str("s", "2026-11-10T18:35:00Z", 60)).confidence, "medium");
  assert.equal(scorePair(act(1, "2026-11-10T18:00:00Z", 60, { sport: "other" }), str("s", "2026-11-10T18:02:00Z", 58)).confidence, "medium", "never high for a generic type");
  assert.equal(scorePair(act(1, "2026-11-10T18:00:00Z", null), str("s", "2026-11-10T18:04:00Z", 60)).confidence, "medium");
});

test("low (false positives avoided): same date only, different sports, or far-apart starts without durations", () => {
  const sameDay = scorePair(act(1, "2026-11-10T07:00:00Z", 45), str("s", "2026-11-10T18:00:00Z", 60));
  assert.equal(sameDay.confidence, "low");
  assert.match(sameDay.reasons.join(" "), /same day but the times do not overlap/);
  assert.equal(scorePair(act(1, "2026-11-10T18:00:00Z", 60, { sport: "run" }), str("s", "2026-11-10T18:00:00Z", 60)).confidence, "low");
  assert.equal(scorePair(act(1, "2026-11-10T18:00:00Z", null), str("s", "2026-11-10T18:30:00Z", 60)).confidence, "low");
  assert.equal(scorePair(act(1, "2026-11-10T18:00:00Z", 60), str("s", "2026-11-10T18:55:00Z", 60)).confidence, "low", "5 minutes of overlap is not enough");
});

test("candidates: Strava copies too; decided pairs and already-merged records are not suggested again", () => {
  const garmin = act(1, "2026-11-10T18:00:00Z", 60), strava = act(2, "2026-11-10T18:00:30Z", 60, { origin: "STRAVA" }), hevy = str("h", "2026-11-10T18:03:00Z", 57);
  const apex1 = str("a1", "2026-11-11T08:00:00Z", 60, { source: "apex" }), apex2 = str("a2", "2026-11-11T08:10:00Z", 60, { source: "apex" });
  const all = findCandidates([garmin, strava, hevy, apex1, apex2], [], []);
  assert.deepEqual(all.map((c) => c.key).sort(), [pairKey(garmin, strava), pairKey(garmin, hevy), pairKey(strava, hevy)].sort());
  assert.ok(!all.some((c) => c.key === pairKey(apex1, apex2)), "two workouts logged in APEX are never treated as duplicates");
  const decided = findCandidates([garmin, strava, hevy], [], [{ pairKey: pairKey(garmin, strava), decision: "separate", trainingSessionId: null, revertedAt: null }]);
  assert.ok(!decided.some((c) => c.key === pairKey(garmin, strava)));
  const reverted = findCandidates([garmin, strava], [], [{ pairKey: pairKey(garmin, strava), decision: "separate", trainingSessionId: null, revertedAt: "2026-11-12T00:00:00Z" }]);
  assert.equal(reverted.length, 1, "a reverted decision makes the suggestion come back");
  const links: Link[] = [{ trainingSessionId: "t", activityId: 1, strengthSessionId: null, role: "primary" }, { trainingSessionId: "t", activityId: null, strengthSessionId: "h", role: "secondary" }];
  assert.deepEqual(findCandidates([garmin, strava, hevy], links, []).length, 0, "records already merged are skipped");
  assert.equal(pairKey(hevy, garmin), pairKey(garmin, hevy), "order independent");
  assert.equal(pairKey(garmin, hevy), "activity:1|strength:h");
});

test("merged view: Garmin physiology and Hevy sets are both kept, with provenance; the primary decides title and time", () => {
  const g = act(1, "2026-11-10T18:02:00Z", 65), h = str("s", "2026-11-10T18:05:00Z", 61);
  const v1 = mergedView(g, h, g);
  assert.deepEqual([v1.title.source, v1.startedAt.value, v1.durationS.value], ["Garmin activity", g.startedAt, 3900]);
  assert.deepEqual([v1.avgHr?.value, v1.avgHr?.source, v1.calories?.value], [112, "Garmin activity", 420]);
  assert.deepEqual([v1.sets?.value, v1.sets?.source], [18, "Hevy import"]);
  const v2 = mergedView(g, h, h);
  assert.deepEqual([v2.title.value, v2.startedAt.value, v2.durationS.value, v2.avgHr?.value], ["Push Day", h.startedAt, 3660, 112], "heart rate still from Garmin");
  assert.deepEqual(v2.sourceIds, ["activity:1", "strength:s"]);
});

test("counting once: timeline, frequency and training load after merging (and after unmerging)", () => {
  const g = act(1, "2026-11-10T18:00:00Z", 60), strava = act(2, "2026-11-10T18:00:30Z", 60, { origin: "STRAVA", load: 44 }), h = str("s", "2026-11-10T18:03:00Z", 57);
  const links: Link[] = [
    { trainingSessionId: "t1", activityId: 1, strengthSessionId: null, role: "primary" }, { trainingSessionId: "t1", activityId: null, strengthSessionId: "s", role: "secondary" },
    { trainingSessionId: "t2", activityId: 2, strengthSessionId: null, role: "secondary" },
  ];
  // (t2 alone is not realistic; build the Garmin+Strava case separately)
  const items = trainingItems([g, h], links.slice(0, 2));
  assert.equal(items.length, 1, "one entry in the unified timeline");
  assert.equal(items[0].merged, true);
  assert.deepEqual(items[0].sources, ["Garmin activity", "Hevy import"]);
  assert.match(items[0].detail, /5 exercises, 18 sets/);
  assert.equal(trainingItems([g, h], []).length, 2, "after unmerging both records are back, untouched");
  // Garmin + Strava duplicates: the Strava copy's load is not counted twice
  const dupLinks: Link[] = [{ trainingSessionId: "t3", activityId: 1, strengthSessionId: null, role: "primary" }, { trainingSessionId: "t3", activityId: 2, strengthSessionId: null, role: "secondary" }];
  const excluded = loadExcludedActivityIds(dupLinks);
  assert.deepEqual([...excluded], [2]);
  const loads = dailyLoads([g, strava].filter((a) => !excluded.has(a.id)).map((a) => ({ started_at: a.startedAt, load: a.load })), "UTC");
  assert.deepEqual(loads, { "2026-11-10": 45 });
  assert.equal(loadExcludedActivityIds(links.slice(0, 2)).size, 0, "a Garmin activity merged with a strength log keeps its (only) load");
  assert.deepEqual([...secondaryIds(links.slice(0, 2)).strength], ["s"]);
  const strLinks: Link[] = [{ trainingSessionId: "t4", activityId: null, strengthSessionId: "apex-1", role: "primary" }, { trainingSessionId: "t4", activityId: null, strengthSessionId: "hevy-1", role: "secondary" }];
  assert.deepEqual([...strengthExcludedIds(strLinks)], ["hevy-1"], "an APEX log and its Hevy copy count as one strength workout");
  assert.equal(strengthExcludedIds(links.slice(0, 2)).size, 0, "a Hevy log merged with Garmin still counts in strength analytics");
});
