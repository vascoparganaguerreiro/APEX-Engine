// Task 7B.2: (a) the AI summary's "next race" follows the Races page / Today rule; (b) the pre-migration-10 fallback only runs when the
// Race Hub columns are genuinely missing, never on network, permission, auth or unrelated database errors. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BASE_RACE_COLUMNS, RACE_COLUMNS, RACE_HUB_COLUMNS, STATUSES, isMissingRaceHubColumn, listRacesCompat, nextUpcomingRace,
  nextUpcomingRaceStrict, splitRaces, raceFromRow, type Db,
} from "../lib/races.ts";
import { runSummary, summaryConsent, type Row, type SummaryDeps } from "../lib/summaryService.ts";

type R = Record<string, unknown>;
// Error shapes as supabase-js / PostgREST return them.
const ERR = {
  missingColumn: { code: "42703", message: "column races.sport does not exist", details: null, hint: null },
  missingStatus: { code: "42703", message: "column races.status does not exist", details: null, hint: "Perhaps you meant to reference the column \"races.notes\"." },
  schemaCache: { code: "PGRST204", message: "Could not find the 'status' column of 'races' in the schema cache", details: null, hint: null },
  network: { code: "", message: "TypeError: fetch failed", details: "TypeError: fetch failed\n\nCaused by: Error: connect ECONNREFUSED (ECONNREFUSED)", hint: "" },
  timeout: { code: "57014", message: "canceling statement due to statement timeout", details: null, hint: null },
  permission: { code: "42501", message: "permission denied for table races", details: null, hint: null },
  jwtExpired: { code: "PGRST303", message: "JWT expired", details: null, hint: null },
  jwtInvalid: { code: "PGRST301", message: "No suitable key or wrong key type", details: null, hint: null },
  noTable: { code: "42P01", message: "relation \"public.races\" does not exist", details: null, hint: null },
  otherColumn: { code: "42703", message: "column races.race_date does not exist", details: null, hint: null },   // not a Race Hub column
  noCode: { message: "column races.sport does not exist" },                                                     // no code: not conclusive
};

/** Fake `races` table with the PostgREST builder methods used here. `hub` false = migration 10 not applied. `fail(cols)` injects an error
 *  for a given select. Records every select so tests can prove whether the legacy query ran. */
function fakeDb(rows: R[], o: { hub: boolean; fail?: (cols: string) => unknown }): Db & { selects: string[] } {
  const selects: string[] = [];
  return {
    selects,
    from(t: string) {
      assert.equal(t, "races");
      let cols = "", gte: [string, string] | null = null, lim: number | null = null; const ins: Array<[string, unknown[]]> = [];
      const run = async () => {
        const injected = o.fail?.(cols);
        if (injected) return { data: null, error: injected };
        const wantsHub = cols.split(",").some((c) => RACE_HUB_COLUMNS.includes(c));
        if (wantsHub && !o.hub) return { data: null, error: ERR.missingColumn };
        if (!o.hub && ins.length) return { data: null, error: ERR.missingStatus };
        let out = rows.filter((r) => (!gte || String(r[gte[0]]) >= gte[1]) && ins.every(([c, vs]) => vs.includes(r[c])))
          .sort((a, b) => String(a.race_date).localeCompare(String(b.race_date)) || String(a.priority).localeCompare(String(b.priority)));
        if (lim !== null) out = out.slice(0, lim);
        return { data: out.map((r) => Object.fromEntries(cols.split(",").filter((c) => c in r).map((c) => [c, r[c]]))), error: null };
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select(c: string) { cols = c; selects.push(c); return b; },
        gte(c: string, v: string) { gte = [c, v]; return b; },
        in(c: string, vs: unknown[]) { ins.push([c, vs]); return b; },
        order() { return b; },
        limit(n: number) { lim = n; return b; },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return run().then(res, rej); },
      };
      return b;
    },
  };
}

