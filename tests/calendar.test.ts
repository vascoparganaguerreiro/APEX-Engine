// Training Calendar Phase 1: dates/DST, validation, linking (no double link), ownership, migration-15-missing behaviour, Today integration.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildDays, detailOf, linkProblem, monthGrid, monthLabel, normalizePlanned, plannedCounts, shiftMonth, suggestMatches, validatePlanned, validateStructure,
  viewRange, weekDays, weekLabel, type DoneActivity, type DoneStrength, type PlannedInput, type PlannedWorkout,
} from "../lib/calendar/model.ts";
import {
  createPlanned, deletePlanned, linkPlanned, listPlanned, markCompleted, markSkipped, reopenPlanned, updatePlanned, writablePlanned, isMissingPlannedTable,
} from "../lib/calendar/data.ts";
import { fiveDays } from "../lib/today/model.ts";
import { SafeError } from "../lib/userError.ts";
import type { Race } from "../lib/races.ts";

const TODAY = "2026-11-12";
const SQL = readFileSync(new URL("../15_training_calendar.sql", import.meta.url), "utf8");

// ------------------------------------------------------------------ fixtures
const plan = (o: Partial<PlannedWorkout> = {}): PlannedWorkout => ({
  id: "p1", planned_date: "2026-11-12", kind: "endurance", sport: "run", title: "Easy run", duration_min: 45, distance_m: null, intensity: null, routine_id: null,
  structure: null, notes: null, status: "planned", completed_at: null, completed_activity_id: null, completed_strength_session_id: null, link_origin: null, source: "manual", ...o,
});
const act = (o: Partial<DoneActivity> = {}): DoneActivity => ({ id: 10, started_at: "2026-11-12T08:00:00Z", sport: "run", title: "Morning Run", duration_s: 2700, distance_m: 8000, ...o });
const str = (o: Partial<DoneStrength> = {}): DoneStrength => ({ id: "s1", title: "Upper body", startedAt: "2026-11-12T17:00:00Z", endedAt: "2026-11-12T18:00:00Z", pausedSeconds: 0, ...o });
const input = (o: Partial<PlannedInput> = {}): PlannedInput => ({ planned_date: "2026-11-14", kind: "endurance", sport: "run", title: "Long run", duration_min: 90, distance_m: 15000, intensity: "easy", routine_id: null, structure: null, notes: null, ...o });

