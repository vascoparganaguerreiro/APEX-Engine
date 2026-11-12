// Task 8E: Strength Hub reliability for real gym use, with migration 13 NOT applied.
// Covers: honest save/sync status (device only / waiting / confirmed by the server / failed), no silent loss, Retry after parked failures,
// the localStorage fallback, the whole workout lifecycle and its calculations, and merged duplicates counted once. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryStore, SyncEngine, syncLabel, type Op, type OpResult, type Transport } from "../lib/strength/sync.ts";
import { LocalStorageStore, pickStore } from "../lib/strength/idb.ts";
import {
  addExercise, addSet, completeSet, finish, pause, removeExercise, removeSet, resume, startWorkout, uncompleteSet, updateSet, elapsedSeconds, type Workout,
} from "../lib/strength/workout.ts";
import { e1rm, exerciseStats, fromWorkout, personalRecords, workSets, type HSession } from "../lib/strength/analytics.ts";
import { setVolumeKg } from "../lib/strength/units.ts";
import { loadHistory, loadWorkouts, type Db } from "../lib/strength/data.ts";
import { FakeStrengthServer, T0, at, clock, ex, transportFor, uid } from "./strength-fixtures.ts";

const bench = () => {
  let w = startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "kg" });
  w = addExercise(w, ex("barbell_bench_press"), { id: uid(), unit: "kg", setId: uid() });
  const e = w.exercises[0];
  return updateSet(w, e.id, e.sets[0].id, { weight: 80, reps: 8 });
};

// ------------------------------------------------------------------ the four states are never blurred
test("status text: device only, waiting, confirmed by the server and failed are distinct; nothing claims a server save without proof", () => {
  const base = { pending: 0, failed: 0, lastSyncedAt: null as string | null };
  assert.equal(syncLabel({ ...base, mode: "synced" }), "Nothing waiting to upload", "no confirmation yet: it must not say saved");
  assert.equal(syncLabel({ ...base, mode: "synced", lastSyncedAt: "2026-11-10T09:00:00Z" }), "Saved to server");
  assert.match(syncLabel({ ...base, mode: "pending", pending: 3 }), /^On device · waiting to upload \(3\)/);
  assert.match(syncLabel({ ...base, mode: "not_set_up", pending: 3 }), /^On device only · server not set up/);
  assert.match(syncLabel({ ...base, mode: "offline", pending: 2 }), /^Offline · on device/);
  assert.match(syncLabel({ ...base, mode: "auth", pending: 1 }), /sign in to upload/);
  assert.match(syncLabel({ ...base, mode: "error", pending: 1 }), /upload failed, retrying/);
  assert.match(syncLabel({ ...base, mode: "failed", failed: 2 }), /^Upload failed · 2 changes need attention/);
  for (const mode of ["pending", "syncing", "offline", "not_set_up", "auth", "error", "failed"] as const) {
    assert.ok(!/Saved to server/.test(syncLabel({ pending: 1, failed: 1, lastSyncedAt: "2026-11-10T09:00:00Z", mode })), `${mode} never claims the server has it`);
  }
});

test("migration 13 missing: stays on the device, says so, never claims a server save, and uploads once the migration exists", async () => {
  const server = new FakeStrengthServer(), t = transportFor(server), engine = new SyncEngine(new MemoryStore(), t, clock());
  await engine.load();
  assert.equal(syncLabel(engine.status), "Nothing waiting to upload", "fresh start: not 'Saved'");
  await engine.record(bench(), { active: true });
  t.mode = "not_set_up";
  for (let i = 0; i < 3; i++) await engine.flush();
  assert.equal(engine.status.mode, "not_set_up");
  assert.equal(engine.status.pending, 3); assert.equal(engine.status.failed, 0);
  assert.equal(engine.status.lastSyncedAt, null, "nothing was acknowledged by a server");
  assert.match(syncLabel(engine.status), /^On device only/); assert.ok(!/Saved to server/.test(syncLabel(engine.status)));
  assert.equal(engine.local.activeId !== null, true, "the workout is still there");
  t.mode = "ok";
  await engine.flush();
  assert.equal(syncLabel(engine.status), "Saved to server"); assert.equal(server.live("set").length, 1);
});