const TODAY = "2026-11-12";
let nid = 1;
const hub = (o: R): R => ({ id: nid++, name: "Race", race_date: "2026-11-20", race_type: "10k", priority: "B", goal: null, notes: null, sport: "running", location: null, distance: null, distance_unit: null, target_time_s: null, status: "planned", ...o });
const legacy = (o: R): R => { const { sport: _s, location: _l, distance: _d, distance_unit: _u, target_time_s: _t, status: _st, ...base } = hub(o); return base; };

// ------------------------------------------------------------------ next race selection (every status, past and future, none)
test("next race: only planned or registered races on or after today; every other status and every past race is excluded", async () => {
  for (const status of STATUSES) {
    for (const [date, label] of [["2026-11-10", "past"], [TODAY, "today"], ["2026-12-01", "future"]] as const) {
      const r = await nextUpcomingRaceStrict(fakeDb([hub({ name: `${status}-${label}`, race_date: date, status })], { hub: true }), TODAY);
      const eligible = (status === "planned" || status === "registered") && label !== "past";
      assert.equal(r?.name ?? null, eligible ? `${status}-${label}` : null, `${status} race ${label}`);
    }
  }
});

test("next race: the soonest eligible race wins over earlier completed, DNF, DNS, cancelled and past races, and matches the Races page", async () => {
  const rows = [
    hub({ name: "Past planned", race_date: "2026-11-01" }), hub({ name: "Cancelled", race_date: "2026-11-13", status: "cancelled" }),
    hub({ name: "Completed", race_date: TODAY, status: "completed" }), hub({ name: "DNF", race_date: "2026-11-14", status: "dnf" }),
    hub({ name: "DNS", race_date: "2026-11-15", status: "dns" }), hub({ name: "Next B", race_date: "2026-11-21", priority: "B" }),
    hub({ name: "Next A", race_date: "2026-11-21", priority: "A", status: "registered" }), hub({ name: "Later", race_date: "2027-03-01" }),
  ];
  const r = await nextUpcomingRaceStrict(fakeDb(rows, { hub: true }), TODAY);
  assert.equal(r?.name, "Next A", "same date: priority A first, exactly like the Races page");
  assert.equal(splitRaces(rows.map(raceFromRow), TODAY).upcoming[0].name, r?.name, "identical to the Races page's first upcoming race");
});

test("next race: none qualifies -> null (never invented)", async () => {
  assert.equal(await nextUpcomingRaceStrict(fakeDb([], { hub: true }), TODAY), null);
  const onlyClosed = ["completed", "dnf", "dns", "cancelled"].map((s, i) => hub({ race_date: `2026-12-0${i + 1}`, status: s }));
  assert.equal(await nextUpcomingRaceStrict(fakeDb([...onlyClosed, hub({ race_date: "2026-01-01" })], { hub: true }), TODAY), null);
});

test("next race before migration 10: original columns, status defaults to planned (as everywhere else), past races still excluded", async () => {
  const db = fakeDb([legacy({ name: "Old past", race_date: "2026-10-01" }), legacy({ name: "Legacy next", race_date: "2026-11-30" })], { hub: false });
  const r = await nextUpcomingRaceStrict(db, TODAY);
  assert.equal(r?.name, "Legacy next"); assert.equal(r?.status, "planned");
  assert.equal(db.selects.at(-1), BASE_RACE_COLUMNS);
  assert.equal(await nextUpcomingRaceStrict(fakeDb([legacy({ race_date: "2026-10-01" })], { hub: false }), TODAY), null);
});

test("next race: genuine errors are thrown by the strict reader (no legacy retry); the Coach page wrapper still shows no card", async () => {
  for (const e of [ERR.network, ERR.permission, ERR.jwtExpired, ERR.timeout]) {
    const db = fakeDb([hub({})], { hub: true, fail: () => e });
    await assert.rejects(nextUpcomingRaceStrict(db, TODAY));
    assert.equal(db.selects.length, 1, "the legacy query never ran");
    assert.equal(await nextUpcomingRace(fakeDb([hub({})], { hub: true, fail: () => e }), TODAY), null);
  }
});

