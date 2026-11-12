import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORMATS, countdown, createRace, daysUntil, deleteRace, filterRaces, formatDuration, getRace, goalRace, isIsoDate, isRaceId, isUpcoming, listRaces,
  monthGroups, nextRace, nextUpcomingRace, parseDuration, raceFromRow, splitRaces, updateRace, validateRace, writableRow,
  type Db, type Race, type RaceInput,
} from "../lib/races.ts";

const TODAY = "2026-11-11";
const input = (o: Partial<RaceInput> = {}): RaceInput => ({
  name: "Lisbon Half", race_date: "2027-03-14", race_type: "half_marathon", sport: "running", location: "Lisbon", distance: 21.1, distance_unit: "km",
  target_time_s: 5400, priority: "A", goal: "Run steady", notes: null, status: "planned", ...o,
});
const race = (o: Partial<Race> = {}): Race => ({ id: 1, ...input(), ...o });

// ------------------------------------------------------------------ validation
test("race validation accepts a complete race and rejects bad input", () => {
  assert.equal(validateRace(input(), TODAY), null);
  assert.equal(validateRace(input({ location: null, distance: null, distance_unit: null, target_time_s: null, goal: null }), TODAY), null, "optional fields can be empty");
  assert.ok(validateRace(input({ name: "  " }), TODAY));
  assert.ok(validateRace(input({ race_date: "2027-02-30" }), TODAY));
  assert.ok(validateRace(input({ race_date: "1970-01-01" }), TODAY));
  assert.ok(validateRace(input({ race_date: "2099-01-01" }), TODAY));
  assert.ok(validateRace(input({ priority: "D" as never }), TODAY));
  assert.ok(validateRace(input({ status: "won" as never }), TODAY));
  assert.ok(validateRace(input({ sport: "chess" as never }), TODAY));
  assert.ok(validateRace(input({ sport: "swimming", race_type: "marathon" }), TODAY), "format must belong to the sport");
  assert.ok(validateRace(input({ distance: 10, distance_unit: null }), TODAY), "distance needs its unit");
  assert.ok(validateRace(input({ distance: null, distance_unit: "km" }), TODAY));
  assert.ok(validateRace(input({ distance: -5 }), TODAY));
  assert.ok(validateRace(input({ distance_unit: "parsec" }), TODAY));
  assert.ok(validateRace(input({ target_time_s: 0 }), TODAY));
  assert.ok(validateRace(input({ target_time_s: 700_000 }), TODAY));
  assert.ok(validateRace(input({ notes: "x".repeat(2001) }), TODAY));
  for (const sport of ["running", "cycling", "triathlon", "swimming", "football", "other"] as const) assert.ok(FORMATS[sport].length > 0);
});

test("target times are parsed strictly and never invented", () => {
  assert.equal(parseDuration("3:45:00"), 13500);
  assert.equal(parseDuration("45:30"), 2730);
  assert.equal(parseDuration(" 1:05:30 "), 3930);
  for (const bad of ["", "abc", "3:75:00", "3:45:99", "0:00", "3h45", "1:2:3", "200:00:00"]) assert.equal(parseDuration(bad), null, bad);
  assert.equal(formatDuration(13500), "3:45:00");
  assert.equal(formatDuration(null), "");
  assert.equal(formatDuration(0), "");
});

// ------------------------------------------------------------------ dates and countdowns
test("dates and countdowns use calendar days and ignore time zones and daylight saving", () => {
  assert.equal(isIsoDate("2028-02-29"), true);
  assert.equal(isIsoDate("2027-02-29"), false);
  assert.equal(daysUntil("2026-11-11", "2026-11-11"), 0);
  assert.equal(daysUntil("2026-12-25", "2026-11-11"), 44);
  assert.equal(daysUntil("2027-01-01", "2026-12-31"), 1, "across the year");
  assert.equal(daysUntil("2026-03-29", "2026-03-28"), 1, "European DST change day is still one day");
  assert.equal(daysUntil("2026-10-26", "2026-10-24"), 2);
  assert.equal(daysUntil("2026-11-10", "2026-11-11"), -1);
  assert.deepEqual([countdown(TODAY, TODAY).label, countdown("2026-11-12", TODAY).label, countdown("2026-11-10", TODAY).label, countdown("2026-11-01", TODAY).label],
    ["Race day", "Tomorrow", "Yesterday", "10 days ago"]);
  assert.equal(countdown("2026-12-25", TODAY).detail, "6 weeks and 2 days to go");
  assert.equal(countdown("2026-11-18", TODAY).detail, "7 days to go");
  assert.equal(countdown("2026-11-01", TODAY).past, true);
});

