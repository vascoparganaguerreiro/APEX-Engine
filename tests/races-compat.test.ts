// P1.1: Races load, create, edit and delete with and without migration 10, with friendly errors and no silently lost fields.
// An in-memory `races` table with row-level ownership (a row is visible and writable only to its user_id). Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BASE_RACE_COLUMNS, LEGACY_SPORTS, RACE_HUB_COLUMNS, createRace, deleteRace, getRaceCompat, legacyBlocker, legacySport, listRaces, listRacesCompat, updateRace, type Db, type RaceInput,
} from "../lib/races.ts";
import { NOT_SET_UP_MESSAGE, SafeError } from "../lib/userError.ts";

type R = Record<string, unknown>;
const LEAKS = /SELECT|relation|column|schema cache|PGRST|42703|42501|JWT|TypeError|fetch failed|races\.sport|public\.|migration|\.sql/i;

/** `hub` false = migration 10 not applied (any use of a Race Hub column is a 42703, as Postgres answers it). `failWith` injects one error. */
function table(o: { hub: boolean; uid: string; failWith?: unknown; seed?: R[] }) {
  const rows: R[] = (o.seed ?? []).map((r) => ({ ...r }));
  let nextId = 100;
  const log: Array<{ op: string; cols: string; payload: R }> = [];
  const db: Db = {
    from(t: string) {
      assert.equal(t, "races");
      let op = "select", cols = "", payload: R = {}, single = "";
      const eqs: Array<[string, unknown]> = [];
      const run = async () => {
        log.push({ op, cols, payload });
        if (o.failWith) return { data: null, error: o.failWith };
        const used = [...Object.keys(payload), ...cols.split(",").filter(Boolean)];
        const bad = used.find((c) => RACE_HUB_COLUMNS.includes(c));
        if (bad && !o.hub) return { data: null, error: { code: "42703", message: `column races.${bad} does not exist`, details: null, hint: null } };
        const project = (r: R) => Object.fromEntries(cols.split(",").filter((c) => c in r).map((c) => [c, r[c]]));
        const mine = () => rows.filter((r) => r.user_id === o.uid && eqs.every(([c, v]) => r[c] === v));
        let out: R[];
        if (op === "insert") {
          if (payload.user_id !== o.uid) return { data: null, error: { code: "42501", message: 'new row violates row-level security policy for table "races"' } };
          const row: R = { id: nextId++, goal: null, notes: null, ...payload, ...(o.hub ? { sport: "other", location: null, distance: null, distance_unit: null, target_time_s: null, status: "planned", ...payload } : {}) };
          rows.push(row); out = [row];
        } else if (op === "update") { out = mine(); for (const r of out) Object.assign(r, payload); }
        else if (op === "delete") { out = mine(); for (const r of out) rows.splice(rows.indexOf(r), 1); }
        else out = mine().sort((a, b) => String(a.race_date).localeCompare(String(b.race_date)));
        const data = out.map(cols ? project : (r) => ({ id: r.id }));
        if (single === "single") return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
        if (single === "maybe") return { data: data[0] ?? null, error: null };
        return { data, error: null };
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select(c: string) { cols = c; return b; }, insert(p: R) { op = "insert"; payload = p; return b; }, update(p: R) { op = "update"; payload = p; return b; }, delete() { op = "delete"; return b; },
        eq(c: string, v: unknown) { eqs.push([c, v]); return b; }, order() { return b; }, single() { single = "single"; return b; }, maybeSingle() { single = "maybe"; return b; },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return run().then(res, rej); },
      };
      return b;
    },
  };
  return { db, rows, log };
}