// ------------------------------------------------------------------ the summary uses that rule
const ROWS: Row[] = [
  { id: 1, started_at: "2026-11-03T07:00:00Z", sport: "run", title: "Easy", duration_s: 3000, distance_m: 10000, avg_hr: 140, load: 50, note: null },
  { id: 2, started_at: "2026-11-05T07:00:00Z", sport: "run", title: "Tempo", duration_s: 3000, distance_m: 11000, avg_hr: 160, load: 70, note: null },
];
function summaryDeps(db: Db, seen: string[]): SummaryDeps {
  return {
    timezone: async () => "UTC",
    getActivity: async (id) => ROWS.find((r) => r.id === id) ?? null,
    activities: async () => ROWS,
    dailyOn: async () => null, dailyAvg: async () => ({ hrv: null, rhr: null, sleepH: null }),
    // exactly what app/api/summarize/route.ts wires in
    nextRace: async (today) => { seen.push(today); const x = await nextUpcomingRaceStrict(db, today); return x ? { name: x.name, race_date: x.race_date } : null; },
    consume: async () => ({ allowed: true, retryAfterSeconds: 0, usageId: "u1" }),
    recordOutcome: async () => undefined,
    ask: async (p) => { seen.push(p); return { text: "ok", model: "m" }; },
    saveActivitySummary: async () => undefined, saveWeekSummary: async () => undefined,
    now: () => new Date(`${TODAY}T09:00:00Z`),
  };
}
const RACES_OK = summaryConsent(["activities", "races"], "yes");

test("weekly summary: a cancelled, DNS, completed or past race is never described as the next race", async () => {
  const rows = [
    hub({ name: "Between week end and today", race_date: "2026-11-10" }),     // after the summarised week (ends 11-08) but already past
    hub({ name: "Cancelled soon", race_date: "2026-11-13", status: "cancelled" }), hub({ name: "DNS soon", race_date: "2026-11-14", status: "dns" }),
    hub({ name: "Completed", race_date: TODAY, status: "completed" }), hub({ name: "Real next", race_date: "2026-11-17", status: "registered" }),
  ];
  const seen: string[] = [];
  await runSummary(summaryDeps(fakeDb(rows, { hub: true }), seen), { kind: "week", weekStart: "2026-11-02" }, RACES_OK);
  assert.equal(seen[0], TODAY, "the next race is looked up from today, not from the summarised week");
  const prompt = seen.at(-1)!;
  assert.match(prompt, /Next race: Real next in 5 days/);
  for (const n of ["Between week end", "Cancelled soon", "DNS soon", "Completed"]) assert.ok(!prompt.includes(n), n);
});

test("activity summary: same rule; with no eligible race the prompt says none (nothing invented)", async () => {
  const seen: string[] = [];
  await runSummary(summaryDeps(fakeDb([hub({ status: "cancelled" }), hub({ race_date: "2026-01-01" })], { hub: true }), seen), { kind: "activity", id: 2 }, RACES_OK);
  assert.match(seen.at(-1)!, /Next race: none registered/);
});

test("summary before migration 10: the legacy fallback still finds the next race", async () => {
  const seen: string[] = [];
  await runSummary(summaryDeps(fakeDb([legacy({ name: "Legacy race", race_date: "2026-11-22" })], { hub: false }), seen), { kind: "week", weekStart: "2026-11-02" }, RACES_OK);
  assert.match(seen.at(-1)!, /Next race: Legacy race in 10 days/);
});

test("summary: if races cannot be read, the race line is left out, never replaced by 'none registered'", async () => {
  const seen: string[] = [];
  await runSummary(summaryDeps(fakeDb([hub({})], { hub: true, fail: () => ERR.network }), seen), { kind: "week", weekStart: "2026-11-02" }, RACES_OK);
  assert.ok(!/Next race/.test(seen.at(-1)!));
});

