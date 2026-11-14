import test from "node:test";
import assert from "node:assert/strict";
import { buildActivityPrompt, buildWeekPrompt, extractText, rankModels, SUMMARY_SYSTEM } from "../lib/summary.ts";

const brief = { day: "2026-11-08", sport: "run", title: "Pilsen Corrida", minutes: 59, km: 10.7, pace: "5:31/km", avgHr: 146, load: 54, note: "Cut the warm-up short" };

test("activity prompt carries the facts and the athlete's note", () => {
  const p = buildActivityPrompt({
    today: "2026-11-10", activity: brief, sameSportRecent: [{ ...brief, day: "2026-11-05", note: null }],
    typical: { sessions: 12, avgMinutes: 55, avgLoad: 60 },
    load: { ctl: 73, atl: 49, tsb: 24, state: "Peak form window" },
    morning: { hrv: 68, rhr: 52, sleepH: 7.7, sleepScore: 74 }, sevenDay: { hrv: 70, rhr: 50, sleepH: 7.4 },
    race: { name: "10km Sao Silvestre", days: 33 },
  });
  for (const s of ["59 min", "10.7 km", "5:31/km", "Cut the warm-up short", "CTL (fitness) 73", "TSB (form) +24", "10km Sao Silvestre in 33 days", "average 55 min"]) assert.ok(p.includes(s), s);
});

test("prompts cope with missing data", () => {
  const p = buildActivityPrompt({ today: "2026-11-10", activity: { ...brief, km: null, pace: null, avgHr: null, load: null, note: null },
    sameSportRecent: [], typical: { sessions: 0, avgMinutes: null, avgLoad: null }, load: null, morning: null, sevenDay: null, race: null });
  assert.ok(p.includes("not available") && p.includes("none registered") && !p.includes("NaN") && !p.includes("undefined"));
});

test("week prompt compares with previous week and average", () => {
  const p = buildWeekPrompt({
    today: "2026-11-10", weekStart: "2026-11-02", weekEnd: "2026-11-08",
    thisWeek: { sessions: 5, minutes: 300, load: 420, km: { run: 30, bike: 80 } },
    previousWeek: { sessions: 4, minutes: 240, load: 330, km: { run: 20 } },
    fourWeekAvg: { sessions: 4.5, minutes: 260, load: 350 }, sessions: [brief],
    load: null, health: { hrv: 70, rhr: 50, sleepH: 7.4, prevHrv: 66, prevRhr: 51, prevSleepH: 7.1 }, race: null,
  });
  for (const s of ["5 sessions, 300 min, total load 420", "run 30.0 km, bike 80.0 km", "4.5 sessions", "HRV 70 ms"]) assert.ok(p.includes(s), s);
  assert.ok(SUMMARY_SYSTEM.includes("not a doctor"));
});

test("model ranking prefers stable newest flash and skips non-chat models", () => {
  const g = ["generateContent"];
  const ranked = rankModels([
    { name: "models/gemini-2.5-flash", supportedGenerationMethods: g },
    { name: "models/gemini-3.8-flash", supportedGenerationMethods: g },
    { name: "models/gemini-3.8-flash-lite", supportedGenerationMethods: g },
    { name: "models/gemini-3.8-pro", supportedGenerationMethods: g },
    { name: "models/gemini-3.9-flash-preview", supportedGenerationMethods: g },
    { name: "models/gemini-3.8-flash-tts", supportedGenerationMethods: g },
    { name: "models/gemini-embedding-2", supportedGenerationMethods: ["embedContent"] },
    { name: "models/gemma-3-27b", supportedGenerationMethods: g },
    { name: "models/gemini-3.8-flash; rm -rf", supportedGenerationMethods: g },
  ]);
  assert.equal(ranked[0], "gemini-3.8-flash");
  assert.deepEqual(ranked.slice(0, 3), ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-3.9-flash-preview"]);
  assert.ok(!ranked.some((n) => /tts|embedding|gemma|;/.test(n)));
});

test("extractText reads Gemini's answer shape", () => {
  assert.equal(extractText({ candidates: [{ content: { parts: [{ text: "Hello " }, { text: "world" }] } }] }), "Hello world");
  assert.equal(extractText({ candidates: [] }), null);
  assert.equal(extractText(null), null);
});

test("nextRace: counted from today, never a race that is already over", async () => {
  const { nextRace } = await import("../lib/summary.ts");
  const races = [{ name: "Spring 10k", race_date: "2026-09-01" }, { name: "Marathon", race_date: "2026-12-06" }, { name: "Late", race_date: "2027-03-01" }];
  assert.deepEqual(nextRace(races, "2026-11-14"), { name: "Marathon", days: 22 });      // the past race is skipped
  assert.deepEqual(nextRace(races, "2026-12-06"), { name: "Marathon", days: 0 });       // race day itself still counts
  assert.equal(nextRace(races, "2027-03-02"), null);
  assert.equal(nextRace([{ name: "Bad", race_date: null }, { name: "Old", race_date: "2020-01-01" }], "2026-11-14"), null);
  assert.deepEqual(nextRace([{ name: "B", race_date: "2026-11-20" }, { name: "A", race_date: "2026-11-15T00:00:00Z" }], "2026-11-14"), { name: "A", days: 1 });
});

test("the prompt never states a negative countdown and reads naturally on race day", () => {
  const base = { today: "2026-11-14", activity: { day: "2026-11-14", sport: "run", title: null, minutes: 30, km: 5, pace: null, avgHr: null, load: null, note: null },
    sameSportRecent: [], typical: { sessions: 0, avgMinutes: null, avgLoad: null }, load: null, morning: null, sevenDay: null };
  assert.match(buildActivityPrompt({ ...base, race: { name: "X", days: 0 } }), /Next race: X today/);
  assert.match(buildActivityPrompt({ ...base, race: { name: "X", days: 1 } }), /Next race: X in 1 day\n/);
});