test("offline then back online: kept on the device, uploaded once, no duplicate", async () => {
  const server = new FakeStrengthServer(), t = transportFor(server), store = new MemoryStore(), engine = new SyncEngine(store, t, clock());
  await engine.load();
  let w = bench(); const e = w.exercises[0];
  w = completeSet(w, e.id, e.sets[0].id, at(2));
  await engine.record(w, { active: true });
  t.mode = "offline"; await engine.flush();
  assert.match(syncLabel(engine.status), /^Offline · on device/);
  assert.equal(server.live("set").length, 0);
  t.mode = "ok"; await engine.flush(); await engine.flush();
  assert.equal(server.live("set").length, 1, "uploaded exactly once"); assert.equal(engine.status.pending, 0);
  assert.equal(syncLabel(engine.status), "Saved to server");
});

// ------------------------------------------------------------------ parked failures: reported as failed, kept, and retryable
/** A server that rejects every operation while `reject` is true (for example a temporary database error), else behaves normally. */
function flaky(server: FakeStrengthServer) {
  const t = { reject: true, calls: 0, async send(ops: Op[]): Promise<OpResult[]> { t.calls++; return t.reject ? ops.map((o) => ({ op_id: o.op_id, status: "rejected" as const, error: "temporary database error" })) : server.apply(ops); } };
  return t satisfies Transport & Record<string, unknown>;
}

test("rejected changes are reported as FAILED (not 'saved'), stay on the device, and can be retried", async () => {
  const server = new FakeStrengthServer(), t = flaky(server), engine = new SyncEngine(new MemoryStore(), t, clock());
  await engine.load();
  await engine.record(bench(), { active: true });
  for (let i = 0; i < 6; i++) await engine.flush();
  assert.equal(engine.status.failed, 3);
  assert.equal(engine.status.mode, "failed", "the old code reported 'synced' here");
  assert.match(syncLabel(engine.status), /^Upload failed · 3 changes need attention/);
  assert.match(engine.status.message ?? "", /Retry/);
  assert.equal(engine.status.lastSyncedAt, null, "a rejection is not a server acknowledgement");
  assert.equal(engine.local.activeId !== null && engine.pendingWorkouts().length + 1 > 0, true);
  assert.equal(engine.local.sync.queue.length, 3, "nothing was discarded");
  assert.equal(server.live("set").length, 0);
  const calls = t.calls; await engine.flush(); assert.equal(t.calls, calls, "parked changes are not hammered automatically");
  // the problem is fixed; the user taps Retry
  t.reject = false;
  const st = await engine.retryFailed();
  assert.equal(st.mode, "synced"); assert.equal(st.failed, 0); assert.equal(st.pending, 0);
  assert.equal(syncLabel(st), "Saved to server");
  assert.equal(server.live("set").length, 1); assert.equal(server.live("exercise").length, 1); assert.equal(server.live("session").length, 1);
});

test("a failure mixed with pending work shows both, and new edits keep syncing", async () => {
  const server = new FakeStrengthServer(), t = flaky(server), engine = new SyncEngine(new MemoryStore(), t, clock());
  await engine.load();
  await engine.record(bench(), { active: true });
  for (let i = 0; i < 6; i++) await engine.flush();
  t.reject = false;
  await engine.record(bench());                                  // a second workout, accepted
  assert.equal(engine.status.mode, "pending"); assert.match(syncLabel(engine.status), /3 failed/);
  await engine.flush();
  assert.equal(server.live("set").length, 1, "the second workout uploaded; the parked one is still waiting for Retry");
  assert.equal(engine.status.failed, 3); assert.equal(engine.status.mode, "failed");
});

