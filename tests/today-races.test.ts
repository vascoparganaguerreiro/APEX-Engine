// Regression: Today's race card and five-day view must show existing races even before migration 10 (Race Hub columns).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASE_RACE_COLUMNS, RACE_COLUMNS, listRacesCompat, nextRace, splitRaces, type Race } from "../lib/races.ts";
import { fiveDays, nextRaceInfo } from "../lib/today/model.ts";

const TODAY = "2026-11-12";
type Row = Record<string, unknown>;
/** Fake races table: `hasRaceHub` false simulates a database where migration 10 has not been applied. */
function fakeDb(rows: Row[], o: { hasRaceHub: boolean; broken?: boolean }) {
  const selects: string[] = [];
  return {
    selects,
    from(t: string) {
      assert.equal(t, "races");
      return {
        select(cols: string) {
          selects.push(cols);
          return {
            order() {
              if (o.broken) return Promise.resolve({ data: null, error: { message: "permission denied" } });
              const wantsHub = cols.split(",").some((c) => !BASE_RACE_COLUMNS.split(",").includes(c));
              if (wantsHub && !o.hasRaceHub) return Promise.resolve({ data: null, error: { message: "column races.sport does not exist", code: "42703" } });
              return Promise.resolve({ data: rows.map((r) => Object.fromEntries(cols.split(",").filter((c) => c in r).map((c) => [c, r[c]]))), error: null });
            },
          };
        },
      };
    },
  };
}
const legacyRow = (o: Row = {}): Row => ({ id: 1, name: "City 10k", race_date: "2026-11-14", race_type: "10k", priority: "A", goal: "Sub 45", notes: null, ...o });
const hubRow = (o: Row = {}): Row => ({ ...legacyRow(), sport: "running", location: "Lisbon", distance: 10, distance_unit: "km", target_time_s: 2700, status: "registered", ...o });

test("before migration 10: existing races load through the original columns instead of a false 'database update' error", async () => {
  const db = fakeDb([legacyRow()], { hasRaceHub: false });
  const r = await listRacesCompat(db);
  assert.equal(r.legacy, true);
  assert.deepEqual(db.selects, [RACE_COLUMNS, BASE_RACE_COLUMNS], "tries the full columns first, then falls back");
  assert.equal(r.races.length, 1);
  assert.equal(r.races[0].name, "City 10k"); assert.equal(r.races[0].status, "planned", "no status column yet: treated as planned, like nextUpcomingRace");
  assert.equal(r.races[0].goal, "Sub 45"); assert.equal(r.races[0].location, null);
  const card = nextRaceInfo(nextRace(r.races, TODAY), TODAY);
  assert.ok(card && card.race.name === "City 10k" && card.cd.days === 2, "the Today race card shows the race and its countdown");
});

test("after migration 10: full rows are used unchanged", async () => {
  const r = await listRacesCompat(fakeDb([hubRow()], { hasRaceHub: true }));
  assert.equal(r.legacy, false); assert.equal(r.races[0].status, "registered"); assert.equal(r.races[0].location, "Lisbon"); assert.equal(r.races[0].target_time_s, 2700);
});

test("a real failure is still reported (no silent empty list)", async () => {
  await assert.rejects(listRacesCompat(fakeDb([], { hasRaceHub: true, broken: true })));
});

const race = (o: Partial<Race>): Race => ({ id: 1, name: "R", race_date: "2026-11-14", race_type: "10k", sport: "running", location: null, distance: null, distance_unit: null, target_time_s: null, priority: "B", goal: null, notes: null, status: "planned", ...o });
const days = (races: Race[]) => fiveDays({ today: TODAY, tz: "UTC", races, acts: [], strength: [], activeWorkout: null, sups: [], schedules: [], supToday: null });

test("five-day view: races appear on their date, once, with the same upcoming rule as the Races page", () => {
  const races = [
    race({ id: 1, name: "Today race", race_date: TODAY, status: "registered" }),
    race({ id: 2, name: "Saturday race", race_date: "2026-11-14", status: "planned" }),
    race({ id: 3, name: "Cancelled", race_date: "2026-11-13", status: "cancelled" }),
    race({ id: 4, name: "Done", race_date: TODAY, status: "completed" }),
    race({ id: 5, name: "DNS", race_date: "2026-11-15", status: "dns" }),
    race({ id: 6, name: "Past", race_date: "2026-11-10", status: "planned" }),
    race({ id: 7, name: "Later", race_date: "2026-11-20", status: "planned" }),
  ];
  const d = days(races);
  const shown = d.flatMap((c) => c.items.filter((i) => i.kind === "race").map((i) => i.title));
  assert.deepEqual(shown, ["Today race", "Saturday race"], "only upcoming planned/registered races inside the five days, each once");
  assert.equal(d[0].items[0].href, "/races/1");
  // Consistency with the Races page: every race shown as upcoming here is in the Races page's "upcoming" list.
  const upcoming = new Set(splitRaces(races, TODAY).upcoming.map((r) => r.id));
  for (const r of races.filter((x) => shown.includes(x.name))) assert.ok(upcoming.has(r.id));
  // Races loaded through the pre-migration fallback (status defaulted to planned) are shown too.
  assert.ok(days([race({ name: "Legacy", race_date: "2026-11-13" })])[1].items.some((i) => i.kind === "race" && i.title === "Legacy"));
});

test("the race card uses the same next-race rule as the Races page; completed and cancelled races are never 'next'", () => {
  const races = [race({ id: 1, race_date: "2026-11-13", status: "cancelled" }), race({ id: 2, race_date: "2026-11-14", status: "completed" }), race({ id: 3, name: "Next", race_date: "2026-12-01" })];
  assert.equal(nextRace(races, TODAY)!.name, "Next");
  assert.equal(nextRaceInfo(null, TODAY), null);
});

test("wiring: Today uses the compatible loader; the Races page keeps its own listRaces", () => {
  const load = readFileSync(new URL("../lib/today/load.ts", import.meta.url), "utf8");
  assert.match(load, /listRacesCompat\(getSupabase\(\)\)/);
  assert.ok(!/Races need a database update/.test(load), "the false migration warning is gone");
  assert.match(readFileSync(new URL("../app/(app)/races/page.tsx", import.meta.url), "utf8"), /listRaces\(getSupabase\(\)\)/);
});