// ------------------------------------------------------------------ upcoming vs completed, priority
test("upcoming and completed races are separated by date and status", () => {
  const races = [
    race({ id: 1, race_date: "2026-11-11" }),                                  // today: still to run
    race({ id: 2, race_date: "2026-12-01", status: "registered" }),
    race({ id: 3, race_date: "2026-12-05", status: "cancelled" }),             // future but cancelled
    race({ id: 4, race_date: "2026-10-01", status: "completed" }),
    race({ id: 5, race_date: "2026-09-01", status: "planned" }),               // past and never updated
    race({ id: 6, race_date: "2026-12-10", status: "dns" }),
  ];
  const { upcoming, past } = splitRaces(races, TODAY);
  assert.deepEqual(upcoming.map((r) => r.id), [1, 2]);
  assert.deepEqual(past.map((r) => r.id), [3, 6, 4, 5].sort((a, b) => races.find((r) => r.id === b)!.race_date.localeCompare(races.find((r) => r.id === a)!.race_date)));
  assert.equal(isUpcoming(race({ race_date: TODAY }), TODAY), true);
  assert.equal(nextRace(races, TODAY)?.id, 1);
  assert.equal(nextRace([], TODAY), null);
});

test("the main goal race is the soonest upcoming A race, and nothing is guessed", () => {
  const races = [
    race({ id: 1, race_date: "2026-12-01", priority: "B" }),
    race({ id: 2, race_date: "2027-05-01", priority: "A" }),
    race({ id: 3, race_date: "2027-03-01", priority: "A" }),
    race({ id: 4, race_date: "2026-11-20", priority: "A", status: "cancelled" }),
    race({ id: 5, race_date: "2026-10-01", priority: "A", status: "completed" }),
  ];
  assert.equal(goalRace(races, TODAY)?.id, 3);
  assert.equal(goalRace(races.filter((r) => r.priority !== "A"), TODAY), null, "no A race: no goal race is made up");
  assert.deepEqual(splitRaces([race({ id: 1, race_date: "2026-12-01", priority: "C" }), race({ id: 2, race_date: "2026-12-01", priority: "A" })], TODAY).upcoming.map((r) => r.priority), ["A", "C"], "same day: higher priority first");
});