test("duplicate or replayed queued operations are harmless (idempotent)", async () => {
  const server = new FakeStrengthServer();
  const ops: Op[] = [{ op_id: uid(), kind: "session", id: uid(), rev: 5, deleted: false, data: { title: "x" } }];
  assert.equal(server.apply(ops)[0].status, "applied");
  assert.equal(server.apply(ops)[0].status, "stale", "the replay is answered 'stale', not applied twice");
  assert.equal(server.live("session").length, 1);
});

// ------------------------------------------------------------------ device storage: localStorage fallback
function withGlobals<T>(g: Record<string, unknown>, f: () => Promise<T>): Promise<T> {
  const old: Record<string, PropertyDescriptor | undefined> = {};
  for (const k of Object.keys(g)) { old[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: g[k], configurable: true, writable: true }); }
  return f().finally(() => { for (const k of Object.keys(g)) { if (old[k]) Object.defineProperty(globalThis, k, old[k]!); else delete (globalThis as Record<string, unknown>)[k]; } });
}
const lsStub = () => { const m = new Map<string, string>(); return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } }; };

test("device storage: localStorage is used when IndexedDB is unavailable, and an active workout survives a 'refresh'", async () => {
  await withGlobals({ indexedDB: undefined, localStorage: lsStub() }, async () => {
    const { store, kind } = await pickStore();
    assert.equal(kind, "localstorage"); assert.ok(store instanceof LocalStorageStore);
    const t = transportFor(new FakeStrengthServer()); t.mode = "not_set_up";
    const a = new SyncEngine(store, t, clock()); await a.load();
    let w = bench(); const e = w.exercises[0];
    w = completeSet(w, e.id, e.sets[0].id, at(2)); w = pause(w, at(3));
    await a.record(w, { active: true });
    // refresh: a brand-new engine on the same storage
    const b = new SyncEngine((await pickStore()).store, t, clock()); const local = await b.load();
    assert.equal(local.activeId, w.id);
    assert.equal(local.workouts[w.id].pausedAt, at(3), "still paused");
    assert.equal(local.workouts[w.id].exercises[0].sets[0].completed, true);
    assert.equal(b.status.pending, 3, "the upload queue came back too");
  });
});

test("device storage: memory is the last resort, and the pill says so", async () => {
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  await withGlobals({ indexedDB: undefined, localStorage: broken }, async () => { assert.equal((await pickStore()).kind, "memory"); });
  assert.match(readFileSync(new URL("../components/strength/Bits.tsx", import.meta.url), "utf8"), /no durable storage: keep the tab open/);
});