// ------------------------------------------------------------------ fake database (RLS-style owner filter, unique indexes, missing table)
type Row = Record<string, unknown>;
function fakeDb(o: { uid: string; rows?: Row[]; missing?: boolean }) {
  const rows: Row[] = o.rows ?? [];
  let n = 0;
  const uniqueCols = ["completed_activity_id", "completed_strength_session_id"];
  const conflict = (cand: Row, self?: Row) => uniqueCols.some((c) => cand[c] != null && rows.some((r) => r !== self && r[c] === cand[c]));
  return {
    rows,
    from(table: string) {
      assert.equal(table, "planned_workouts");
      let op = "select"; let payload: Row = {}; let single = false; const filters: Array<(r: Row) => boolean> = [];
      const b: any = {
        select() { return b; },
        insert(p: Row) { op = "insert"; payload = p; return b; },
        update(p: Row) { op = "update"; payload = p; return b; },
        delete() { op = "delete"; return b; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
        gte(c: string, v: string) { filters.push((r) => String(r[c]) >= v); return b; },
        lte(c: string, v: string) { filters.push((r) => String(r[c]) <= v); return b; },
        order() { return b; }, limit() { return b; },
        single() { single = true; return b; },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          return Promise.resolve(run()).then(res, rej);
        },
      };
      const run = () => {
        if (o.missing) return { data: null, error: { code: "42P01", message: 'relation "public.planned_workouts" does not exist' } };
        const visible = rows.filter((r) => r.user_id === o.uid && filters.every((f) => f(r)));      // RLS: own rows only
        if (op === "select") return { data: visible.map((r) => ({ ...r })), error: null };
        if (op === "insert") {
          if (payload.user_id !== o.uid) return { data: null, error: { code: "42501", message: "new row violates row-level security policy" } };
          const row: Row = { id: `n${++n}`, status: "planned", completed_at: null, completed_activity_id: null, completed_strength_session_id: null, link_origin: null, source: "manual", ...payload };
          if (conflict(row)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          rows.push(row); return { data: single ? { ...row } : [{ ...row }], error: null };
        }
        if (op === "update") {
          const out: Row[] = [];
          for (const r of visible) {
            const next = { ...r, ...payload };
            if (conflict(next, r)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint planned_workouts_activity_uq" } };
            Object.assign(r, payload); out.push({ ...r });
          }
          return { data: out, error: null };
        }
        for (const r of visible) rows.splice(rows.indexOf(r), 1);
        return { data: visible.map((r) => ({ id: r.id })), error: null };
      };
      return b;
    },
  };
}
const dbRow = (o: Row = {}): Row => ({ id: "a1", user_id: "A", planned_date: "2026-11-12", kind: "endurance", sport: "run", title: "Easy run", duration_min: 45, distance_m: null, intensity: null,
  routine_id: null, structure: null, notes: null, status: "planned", completed_at: null, completed_activity_id: null, completed_strength_session_id: null, link_origin: null, source: "manual", ...o });

// ------------------------------------------------------------------ dates and grids
test("week starts on Monday and always has 7 consecutive days", () => {
  const w = weekDays("2026-11-12");               // Thursday
  assert.equal(w[0], "2026-11-09"); assert.equal(w[6], "2026-11-15"); assert.equal(w.length, 7);
  assert.equal(weekDays("2026-11-15")[0], "2026-11-09");   // Sunday belongs to the week that started on Monday
  assert.equal(weekLabel("2026-11-12"), "9 Nov – 15 Nov 2026");
});

test("month grid: whole Monday-first weeks, covers the month, consecutive days, correct inMonth flags", () => {
  const g = monthGrid("2026-11-12");               // 1 Nov 2026 is a Sunday, 30 Nov a Monday
  assert.equal(g.length, 6);
  assert.equal(g[0][0].day, "2026-10-26"); assert.equal(g[5][6].day, "2026-12-06");
  const flat = g.flat();
  for (let i = 1; i < flat.length; i++) assert.equal(flat[i].day > flat[i - 1].day, true);
  assert.equal(flat.filter((d) => d.inMonth).length, 30);
  assert.equal(monthGrid("2026-02-10").flat().filter((d) => d.inMonth).length, 28);
  assert.equal(monthGrid("2028-02-10").flat().filter((d) => d.inMonth).length, 29);   // leap year
  assert.equal(monthLabel("2026-11-12"), "November 2026");
});

test("shiftMonth crosses year boundaries and viewRange matches the visible grid", () => {
  assert.equal(shiftMonth("2026-12-20", 1), "2027-01-01"); assert.equal(shiftMonth("2026-01-31", -1), "2025-12-01"); assert.equal(shiftMonth("2026-03-31", 1), "2026-04-01");
  assert.deepEqual(viewRange("week", "2026-11-12"), { from: "2026-11-09", to: "2026-11-15" });
  assert.deepEqual(viewRange("month", "2026-11-12"), { from: "2026-10-26", to: "2026-12-06" });
});

test("calendar dates never shift across DST: every grid day is exactly one calendar day after the previous", () => {
  for (const anchor of ["2026-03-15", "2026-10-15", "2026-11-05"]) {   // spring-forward, EU fall-back, US fall-back months
    const flat = monthGrid(anchor).flat().map((d) => d.day);
    for (let i = 1; i < flat.length; i++) assert.equal((Date.parse(flat[i]) - Date.parse(flat[i - 1])) / 86_400_000, 1);
  }
});

test("recorded sessions are placed on the user's local day (US fall-back and EU spring-forward)", () => {
  const ny = buildDays({ from: "2026-10-31", to: "2026-11-02", tz: "America/New_York", planned: [], races: [], strength: [], today: TODAY, acts: [
    act({ id: 1, started_at: "2026-11-01T03:30:00Z" }),    // 23:30 EDT on 31 Oct
    act({ id: 2, started_at: "2026-11-01T04:30:00Z" }),    // 00:30 EDT on 1 Nov (before the clocks go back)
    act({ id: 3, started_at: "2026-11-02T03:30:00Z" }),    // 22:30 EST on 1 Nov
  ] });
  assert.deepEqual(ny.map((d) => d.completed.map((c) => c.id)), [["1"], ["2", "3"], []]);
  const pt = buildDays({ from: "2026-03-28", to: "2026-03-30", tz: "Europe/Lisbon", planned: [], races: [], strength: [], today: TODAY, acts: [
    act({ id: 4, started_at: "2026-03-29T00:30:00Z" }),    // 00:30 WET on 29 Mar
    act({ id: 5, started_at: "2026-03-29T23:30:00Z" }),    // 00:30 WEST on 30 Mar
  ] });
  assert.deepEqual(pt.map((d) => d.completed.map((c) => c.id)), [[], ["4"], ["5"]]);
});

test("planned dates and race dates are plain calendar dates: they do not move with the time zone", () => {
  const race = { id: 1, name: "City 10k", race_date: "2026-11-14", race_type: "10k", sport: "running", location: null, distance: 10, distance_unit: "km", target_time_s: null, priority: "A", goal: null, notes: null, status: "registered" } as Race;
  for (const tz of ["Pacific/Auckland", "America/Los_Angeles", "UTC"]) {
    const d = buildDays({ from: "2026-11-13", to: "2026-11-15", tz, planned: [plan({ planned_date: "2026-11-14" })], races: [race], acts: [], strength: [], today: TODAY });
    assert.equal(d[1].planned.length, 1); assert.equal(d[1].races[0].name, "City 10k"); assert.equal(d[0].planned.length + d[2].planned.length, 0);
  }
});

test("planned, completed and race items are kept in separate lists; an unfinished strength workout is not 'completed'", () => {
  const d = buildDays({ from: TODAY, to: TODAY, tz: "UTC", planned: [plan()], races: [], acts: [act()], strength: [str(), str({ id: "s2", endedAt: null })], today: TODAY })[0];
  assert.equal(d.planned.length, 1); assert.deepEqual(d.completed.map((c) => c.kind + c.id), ["activity10", "strengths1"]);
  assert.equal(d.completed.every((c) => c.plannedId === null), true, "nothing is linked unless the plan says so");
});

// ------------------------------------------------------------------ validation
test("validation: dates, titles, sports, durations, kinds", () => {
  assert.equal(validatePlanned(input()), null);
  assert.match(validatePlanned(input({ planned_date: "2026-02-30" }))!, /valid date/);
  assert.match(validatePlanned(input({ planned_date: "1999-01-01" }))!, /between/);
  assert.match(validatePlanned(input({ title: "   " }))!, /title/);
  assert.match(validatePlanned(input({ title: "x".repeat(121) }))!, /120/);
  assert.match(validatePlanned(input({ sport: null }))!, /sport/);
  assert.match(validatePlanned(input({ duration_min: 0 }))!, /Duration/);
  assert.match(validatePlanned(input({ duration_min: 1.5 }))!, /Duration/);
  assert.match(validatePlanned(input({ duration_min: 1441 }))!, /Duration/);
  assert.match(validatePlanned(input({ distance_m: -1 }))!, /Distance/);
  assert.match(validatePlanned(input({ kind: "rest", sport: null }))!, /no duration or distance/);
  assert.equal(validatePlanned(input({ kind: "rest", sport: null, title: "Rest", duration_min: null, distance_m: null })), null);
  assert.equal(validatePlanned(input({ kind: "milestone", sport: null, title: "Test", duration_min: null, distance_m: null })), null);
  assert.match(validatePlanned(input({ kind: "strength", sport: "run", distance_m: null }))!, /strength sport/);
  assert.match(validatePlanned(input({ kind: "strength", sport: "strength", distance_m: 5000 }))!, /Distance only/);
  assert.match(validatePlanned(input({ routine_id: "r1" }))!, /routine/);
});

test("normalizePlanned makes the stored shape consistent with the kind", () => {
  const n = normalizePlanned(input({ kind: "strength", sport: "run", distance_m: 5000, title: "  Legs ", intensity: "  ", notes: "" }));
  assert.equal(n.sport, "strength"); assert.equal(n.distance_m, null); assert.equal(n.title, "Legs"); assert.equal(n.intensity, null); assert.equal(n.notes, null);
  assert.equal(normalizePlanned(input({ kind: "rest", sport: "run", duration_min: 30, distance_m: 1 })).duration_min, null);
});

test("future structured workouts (warm-up, intervals, recovery, cool-down) validate and round-trip", () => {
  const steps = [{ type: "warmup", duration_s: 600 }, { type: "work", duration_s: 240, repeat: 5, target: "Z4" }, { type: "recovery", duration_s: 120 }, { type: "cooldown", duration_s: 600 }];
  assert.equal(validateStructure(steps), null);
  assert.equal(validatePlanned(input({ structure: steps as never })), null);
  assert.match(validateStructure([{ type: "sprint" }])!, /unknown type/);
  assert.match(validateStructure([{ type: "work", duration_s: -5 }])!, /duration_s/);
  assert.match(validateStructure("nope")!, /list of steps/);
  assert.match(validateStructure(Array.from({ length: 101 }, () => ({ type: "steady" })))!, /at most 100/);
  assert.match(SQL, /structure\s+jsonb/); assert.match(SQL, /import_batch_id/); assert.match(SQL, /source_ref/);
});

// ------------------------------------------------------------------ linking rules
test("linkProblem: kind must match, plan must be open, a record can belong to one plan only", () => {
  const p = plan(), s = plan({ id: "p2", kind: "strength", sport: "strength", title: "Legs" });
  assert.equal(linkProblem(p, { kind: "activity", id: "10" }, [p]), null);
  assert.match(linkProblem(p, { kind: "strength", id: "s1" }, [p])!, /only be linked to an activity/);
  assert.match(linkProblem(s, { kind: "activity", id: "10" }, [s])!, /only be linked to a strength/);
  assert.match(linkProblem(plan({ kind: "rest", sport: null }), { kind: "activity", id: "10" }, [])!, /Only endurance and strength/);
  assert.match(linkProblem(plan({ status: "completed", completed_activity_id: 11 }), { kind: "activity", id: "10" }, [])!, /already linked to a recorded/);
  const taken = plan({ id: "other", status: "completed", completed_activity_id: 10 });
  assert.match(linkProblem(p, { kind: "activity", id: "10" }, [p, taken])!, /already linked to a planned/);
  assert.match(linkProblem(s, { kind: "strength", id: "s1" }, [s, plan({ id: "o2", kind: "strength", status: "completed", completed_strength_session_id: "s1" })])!, /already linked/);
});

test("suggestions need day + sport + an independent second signal; day and sport alone never suggest", () => {
  const ctx = { tz: "UTC", strength: [] as DoneStrength[] };
  // same day, same sport, but nothing else in common (30 min vs 90 min planned, unrelated title)
  assert.deepEqual(suggestMatches({ ...ctx, planned: [plan({ title: "Intervals", duration_min: 30 })], acts: [act({ title: "Morning Run", duration_s: 5400 })] }), []);
  // no planned duration/distance and no shared word: still nothing
  assert.deepEqual(suggestMatches({ ...ctx, planned: [plan({ title: "Intervals", duration_min: null })], acts: [act()] }), []);
  // similar duration: suggested, with reasons, and nothing is applied
  const s = suggestMatches({ ...ctx, planned: [plan()], acts: [act()] });
  assert.equal(s.length, 1); assert.equal(s[0].plannedId, "p1"); assert.equal(s[0].recordId, "10"); assert.ok(s[0].reasons.some((r) => /similar duration/.test(r)));
  // shared title word is also a valid second signal
  assert.equal(suggestMatches({ ...ctx, planned: [plan({ title: "Morning run", duration_min: null })], acts: [act()] }).length, 1);
});

test("suggestions respect day, sport, kind, and never reuse a record", () => {
  const ctx = { tz: "UTC", strength: [] as DoneStrength[] };
  assert.equal(suggestMatches({ ...ctx, planned: [plan({ planned_date: "2026-11-13" })], acts: [act()] }).length, 0, "different day");
  assert.equal(suggestMatches({ ...ctx, planned: [plan({ sport: "bike" })], acts: [act()] }).length, 0, "different sport");
  assert.equal(suggestMatches({ ...ctx, planned: [plan()], acts: [act({ sport: "strength" })] }).length, 0, "a strength activity never matches an endurance plan");
  assert.equal(suggestMatches({ ...ctx, planned: [plan({ status: "skipped" })], acts: [act()] }).length, 0, "closed plans are not matched");
  assert.equal(suggestMatches({ ...ctx, planned: [plan(), plan({ id: "other", status: "completed", completed_activity_id: 10 })], acts: [act()] }).length, 0, "linked record is skipped");
  // two similar plans, one activity: only one plan gets it
  const two = suggestMatches({ ...ctx, planned: [plan({ id: "a" }), plan({ id: "b" })], acts: [act()] });
  assert.equal(two.length, 1);
  // time zone decides the day of the recording
  assert.equal(suggestMatches({ tz: "Pacific/Auckland", strength: [], planned: [plan()], acts: [act({ started_at: "2026-11-12T12:00:00Z" })] }).length, 0, "12:00Z is already 13 Nov in Auckland");
});

test("strength plans match finished strength workouts only", () => {
  const sp = plan({ id: "sp", kind: "strength", sport: "strength", title: "Upper body", duration_min: 60 });
  const s = suggestMatches({ tz: "UTC", planned: [sp], acts: [act()], strength: [str()] });
  assert.equal(s.length, 1); assert.equal(s[0].kind, "strength"); assert.equal(s[0].recordId, "s1");
  assert.equal(suggestMatches({ tz: "UTC", planned: [sp], acts: [], strength: [str({ endedAt: null })] }).length, 0);
});

// ------------------------------------------------------------------ data layer: one completed session can never be linked twice
test("a completed session cannot be linked to two plans (client check, then the database unique index)", async () => {
  const db = fakeDb({ uid: "A", rows: [dbRow({ id: "a1" }), dbRow({ id: "a2" })] });
  const all = await listPlanned(db, "2026-11-01", "2026-11-30");
  const [p1, p2] = all;
  const linked = await linkPlanned(db, p1, { kind: "activity", id: "10" }, all, "confirmed_match", new Date("2026-11-12T10:00:00Z"));
  assert.equal(linked.status, "completed"); assert.equal(linked.completed_activity_id, 10); assert.equal(linked.link_origin, "confirmed_match");
  // 1) with fresh data the model refuses with a clear message
  const fresh = await listPlanned(db, "2026-11-01", "2026-11-30");
  await assert.rejects(() => linkPlanned(db, fresh[1], { kind: "activity", id: "10" }, fresh, "manual"), (e: unknown) => e instanceof SafeError && /already linked to a planned/.test(e.message));
  // 2) with STALE data (another tab linked it meanwhile) the unique index is the guarantee, and the message is the same
  await assert.rejects(() => linkPlanned(db, p2, { kind: "activity", id: "10" }, [p2], "manual"), (e: unknown) => e instanceof SafeError && /already linked to a planned/.test(e.message) && !/unique|constraint|duplicate/i.test(e.message));
  assert.equal(db.rows.filter((r) => r.completed_activity_id === 10).length, 1);
  // the same plan cannot be linked a second time either
  await assert.rejects(() => linkPlanned(db, linked, { kind: "activity", id: "11" }, fresh, "manual"), (e: unknown) => e instanceof SafeError && /already linked/.test(e.message));
});

test("same rule for strength sessions; reopening a plan frees the record again", async () => {
  const db = fakeDb({ uid: "A", rows: [dbRow({ id: "s-a", kind: "strength", sport: "strength" }), dbRow({ id: "s-b", kind: "strength", sport: "strength" })] });
  const all = await listPlanned(db, "2026-11-01", "2026-11-30");
  const first = await linkPlanned(db, all[0], { kind: "strength", id: "11111111-1111-1111-1111-111111111111" }, all, "manual");
  await assert.rejects(() => linkPlanned(db, all[1], { kind: "strength", id: "11111111-1111-1111-1111-111111111111" }, [all[1]], "manual"), /already linked/);
  const reopened = await reopenPlanned(db, first.id);
  assert.equal(reopened.status, "planned"); assert.equal(reopened.completed_strength_session_id, null); assert.equal(reopened.link_origin, null);
  const again = await linkPlanned(db, all[1], { kind: "strength", id: "11111111-1111-1111-1111-111111111111" }, await listPlanned(db, "2026-11-01", "2026-11-30"), "manual");
  assert.equal(again.status, "completed");
});

test("manual completion and skip change status only; they never create a link, and skip/reopen clear any link", async () => {
  const db = fakeDb({ uid: "A", rows: [dbRow({ id: "a1" }), dbRow({ id: "a2", status: "completed", completed_activity_id: 7, link_origin: "manual" })] });
  const done = await markCompleted(db, "a1", new Date("2026-11-12T10:00:00Z"));
  assert.equal(done.status, "completed"); assert.equal(done.completed_activity_id, null); assert.equal(done.completed_strength_session_id, null); assert.equal(done.completed_at, "2026-11-12T10:00:00.000Z");
  const skipped = await markSkipped(db, "a2");
  assert.equal(skipped.status, "skipped"); assert.equal(skipped.completed_activity_id, null);
});

// ------------------------------------------------------------------ ownership / RLS expectations
test("ownership: create stamps the caller as owner; other users cannot read, edit, delete or complete someone else's plan", async () => {
  const dbA = fakeDb({ uid: "A" });
  const made = await createPlanned(dbA, "A", input());
  assert.equal(dbA.rows[0].user_id, "A");
  const rows = dbA.rows;
  const dbB = fakeDb({ uid: "B", rows });
  assert.deepEqual(await listPlanned(dbB, "2026-01-01", "2026-12-31"), []);
  await assert.rejects(() => updatePlanned(dbB, made.id, input({ title: "Hijack" })), /not found/);
  await assert.rejects(() => deletePlanned(dbB, made.id), /not found/);
  await assert.rejects(() => markCompleted(dbB, made.id), /not found/);
  assert.equal(rows[0].title, "Long run"); assert.equal(rows.length, 1);
  await assert.rejects(() => createPlanned(fakeDb({ uid: "B" }), "A", input()), SafeError, "a row stamped with another user's id is refused by the policy");
});

test("create/update can only write the form's columns: user_id, status and link columns are dropped", () => {
  const w = writablePlanned({ ...input(), user_id: "evil", status: "completed", completed_activity_id: 1, completed_strength_session_id: "x", link_origin: "manual", id: "zzz", source: "import", import_batch_id: "b" });
  assert.deepEqual(Object.keys(w).sort(), ["distance_m", "duration_min", "intensity", "kind", "notes", "planned_date", "routine_id", "sport", "structure", "title"]);
});

test("migration 15 SQL encodes the ownership and no-double-link guarantees", () => {
  assert.match(SQL, /enable row level security/);
  assert.match(SQL, /create policy "own planned workouts"[\s\S]*using \(user_id = \(select auth\.uid\(\)\)\)[\s\S]*with check \(user_id = \(select auth\.uid\(\)\)/);
  assert.match(SQL, /strength_routines r where r\.id = routine_id and r\.user_id/);
  assert.match(SQL, /activities a where a\.id = completed_activity_id and a\.user_id/);
  assert.match(SQL, /strength_sessions s where s\.id = completed_strength_session_id and s\.user_id/);
  assert.match(SQL, /unique index if not exists planned_workouts_activity_uq[^;]*where completed_activity_id is not null/);
  assert.match(SQL, /unique index if not exists planned_workouts_strength_uq[^;]*where completed_strength_session_id is not null/);
  assert.match(SQL, /planned_workouts_one_source/); assert.match(SQL, /planned_workouts_link_status/); assert.match(SQL, /planned_workouts_link_kind/);
  assert.match(SQL, /revoke all on public\.planned_workouts from public, anon, authenticated/);
  assert.match(SQL, /grant select, insert, update, delete on public\.planned_workouts to authenticated/);
  assert.doesNotMatch(SQL, /to anon|to public/i);
});

test("migration 15 is additive: no change to any existing table, column, policy or row", () => {
  const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /alter table(?! public\.planned_workouts)/i);
  assert.doesNotMatch(code, /\b(drop table|truncate|delete from|update public\.(?!planned_workouts))/i);
  assert.doesNotMatch(code, /insert into/i);
  assert.match(code, /create table if not exists public\.planned_workouts/);
});

// ------------------------------------------------------------------ migration 15 not applied
test("without migration 15: loading and writing give the 'not set up' state, never a raw database error", async () => {
  const db = fakeDb({ uid: "A", missing: true });
  for (const call of [() => listPlanned(db, "2026-11-01", "2026-11-30"), () => createPlanned(db, "A", input()), () => deletePlanned(db, "x"), () => markCompleted(db, "x")]) {
    await assert.rejects(call, (e: unknown) => e instanceof SafeError && e.kind === "not-set-up" && !/relation|planned_workouts|42P01/i.test(e.message));
  }
  assert.equal(isMissingPlannedTable({ code: "42P01" }), true); assert.equal(isMissingPlannedTable({ code: "PGRST205" }), true);
  assert.equal(isMissingPlannedTable({ code: "42501", message: "does not exist" }), false, "decided from the code, never from message text");
});

test("calendar with no planned data still builds from races and recorded sessions alone", () => {
  const d = buildDays({ from: TODAY, to: TODAY, tz: "UTC", planned: [], races: [], acts: [act()], strength: [], today: TODAY })[0];
  assert.equal(d.planned.length, 0); assert.equal(d.completed.length, 1);
});

// ------------------------------------------------------------------ Today integration
const base = { today: TODAY, tz: "UTC", races: [] as Race[], acts: [], strength: [], activeWorkout: null, sups: [], schedules: [], supToday: null };

test("Today: without planned data (migration 15 missing) the five-day strip is exactly what it was", () => {
  assert.deepEqual(fiveDays(base), fiveDays({ ...base, planned: [] }));
  assert.equal(fiveDays(base).every((d) => d.items.length === 0), true);
});

test("Today: planned workouts appear on their day, with status, and only inside the five days", () => {
  const days = fiveDays({ ...base, planned: [
    { id: "a", planned_date: "2026-11-13", kind: "endurance", sport: "run", title: "Tempo", duration_min: 50, status: "planned" },
    { id: "b", planned_date: "2026-11-12", kind: "strength", sport: "strength", title: "Legs", duration_min: null, status: "skipped" },
    { id: "c", planned_date: "2026-11-20", kind: "endurance", sport: "bike", title: "Far away", duration_min: 60, status: "planned" },
    { id: "d", planned_date: "2026-11-14", kind: "endurance", sport: "run", title: "Done by hand", duration_min: 30, status: "completed" },
  ] });
  assert.equal(days[1].items[0].title, "Tempo"); assert.equal(days[1].items[0].status, "planned"); assert.equal(days[1].items[0].kind, "planned");
  assert.equal(days[0].items[0].status, "skipped"); assert.equal(days[2].items[0].status, "done");
  assert.equal(days.flatMap((d) => d.items).some((i) => i.title === "Far away"), false);
  assert.match(days[1].items[0].detail, /Run · 50 min/);
});

test("Today: a plan linked to a recorded session is not repeated (the real record shows instead)", () => {
  const days = fiveDays({ ...base, acts: [{ id: 10, started_at: "2026-11-12T08:00:00Z", sport: "run", title: "Morning Run", duration_s: 2700, distance_m: 8000, load: 40 }],
    planned: [{ id: "a", planned_date: TODAY, kind: "endurance", sport: "run", title: "Easy run", duration_min: 45, status: "completed", linked: true }] });
  assert.deepEqual(days[0].items.map((i) => i.title), ["Morning Run"]);
});

test("Today: races and existing items are unaffected by planned data", () => {
  const race = { id: 1, name: "City 10k", race_date: "2026-11-14", race_type: "10k", sport: "running", location: null, distance: 10, distance_unit: "km", target_time_s: null, priority: "A", goal: null, notes: null, status: "registered" } as Race;
  const without = fiveDays({ ...base, races: [race] }), withPlan = fiveDays({ ...base, races: [race], planned: [{ id: "a", planned_date: "2026-11-14", kind: "endurance", sport: "run", title: "Shakeout", duration_min: 20, status: "planned" }] });
  assert.deepEqual(withPlan[2].items.filter((i) => i.kind === "race"), without[2].items);
});

// ------------------------------------------------------------------ scientific constraints
test("planned data never produces a load figure and the calendar model does not touch load or readiness code", () => {
  const c = plannedCounts([plan(), plan({ id: "q", status: "completed" }), plan({ id: "r", status: "skipped" }), plan({ id: "s", kind: "rest", sport: null, duration_min: null })], ["2026-11-12"]);
  assert.deepEqual(Object.keys(c).sort(), ["completed", "planned", "plannedMinutes", "skipped"]);
  assert.equal(c.planned, 1); assert.equal(c.completed, 1); assert.equal(c.skipped, 1); assert.equal(c.plannedMinutes, 45);
  for (const f of ["../lib/calendar/model.ts", "../lib/calendar/data.ts", "../lib/calendar/load.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /banister|trendSeries|dailyLoads|projectTsb|readinessEstimate|readiness\(|\btsb\b|\bctl\b|\batl\b/i, `${f} must not use load or readiness calculations`);
  }
  assert.doesNotMatch(readFileSync(new URL("../app/(app)/training/page.tsx", import.meta.url), "utf8"), /banister|trendSeries|dailyLoads|readiness/i);
});

test("nothing in the calendar writes plans automatically: every write function is called only from explicit user actions", () => {
  const page = readFileSync(new URL("../app/(app)/training/page.tsx", import.meta.url), "utf8");
  const effects = page.match(/useEffect\([\s\S]*?\}, \[[^\]]*\]\);/g) ?? [];
  for (const e of effects) assert.doesNotMatch(e, /createPlanned|updatePlanned|deletePlanned|markCompleted|markSkipped|linkPlanned|reopenPlanned/, "effects only read");
  assert.equal(detailOf(plan({ intensity: "Z2", distance_m: 8000 })), "Run · 45 min · 8 km · Z2");
});