const base = (o: R): R => ({ id: 1, user_id: "u1", name: "Old race", race_date: "2026-12-05", race_type: "marathon", priority: "A", goal: "Finish strong", notes: "Bring gels", ...o });
const input = (o: Partial<RaceInput> = {}): RaceInput => ({
  name: "New race", race_date: "2026-12-20", race_type: "10k", sport: "running", location: null, distance: null, distance_unit: null, target_time_s: null, priority: "B",
  goal: null, notes: null, status: "planned", ...o,
});
const noLeak = (e: unknown) => { assert.ok(e instanceof SafeError, String(e)); assert.ok(!LEAKS.test((e as Error).message), (e as Error).message); return e as SafeError; };

// ------------------------------------------------------------------ before migration 10
test("before migration 10: the list loads from the original columns, flagged legacy, with sport derived from race_type (as migration 10 would)", async () => {
  const { db, log } = table({ hub: false, uid: "u1", seed: [base({}), base({ id: 2, race_type: "ironman", race_date: "2027-06-01" }), base({ id: 3, race_type: "other", race_date: "2027-07-01" }), base({ id: 4, user_id: "u2", name: "Not mine" })] });
  const r = await listRacesCompat(db);
  assert.equal(r.legacy, true);
  assert.deepEqual(r.races.map((x) => [x.name, x.sport, x.status, x.location]), [["Old race", "running", "planned", null], ["Old race", "triathlon", "planned", null], ["Old race", "other", "planned", null]]);
  assert.equal(r.races.some((x) => x.name === "Not mine"), false, "another account's race is never visible");
  assert.equal(log.length, 2, "the full query is tried once, then the original columns");
  assert.equal(log[1].cols, BASE_RACE_COLUMNS);
  assert.deepEqual([legacySport("marathon"), legacySport("half_marathon"), legacySport("10k"), legacySport("trail"), legacySport("cycling"), legacySport("triathlon_sprint"), legacySport("half_ironman"), legacySport("zzz")],
    ["running", "running", "running", "running", "cycling", "triathlon", "triathlon", "other"]);
  assert.deepEqual([...LEGACY_SPORTS], ["running", "cycling", "triathlon", "other"]);
});

test("before migration 10: one race loads (detail page); a missing or foreign race is null, not an error", async () => {
  const { db } = table({ hub: false, uid: "u1", seed: [base({}), base({ id: 4, user_id: "u2" })] });
  const a = await getRaceCompat(db, 1); assert.deepEqual([a.legacy, a.race?.name, a.race?.sport, a.race?.goal, a.race?.notes], [true, "Old race", "running", "Finish strong", "Bring gels"]);
  assert.deepEqual(await getRaceCompat(db, 999), { race: null, legacy: true });
  assert.equal((await getRaceCompat(db, 4)).race, null, "RLS: another account's race is not found");
});

test("before migration 10: creating a race writes only the original columns, as the signed-in user, and loses nothing", async () => {
  const { db, rows, log } = table({ hub: false, uid: "u1" });
  const made = await createRace(db, "u1", input({ name: "Lisbon 10K", goal: "Sub 50", notes: "Flat course" }), { legacy: true });
  assert.deepEqual([made.name, made.sport, made.race_type, made.goal, made.notes, made.priority], ["Lisbon 10K", "running", "10k", "Sub 50", "Flat course", "B"]);
  const insert = log.find((l) => l.op === "insert")!;
  assert.deepEqual(Object.keys(insert.payload).sort(), ["goal", "name", "notes", "priority", "race_date", "race_type", "user_id"]);
  assert.equal(insert.payload.user_id, "u1");
  assert.equal(rows.length, 1);
  assert.ok(!RACE_HUB_COLUMNS.some((c) => c in rows[0]), "no Race Hub column was written");
});