// ------------------------------------------------------------------ whole lifecycle and calculations
test("lifecycle: start, two exercises, warm-up and working sets, edit, complete, pause/resume, finish; calculations exclude warm-ups", () => {
  assert.equal(ex("seated_cable_row").loadMode, "total");
  let w = startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "kg" });
  w = addExercise(w, ex("barbell_bench_press"), { id: uid(), unit: "kg", setId: uid() });
  w = addExercise(w, ex("seated_cable_row"), { id: uid(), unit: "kg", setId: uid() });
  const [b, r] = w.exercises;
  // bench: warm-up 40 x 10, working 60 x 8, 60 x 8, 60 x 6
  w = addSet(w, b.id, uid(), { type: "warmup" });
  const warm = w.exercises[0].sets[1];
  w = updateSet(w, b.id, b.sets[0].id, { weight: 60, reps: 8 });
  w = updateSet(w, b.id, warm.id, { weight: 40, reps: 10, type: "warmup" });
  const s2 = uid(), s3 = uid(); w = addSet(w, b.id, s2, { type: "working" }); w = addSet(w, b.id, s3, { type: "working" });   // (a set added after a warm-up defaults to another warm-up)
  w = updateSet(w, b.id, s2, { weight: 60, reps: 8 }); w = updateSet(w, b.id, s3, { weight: 60, reps: 6 });
  for (const s of w.exercises[0].sets) w = completeSet(w, b.id, s.id, at(5));
  // row: 3 x 30 x 12
  w = updateSet(w, r.id, r.sets[0].id, { weight: 30, reps: 12 });
  const r2 = uid(), r3 = uid(); w = addSet(w, r.id, r2); w = addSet(w, r.id, r3);
  for (const s of w.exercises[1].sets) w = completeSet(w, r.id, s.id, at(9));
  // a mistake is corrected: un-complete, edit, complete again; an extra set is deleted
  const mistake = uid(); w = addSet(w, r.id, mistake); w = removeSet(w, r.id, mistake);
  const first = w.exercises[1].sets[0]; w = uncompleteSet(w, r.id, first.id); w = updateSet(w, r.id, first.id, { reps: 12 }); w = completeSet(w, r.id, first.id, at(10));
  w = pause(w, at(20)); assert.equal(elapsedSeconds(w, at(30)), 20 * 60, "the clock is frozen while paused");
  w = resume(w, at(30)); assert.equal(w.pausedSeconds, 600);
  w = finish(w, at(40), { discardIncomplete: true });
  assert.equal(w.status, "completed"); assert.equal(elapsedSeconds(w, at(60)), 30 * 60, "40 min minus 10 min paused");

  const h = fromWorkout(w);
  const [hb, hr] = h.exercises;
  const sb = exerciseStats(h, hb), sr = exerciseStats(h, hr);
  assert.equal(workSets(hb).length, 3, "warm-up is not a working set"); assert.equal(sb.workingSets, 3);
  assert.equal(sb.volumeKg, 60 * 8 + 60 * 8 + 60 * 6, "volume excludes the warm-up (1320, not 1720)");
  assert.equal(sb.reps, 22);
  assert.equal(sr.volumeKg, 3 * 30 * 12); assert.equal(sr.workingSets, 3);
  assert.equal(h.exercises.reduce((n, e) => n + workSets(e).length, 0), 6);
  assert.ok(Math.abs((sb.e1rmKg ?? 0) - 60 * (1 + 8 / 30)) < 1e-9, "Epley: 60 x (1 + 8/30) = 76");
  assert.equal(e1rm(100, 1), 100); assert.equal(e1rm(100, 11), null);
});

test("records ignore warm-ups; first time is a baseline; a heavier warm-up never makes a record", () => {
  const sess = (id: string, day: number, sets: Array<[number, number, "warmup" | "working"]>): HSession => ({ id, title: "t", startedAt: at(day * 1440), endedAt: at(day * 1440 + 60), pausedSeconds: 0, source: "apex",
    exercises: [{ key: "barbell_bench_press", name: "Bench", loadMode: "total", sets: sets.map(([weight, reps, type]) => ({ type, weight, unit: "kg" as const, reps, duration_s: null, distance_m: null, rpe: null, completed: true })) }] });
  const prev = sess("a", 0, [[100, 5, "working"]]), cur = sess("b", 7, [[140, 3, "warmup"], [100, 5, "working"]]);
  assert.deepEqual(personalRecords(cur, [prev, cur]).prs, [], "a 140 kg warm-up is not a record");
  assert.deepEqual(personalRecords(prev, [prev]).baselines, ["Bench"]);
  const better = sess("c", 14, [[105, 5, "working"]]);
  assert.ok(personalRecords(better, [prev, better]).prs.some((p) => p.kind === "weight"));
});

test("pounds are converted for volume and records, never silently rewritten", () => {
  assert.ok(Math.abs(setVolumeKg(135, "lb", "total", 5) - 135 * 0.45359237 * 5) < 1e-9);
  let w = startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "lb" });
  w = addExercise(w, ex("barbell_bench_press"), { id: uid(), unit: "lb", setId: uid() });
  const e = w.exercises[0]; w = updateSet(w, e.id, e.sets[0].id, { weight: 135, reps: 5, unit: "lb" });
  assert.equal(w.exercises[0].sets[0].weight, 135); assert.equal(w.exercises[0].sets[0].unit, "lb");
  w = removeExercise(addExercise(w, ex("seated_cable_row"), { id: uid(), unit: "kg", setId: uid() }), w.exercises[0].id);   // removing an exercise keeps the others intact
  assert.equal(w.exercises.length, 1); assert.equal(w.exercises[0].name, ex("seated_cable_row").name);
});