test("wiring: the summary route uses the shared next-race reader", () => {
  const route = readFileSync(new URL("../app/api/summarize/route.ts", import.meta.url), "utf8");
  assert.match(route, /nextUpcomingRaceStrict\(sb as unknown as RaceDb, today\)/);
  assert.ok(!/from\("races"\)/.test(route), "no separate race query that could ignore the status");
});

// ------------------------------------------------------------------ fallback only on a genuinely missing migration-10 column
test("missing-column classification: only 42703 / PGRST204 naming a Race Hub column", () => {
  assert.deepEqual(RACE_HUB_COLUMNS, ["sport", "location", "distance", "distance_unit", "target_time_s", "status"]);
  assert.equal(isMissingRaceHubColumn(ERR.missingColumn), true);
  assert.equal(isMissingRaceHubColumn(ERR.missingStatus), true);
  assert.equal(isMissingRaceHubColumn(ERR.schemaCache), true);
  assert.equal(isMissingRaceHubColumn({ code: "42703", message: "column \"distance_unit\" does not exist" }), true);
  for (const [k, e] of Object.entries({ network: ERR.network, timeout: ERR.timeout, permission: ERR.permission, jwtExpired: ERR.jwtExpired, jwtInvalid: ERR.jwtInvalid, noTable: ERR.noTable, otherColumn: ERR.otherColumn, noCode: ERR.noCode })) {
    assert.equal(isMissingRaceHubColumn(e), false, k);
  }
  for (const e of [null, undefined, "column races.sport does not exist", 42703, {}]) assert.equal(isMissingRaceHubColumn(e), false);
  assert.equal(isMissingRaceHubColumn({ code: "42703", message: "column races.distance_kmx does not exist" }), false, "a different column with a similar name");
});

test("listRacesCompat: a genuine missing-column error triggers the legacy query", async () => {
  const db = fakeDb([legacy({ name: "Old" })], { hub: false });
  const r = await listRacesCompat(db);
  assert.equal(r.legacy, true); assert.equal(r.races[0].name, "Old"); assert.deepEqual(db.selects, [RACE_COLUMNS, BASE_RACE_COLUMNS]);
});

test("listRacesCompat: the schema-cache missing-column error triggers the legacy query", async () => {
  const db = fakeDb([legacy({ name: "Old" })], { hub: true, fail: (c) => (c === RACE_COLUMNS ? ERR.schemaCache : null) });
  const r = await listRacesCompat(db);
  assert.equal(r.legacy, true); assert.deepEqual(db.selects, [RACE_COLUMNS, BASE_RACE_COLUMNS]);
});

for (const [name, e] of [["network failure", ERR.network], ["timeout", ERR.timeout], ["permission failure", ERR.permission], ["expired session", ERR.jwtExpired],
  ["invalid token", ERR.jwtInvalid], ["unrelated database failure (no table)", ERR.noTable], ["missing non-Race-Hub column", ERR.otherColumn], ["error without a code", ERR.noCode]] as const) {
  test(`listRacesCompat: ${name} is reported as an error and does NOT trigger the legacy query`, async () => {
    const db = fakeDb([hub({})], { hub: true, fail: (c) => (c === RACE_COLUMNS ? e : null) });
    await assert.rejects(listRacesCompat(db), (err: Error) => err.message === e.message);
    assert.deepEqual(db.selects, [RACE_COLUMNS], "only the full query ran");
  });
}

test("listRacesCompat: a persistent failure of the legacy query is reported", async () => {
  const db = fakeDb([], { hub: false, fail: (c) => (c === BASE_RACE_COLUMNS ? ERR.permission : null) });
  await assert.rejects(listRacesCompat(db), /permission denied/);
  assert.deepEqual(db.selects, [RACE_COLUMNS, BASE_RACE_COLUMNS]);
});

test("listRacesCompat: after migration 10 no fallback is attempted", async () => {
  const db = fakeDb([hub({ status: "registered" })], { hub: true });
  const r = await listRacesCompat(db);
  assert.equal(r.legacy, false); assert.equal(r.races[0].status, "registered"); assert.deepEqual(db.selects, [RACE_COLUMNS]);
});