test("before migration 10: editing keeps every original field and never touches another account's race", async () => {
  const { db, rows } = table({ hub: false, uid: "u1", seed: [base({}), base({ id: 4, user_id: "u2", name: "Theirs" })] });
  const edited = await updateRace(db, 1, input({ name: "Old race (renamed)", race_type: "marathon", priority: "A", goal: "New goal", notes: "New notes", race_date: "2026-12-06" }), { legacy: true });
  assert.deepEqual([edited.name, edited.goal, edited.notes, edited.race_date, edited.sport], ["Old race (renamed)", "New goal", "New notes", "2026-12-06", "running"]);
  assert.equal(rows.find((r) => r.id === 4)!.name, "Theirs");
  assert.equal(rows.find((r) => r.id === 1)!.user_id, "u1", "user_id is never rewritten");
  await assert.rejects(updateRace(db, 4, input(), { legacy: true }), (e: unknown) => noLeak(e).message === "This race was not found.");
  await assert.rejects(deleteRace(db, 4), (e: unknown) => noLeak(e).message === "This race was not found.");
  await deleteRace(db, 1); assert.equal(rows.some((r) => r.id === 1), false);
});

test("before migration 10: a save that would lose a detail is refused with a plain reason and writes nothing", async () => {
  const { db, rows, log } = table({ hub: false, uid: "u1", seed: [base({})] });
  const attempts: Array<Partial<RaceInput>> = [{ location: "Lisbon" }, { distance: 10, distance_unit: "km" }, { target_time_s: 3000 }, { status: "completed" }, { sport: "swimming", race_type: "other" }];
  for (const a of attempts) {
    assert.ok(legacyBlocker(input(a)), JSON.stringify(a));
    await assert.rejects(createRace(db, "u1", input(a), { legacy: true }), (e: unknown) => /can't store .* yet, so the race was not saved/.test(noLeak(e).message));
    await assert.rejects(updateRace(db, 1, input(a), { legacy: true }), (e: unknown) => noLeak(e) instanceof SafeError);
  }
  assert.equal(log.length, 0, "nothing was sent to the database");
  assert.equal(rows.length, 1); assert.equal(rows[0].name, "Old race");
  assert.equal(legacyBlocker(input()), null);
  assert.equal(legacyBlocker(input({ sport: "triathlon", race_type: "ironman" })), null);
});

test("a write that assumed the full table but hits a missing column says 'not set up' (confirmed by the column), with no SQL text", async () => {
  const { db } = table({ hub: false, uid: "u1", seed: [base({})] });
  for (const run of [() => createRace(db, "u1", input({ location: "Lisbon" })), () => updateRace(db, 1, input())]) {
    await assert.rejects(run(), (e: unknown) => { const s = noLeak(e); return s.kind === "not-set-up" && s.message === NOT_SET_UP_MESSAGE && !s.retryable; });
  }
});

// ------------------------------------------------------------------ after migration 10
test("after migration 10: list, create, edit and delete round-trip every field; no fallback query is made", async () => {
  const { db, log } = table({ hub: true, uid: "u1", seed: [base({ sport: "running", location: null, distance: null, distance_unit: null, target_time_s: null, status: "planned" })] });
  const full = input({ name: "Berlin Marathon", race_date: "2027-09-26", race_type: "marathon", location: "Berlin", distance: 42.195, distance_unit: "km", target_time_s: 12_600, priority: "A", status: "registered", goal: "Sub 3:30", notes: "n" });
  const made = await createRace(db, "u1", full);
  assert.deepEqual([made.location, made.distance, made.distance_unit, made.target_time_s, made.status, made.sport], ["Berlin", 42.195, "km", 12_600, "registered", "running"]);
  const edited = await updateRace(db, made.id, { ...full, location: "Berlin, DE", status: "completed", target_time_s: 12_300 });
  assert.deepEqual([edited.location, edited.status, edited.target_time_s], ["Berlin, DE", "completed", 12_300]);
  const list = await listRacesCompat(db); assert.equal(list.legacy, false); assert.equal(list.races.length, 2);
  assert.equal((await getRaceCompat(db, made.id)).legacy, false);
  assert.ok(!log.some((l) => l.op === "select" && l.cols === BASE_RACE_COLUMNS), "the original-columns query never ran");
  await deleteRace(db, made.id); assert.equal((await listRaces(db)).length, 1);
});

// ------------------------------------------------------------------ real errors are reported, never mistaken for a missing migration
test("network, session and permission errors are friendly, categorised, retry-aware, and trigger no fallback", async () => {
  const cases: Array<[unknown, string, boolean]> = [
    [{ code: "", message: "TypeError: fetch failed", details: "ECONNREFUSED" }, "network", true],
    [{ code: "PGRST303", message: "JWT expired" }, "auth", false],
    [{ code: "42501", message: "permission denied for table races" }, "permission", false],
    [{ code: "57014", message: "canceling statement due to statement timeout" }, "other", true],
    [{ code: "42703", message: "column races.race_date does not exist" }, "other", true],       // a missing ORIGINAL column is not migration 10
    [{ message: "column races.sport does not exist" }, "other", true],                           // no code: not conclusive
  ];
  for (const [err, kind, retryable] of cases) {
    for (const run of [(d: Db) => listRacesCompat(d), (d: Db) => getRaceCompat(d, 1), (d: Db) => createRace(d, "u1", input()), (d: Db) => updateRace(d, 1, input()), (d: Db) => deleteRace(d, 1)]) {
      const { db, log } = table({ hub: true, uid: "u1", failWith: err });
      await assert.rejects(run(db), (e: unknown) => { const s = noLeak(e); assert.equal(s.kind, kind, JSON.stringify(err)); assert.equal(s.retryable, retryable); assert.notEqual(s.kind, "not-set-up"); return true; });
      assert.equal(log.length, 1, "exactly one query: no legacy fallback after a real error");
    }
  }
});

test("if even the original columns cannot be read, that is reported too (not hidden)", async () => {
  let n = 0;
  const db: Db = { from() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = { select() { return b; }, order() { return b; }, then(res: (v: unknown) => unknown) { n++; return Promise.resolve(n === 1 ? { data: null, error: { code: "42703", message: "column races.status does not exist" } } : { data: null, error: { code: "42501", message: "permission denied for table races" } }).then(res); } };
    return b;
  } };
  await assert.rejects(listRacesCompat(db), (e: unknown) => noLeak(e).kind === "permission");
});