// ------------------------------------------------------------------ merged duplicates are counted once everywhere
type Row = Record<string, unknown>;
function historyDb(sessions: Row[], links: Row[] | "missing"): Db {
  return {
    rpc() { throw new Error("unused"); },
    from(table: string) {
      const rows = table === "strength_sessions" ? sessions : table === "training_session_links" ? (links === "missing" ? null : links) : [];
      const q: Record<string, unknown> = {};
      const chain = () => q;
      for (const m of ["select", "is", "eq", "gte", "in", "order"]) q[m] = chain;
      q.range = () => Promise.resolve(rows === null ? { data: null, error: { code: "42P01", message: 'relation "training_session_links" does not exist' } } : { data: rows, error: null });
      return q;
    },
  };
}
const sRow = (id: string, source: string, day: number): Row => ({ id, title: id, status: "completed", started_at: at(day * 1440), ended_at: at(day * 1440 + 60), paused_seconds: 0, source, routine_id: null, timezone: null, notes: null, perceived_effort: null,
  strength_session_exercises: [{ id: `${id}-e`, position: 0, exercise_key: "barbell_bench_press", exercise_name: "Bench", deleted_at: null, load_mode: "total", weight_unit: "kg", superset_group: null, rest_seconds: 90, notes: null,
    strength_sets: [{ id: `${id}-s`, position: 0, set_type: "working", weight: 100, weight_unit: "kg", reps: 5, completed: true, deleted_at: null, duration_s: null, distance_m: null, rpe: null, rir: null, side: null, completed_at: null, notes: null }] }] });
const resolve = (k: string) => (k === "barbell_bench_press" ? ex(k) : null);

test("a workout logged in APEX and Hevy and merged is counted once in history, Today, records and the Coach", async () => {
  const sessions = [sRow("apex-1", "apex", 3), sRow("hevy-1", "hevy_csv", 3), sRow("other", "apex", 1)];
  const links = [
    { id: "l1", training_session_id: "t1", activity_id: null, strength_session_id: "apex-1", role: "primary" },
    { id: "l2", training_session_id: "t1", activity_id: null, strength_session_id: "hevy-1", role: "secondary" },
  ];
  const merged = await loadHistory(historyDb(sessions, links), { keys: null, resolve });
  assert.deepEqual(merged.map((s) => s.id).sort(), ["apex-1", "other"], "the secondary copy is left out");
  assert.equal((await loadWorkouts(historyDb(sessions, links), { keys: null, resolve })).length, 3, "the raw loader (Duplicates page) still sees both");
  const unmerged = await loadHistory(historyDb(sessions, []), { keys: null, resolve });
  assert.equal(unmerged.length, 3, "nothing merged: nothing excluded");
});

test("before migration 13 history is simply unavailable (not set up); an unreadable link table never hides workouts", async () => {
  await assert.rejects(loadHistory({ rpc() { return null; }, from() { const q: Record<string, unknown> = {}; for (const m of ["select", "is", "eq", "gte", "in", "order"]) q[m] = () => q; q.range = () => Promise.resolve({ data: null, error: { code: "42P01", message: "relation does not exist" } }); return q; } }, { keys: null, resolve }), /migration 13/);
  assert.equal((await loadHistory(historyDb([sRow("a", "apex", 1)], "missing"), { keys: null, resolve })).length, 1, "links missing: all workouts kept");
});

test("wiring: the pill shows the label and a Retry for failed changes; nothing else claims 'Saved' for local data", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const bits = read("components/strength/Bits.tsx");
  assert.match(bits, /syncLabel\(status\)/); assert.match(bits, /status\.failed > 0 && <button[\s\S]*>Retry<\/button>/); assert.match(bits, /engine\.retryFailed\(\)/);
  assert.ok(!/SYNC_TEXT/.test(read("lib/strength/runtime.ts")), "the old 'Saved' wording is gone");
  assert.ok(!/text: `Saved: /.test(read("components/strength/AskApex.tsx")));
  assert.match(read("app/(app)/strength/page.tsx"), /Cancel workout/);
});