test("search, sport filter and timeline grouping", () => {
  const races = [
    race({ id: 1, name: "Lisbon Half", sport: "running", location: "Lisbon" }),
    race({ id: 2, name: "Gran Fondo", sport: "cycling", location: "Porto", race_date: "2027-03-20", race_type: "cycling" }),
    race({ id: 3, name: "Sprint Tri", sport: "triathlon", location: null, race_date: "2027-04-02", race_type: "triathlon_sprint" }),
  ];
  assert.deepEqual(filterRaces(races, "", "all").map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(filterRaces(races, "porto", "all").map((r) => r.id), [2]);
  assert.deepEqual(filterRaces(races, "  LISBON ", "running").map((r) => r.id), [1]);
  assert.deepEqual(filterRaces(races, "lisbon", "cycling"), []);
  assert.deepEqual(monthGroups(races).map(([m, l]) => [m, l.length]), [["2027-03", 2], ["2027-04", 1]]);
});

test("rows from a database without the Race Hub columns still load safely", () => {
  const legacy = raceFromRow({ id: "7", name: "Old race", race_date: "2026-05-01", race_type: "marathon", priority: "A", goal: "sub 4", notes: null });
  assert.deepEqual([legacy.id, legacy.sport, legacy.status, legacy.target_time_s, legacy.distance], [7, "other", "planned", null, null]);
  const full = raceFromRow({ id: 8, name: "n", race_date: "2026-05-01", race_type: "10k", priority: "Z", sport: "running", status: "weird", distance: "10.5", target_time_s: "3000" });
  assert.deepEqual([full.priority, full.status, full.distance, full.target_time_s], ["B", "planned", 10.5, 3000], "unknown enum values fall back safely; numeric strings become numbers");
});

// ------------------------------------------------------------------ user-scoped data access (a stand-in that applies RLS like Supabase)
function fakeSupabase() {
  const rows: Array<Record<string, unknown>> = [];
  const sent: Array<{ op: string; payload: Record<string, unknown> }> = [];
  let nextId = 1;
  const asUser = (uid: string): Db => ({
    from() {
      let op = "select"; let payload: Record<string, unknown> = {}; let limit: number | null = null;
      const filters: Array<[string, unknown]> = []; let gte: [string, string] | null = null; let failSelect = false; const ins: Array<[string, unknown[]]> = [];
      const visible = () => rows.filter((r) => r.user_id === uid && filters.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c])) && (!gte || String(r[gte[0]]) >= gte[1]));
      const run = async (): Promise<{ data: unknown; error: { message: string } | null }> => {
        if (failSelect) return { data: null, error: { message: "column does not exist" } };
        if (op === "insert") {
          if (payload.user_id !== uid) return { data: null, error: { message: "new row violates row-level security policy" } };
          const row = { id: nextId++, status: "planned", sport: "other", ...payload }; rows.push(row); return { data: row, error: null };
        }
        if (op === "update") { const hit = visible(); hit.forEach((r) => Object.assign(r, payload)); return { data: hit, error: null }; }
        if (op === "delete") { const hit = visible(); hit.forEach((r) => rows.splice(rows.indexOf(r), 1)); return { data: hit.map((r) => ({ id: r.id })), error: null }; }
        let out = visible().sort((a, b) => String(a.race_date).localeCompare(String(b.race_date)));
        if (limit !== null) out = out.slice(0, limit);
        return { data: out, error: null };
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select(cols?: string) { if (cols && cols.startsWith("id,name,race_date,race_type,priority")) failSelect = false; return b; },
        insert(p: Record<string, unknown>) { op = "insert"; payload = p; sent.push({ op, payload }); return b; },
        update(p: Record<string, unknown>) { op = "update"; payload = p; sent.push({ op, payload }); return b; },
        delete() { op = "delete"; return b; },
        eq(c: string, v: unknown) { filters.push([c, v]); return b; },
        gte(c: string, v: string) { gte = [c, v]; return b; }, in(c: string, vs: unknown[]) { ins.push([c, vs]); return b; }, order() { return b; }, limit(n: number) { limit = n; return b; },
        single() { return run().then((r) => ({ data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error })); },
        maybeSingle() { return run().then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error })); },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return run().then(res, rej); },
      };
      return b;
    },
  });
  return { asUser, rows, sent };
}

test("races are strictly scoped to the signed-in user", async () => {
  const { asUser, rows, sent } = fakeSupabase();
  const alice = asUser("alice"), bob = asUser("bob");
  const a = await createRace(alice, "alice", input({ name: "Alice race" }));
  const b = await createRace(bob, "bob", input({ name: "Bob race" }));
  assert.equal(rows.find((r) => r.id === a.id)!.user_id, "alice");

  assert.deepEqual((await listRaces(alice)).map((r) => r.name), ["Alice race"]);
  assert.deepEqual((await listRaces(bob)).map((r) => r.name), ["Bob race"]);
  assert.equal(await getRace(alice, b.id), null, "another user's race cannot be read");
  await assert.rejects(updateRace(alice, b.id, input({ name: "hacked" })), /not found/i);
  await assert.rejects(deleteRace(alice, b.id), /not found/i);
  assert.equal((await getRace(bob, b.id))!.name, "Bob race", "untouched");

  await updateRace(alice, a.id, input({ name: "Alice renamed", priority: "B" }));
  assert.deepEqual([(await getRace(alice, a.id))!.name, (await getRace(alice, a.id))!.priority], ["Alice renamed", "B"]);
  await deleteRace(alice, a.id);
  assert.equal((await listRaces(alice)).length, 0);
  assert.equal((await listRaces(bob)).length, 1);

  for (const s of sent.filter((x) => x.op === "update")) assert.ok(!("user_id" in s.payload) && !("id" in s.payload), "updates never write user_id or id");
});