// ------------------------------------------------------------------ wiring and documentation
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
test("wiring: the pages use the compatible loaders, pass the legacy flag, offer Try again, and the form hides what cannot be stored", () => {
  const list = read("app/(app)/races/page.tsx"), detail = read("app/(app)/races/[id]/page.tsx"), form = read("components/races/RaceForm.tsx");
  assert.match(list, /listRacesCompat\(getSupabase\(\)\)/); assert.ok(!/\blistRaces\(/.test(list));
  assert.match(list, /createRace\(sb, session!\.user\.id, input, \{ legacy \}\)/); assert.match(list, /updateRace\(sb, existing\.id, input, \{ legacy \}\)/);
  assert.match(list, /Try again/); assert.match(detail, /getRaceCompat\(/); assert.ok(!/\bgetRace\(/.test(detail)); assert.match(detail, /updateRace\(getSupabase\(\), race\.id, i, \{ legacy \}\)/); assert.match(detail, /Try again/);
  for (const field of ["Location", "Distance", "Unit", "Target finish time", "Status"]) assert.match(form, new RegExp(`\\{!legacy && <label>${field}<`), `${field} is hidden when it cannot be stored`);
  assert.match(form, /legacy \? "planned"/);
  for (const f of [list, detail, form]) assert.ok(!/migration|\.sql|races\.sport/i.test(f.replace(/\/\/.*$/gm, "")), "no migration wording on screen");
});

test("preflight document: migration 10 section covers the extra checks (constraints, dependants, grants) and the schema-cache step", () => {
  const doc = read("docs/MIGRATION_PREFLIGHT_09_12.md");
  for (const key of ["P10-6", "P10-7", "P10-8", "reload schema", "Q10-5"]) assert.ok(doc.includes(key), key);
});