test("user_id always comes from the session, never from the form data", async () => {
  const { asUser, rows } = fakeSupabase();
  const evil = { ...input(), user_id: "bob", id: 999 } as unknown as RaceInput;
  await createRace(asUser("alice"), "alice", evil);
  assert.equal(rows[0].user_id, "alice");
  assert.notEqual(rows[0].id, 999);
  await assert.rejects(createRace(asUser("alice"), "bob", input()), (e: Error) => e.name === "SafeError" && /not allowed/.test(e.message) && !/row-level security/.test(e.message), "a mismatched user id is refused by RLS (and reported in plain words)");
  assert.deepEqual(Object.keys(writableRow({ ...input(), user_id: "x", id: 1, created_at: "now" })).sort(),
    ["distance", "distance_unit", "goal", "location", "name", "notes", "priority", "race_date", "race_type", "sport", "status", "target_time_s"]);
  assert.equal(isRaceId("12"), true);
  assert.equal(isRaceId("12; drop"), false);
  assert.equal(isRaceId("new"), false);
});

test("the Today race card is a bonus: the next upcoming race is found, and failures never break Today", async () => {
  const { asUser } = fakeSupabase();
  const db = asUser("alice");
  await createRace(db, "alice", input({ name: "Later", race_date: "2027-05-01" }));
  await createRace(db, "alice", input({ name: "Sooner", race_date: "2026-12-01" }));
  await createRace(db, "alice", input({ name: "Cancelled", race_date: "2026-11-15", status: "cancelled" }));
  await createRace(db, "alice", input({ name: "Past", race_date: "2026-10-01" }));
  assert.equal((await nextUpcomingRace(db, TODAY))?.name, "Sooner");
  assert.equal(await nextUpcomingRace(asUser("nobody"), TODAY), null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = { select: () => q, gte: () => q, in: () => q, order: () => q, limit: async () => ({ data: null, error: { message: "boom" } }) };
  const broken: Db = { from: () => q };
  assert.equal(await nextUpcomingRace(broken, TODAY), null, "a failing query just means no card");
});

// ------------------------------------------------------------------ static checks: migration, navigation, wiring
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("migration 10 is additive, keeps existing data and does not touch RLS or grants", () => {
  const sql = read("10_races.sql").replace(/--.*$/gm, "").toLowerCase();
  for (const c of ["sport", "location", "distance", "distance_unit", "target_time_s", "status"]) assert.match(sql, new RegExp(`add column if not exists ${c}\\b`));
  assert.ok(!/drop table|drop column|truncate|delete from|alter column (name|race_date|race_type|priority|goal|notes)/.test(sql), "no destructive change to existing columns or rows");
  assert.ok(!/create policy|drop policy|enable row level|disable row level|grant |revoke /.test(sql), "RLS and grants stay exactly as they are");
  assert.match(sql, /update public\.races set sport = case[\s\S]*where sport is null/, "backfill only fills empty values");
  assert.match(sql, /alter column sport set not null/);
  assert.match(sql, /status in \('planned', 'registered', 'completed', 'dnf', 'dns', 'cancelled'\)/);
  assert.match(sql, /target_time_s > 0 and target_time_s <= 604800/);
  assert.ok(!/result|finish_time|predict/.test(sql.replace(/target_time_s/g, "")), "no results or predictions are stored");
});

test("navigation, Today integration and in-place editing", () => {
  const layout = read("lib/nav.ts");
  assert.match(layout, /\{ href: "\/races", label: "Races" \}/);
  assert.ok(!/href: "\/races", label: "Races", soon/.test(layout));
  // Today (redesigned): races load on their own and a failure only affects the race card.
  const today = read("app/(app)/today/page.tsx");
  assert.match(today, /nextRace\(races\.data, today\)/);
  assert.match(today, /<RaceCard s=\{races \?\? LOADING\}/);
  assert.match(read("lib/today/load.ts"), /try \{ return \{ status: "ok", data: \(await listRacesCompat\(getSupabase\(\)\)\)\.races \}; \}\s*catch/);
  const page = read("app/(app)/races/page.tsx");
  assert.match(page, /editing\.id === r\.id\) \{\s*return <RaceForm/, "Edit opens in place of the card");
  assert.match(page, /window\.confirm\(`Delete/, "deleting asks for confirmation");
  assert.match(read("app/(app)/races/[id]/page.tsx"), /window\.confirm\(`Delete/);
  assert.match(read("app/(app)/races/[id]/page.tsx"), /isRaceId\(id\)/);
});