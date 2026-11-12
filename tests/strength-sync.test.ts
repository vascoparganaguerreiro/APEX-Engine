import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, SyncEngine, diffInto, emptySync, nextRev } from "../lib/strength/sync.ts";
import { addExercise, addSet, completeSet, removeSet, startWorkout, updateSet, type Workout } from "../lib/strength/workout.ts";
import { FakeStrengthServer, T0, at, clock, ex, transportFor, uid } from "./strength-fixtures.ts";

function benchWorkout(): Workout {
  let w = startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "kg" });
  w = addExercise(w, ex("barbell_bench_press"), { id: uid(), unit: "kg", setId: uid() });
  const e = w.exercises[0];
  return updateSet(w, e.id, e.sets[0].id, { weight: 80, reps: 8 });
}
const setup = () => {
  const server = new FakeStrengthServer(), store = new MemoryStore(), t = transportFor(server);
  return { server, store, t, engine: new SyncEngine(store, t, clock()) };
};

test("rev numbers always increase, even if the clock goes backwards", () => {
  const a = nextRev(0, 1000), b = nextRev(a, 999), c = nextRev(b, 5000);
  assert.ok(b > a && c > b);
});

test("diff: only changed rows are enqueued, and pending ops for the same row are coalesced", () => {
  let w = benchWorkout();
  const s1 = diffInto(emptySync(), w, { nowMs: 1, newOpId: uid, inflight: new Set() });
  assert.deepEqual(s1.queue.map((q) => q.kind), ["session", "exercise", "set"]);
  const same = diffInto(s1, w, { nowMs: 2, newOpId: uid, inflight: new Set() });
  assert.equal(same.queue.length, 3, "nothing changed, nothing new");
  const e = w.exercises[0];
  w = updateSet(w, e.id, e.sets[0].id, { reps: 9 });
  const s2 = diffInto(s1, w, { nowMs: 3, newOpId: uid, inflight: new Set() });
  assert.equal(s2.queue.length, 3, "the pending set op was replaced, not duplicated");
  assert.equal(s2.queue[2].data.reps, 9);
  assert.ok(s2.queue[2].rev > s1.queue[2].rev);
  const s3 = diffInto(s1, w, { nowMs: 3, newOpId: uid, inflight: new Set([s1.queue[2].op_id]) });
  assert.equal(s3.queue.length, 4, "an op already in flight is never rewritten; a newer op follows it");
});

test("completed sets are saved locally before any network use, and survive a reload", async () => {
  const { store, t, server } = setup();
  t.mode = "offline";
  const e1 = new SyncEngine(store, t, clock());
  await e1.load();
  let w = benchWorkout();
  const e = w.exercises[0];
  w = completeSet(w, e.id, e.sets[0].id, at(2));
  await e1.record(w, { active: true });
  assert.ok(store.writes >= 1, "written to the device store immediately");
  const st = await e1.flush();
  assert.equal(st.mode, "offline");
  assert.match(st.message!, /Saved on this device/);
  // the tab is closed and reopened
  const e2 = new SyncEngine(store, t, clock(Date.parse(T0) + 3_600_000));
  const local = await e2.load();
  assert.equal(local.activeId, w.id);
  assert.equal(local.workouts[w.id].exercises[0].sets[0].completed, true);
  assert.equal(e2.status.pending, 3);
  t.mode = "ok";
  const ok = await e2.flush();
  assert.equal(ok.mode, "synced");
  assert.equal(server.live("set").length, 1);
});

test("a lost response after the server committed never creates a duplicate set", async () => {
  const { engine, t, server } = setup();
  await engine.load();
  const w = benchWorkout();
  await engine.record(w, { active: true });
  t.mode = "lose_response";
  await engine.flush();                                  // server applied, client did not hear back
  assert.equal(server.live("set").length, 1);
  assert.equal(engine.status.pending, 3, "the client still thinks it must send");
  t.mode = "ok";
  const st = await engine.flush();                       // replay
  assert.equal(st.pending, 0);
  assert.equal(server.live("set").length, 1, "still exactly one set");
  assert.equal(st.stale, 3, "the replay was recognised as already applied");
});

test("concurrent flushes share one run; a second tab sending the same ops is harmless", async () => {
  const { engine, t, server, store } = setup();
  await engine.load();
  await engine.record(benchWorkout(), { active: true });
  t.mode = "slow";
  const a = engine.flush(), b = engine.flush();
  assert.equal(a, b, "same promise");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.sent.length, 1);
  t.release!();
  await a;
  assert.equal(server.calls, 1);
  // a second tab with a stale copy of the queue
  const other = new SyncEngine(store, transportFor(server), clock());
  await other.load();
  assert.equal(other.status.pending, 0, "the store already reflects the acknowledged ops");
});

test("deleting a set after it was synced is final, even if an older write arrives later", async () => {
  const { engine, server, t } = setup();
  await engine.load();
  let w = benchWorkout();
  const e = w.exercises[0];
  w = addSet(w, e.id, uid());
  await engine.record(w, { active: true });
  const oldOps = engine.local.sync.queue.map(({ op_id, kind, id, rev, deleted, data }) => ({ op_id, kind, id, rev, deleted, data }));
  await engine.flush();
  assert.equal(server.live("set").length, 2);
  w = removeSet(w, e.id, w.exercises[0].sets[1].id);
  await engine.record(w);
  await engine.flush();
  assert.equal(server.live("set").length, 1, "tombstone applied");
  const replay = server.apply(oldOps);                   // a delayed duplicate of the very first upload
  assert.ok(replay.every((r) => r.status === "stale"));
  assert.equal(server.live("set").length, 1, "the deleted set did not come back");
  assert.equal(t.sent.length, 2);
});

test("two devices editing the same set: the newer edit wins and the older is reported as stale", async () => {
  const server = new FakeStrengthServer();
  const store1 = new MemoryStore();
  const d1 = new SyncEngine(store1, transportFor(server), clock(Date.parse(T0)));
  await d1.load();
  let w = benchWorkout();
  await d1.record(w, { active: true });
  await d1.flush();
  // device 2 starts from the same workout, later clock
  const store2 = new MemoryStore();
  store2.data = JSON.parse(JSON.stringify(store1.data));
  const d2 = new SyncEngine(store2, transportFor(server), clock(Date.parse(T0) + 600_000));
  await d2.load();
  const e = w.exercises[0];
  const w2 = updateSet(w, e.id, e.sets[0].id, { reps: 10 });
  await d2.record(w2);
  await d2.flush();
  w = updateSet(w, e.id, e.sets[0].id, { reps: 6 });     // device 1 edits with an older clock
  await d1.record(w);
  const st = await d1.flush();
  assert.equal(st.stale, 1);
  const row = server.live("set")[0];
  assert.equal(row.data.reps, 10, "newer edit kept");
});

test("cancelling: unsent work is dropped entirely; sent work is hidden with a tombstone", async () => {
  const { engine, server, t } = setup();
  await engine.load();
  const draft = benchWorkout();
  await engine.record(draft, { active: true });
  await engine.discard(draft);
  assert.equal(engine.status.pending, 0, "nothing was ever sent, so nothing needs to be sent");
  assert.equal(engine.local.activeId, null);
  const real = benchWorkout();
  await engine.record(real, { active: true });
  await engine.flush();
  await engine.discard(real);
  await engine.flush();
  assert.equal(server.live("session").length, 0);
  assert.equal(server.rows.get(`session:${real.id}`)?.deleted, true);
  assert.equal(t.sent.flat().filter((o) => o.id === draft.id).length, 0);
});

test("editing a workout loaded from the server: deletions become tombstones and unchanged rows are not re-sent", async () => {
  const { engine, server, t } = setup();
  await engine.load();
  let w = benchWorkout();
  w = addSet(w, w.exercises[0].id, uid());
  server.apply((await (async () => { const s = diffInto(emptySync(), w, { nowMs: 1, newOpId: uid, inflight: new Set() }); return s.queue; })()), "user-a");   // already on the server
  await engine.adopt(w);
  assert.equal(engine.status.pending, 0, "adopting enqueues nothing");
  w = removeSet(w, w.exercises[0].id, w.exercises[0].sets[1].id);
  await engine.record(w);
  assert.equal(engine.local.sync.queue.length, 1, "only the deleted set is sent");
  assert.equal(engine.local.sync.queue[0].deleted, true);
  await engine.flush();
  assert.equal(server.live("set").length, 1);
  await engine.discard(w);
  await engine.flush();
  assert.equal(server.rows.get(`session:${w.id}`)?.deleted, true, "deleting an adopted workout hides it on the server");
  assert.ok(t.sent.length >= 2);
});

test("missing migration: everything stays queued on the device with a clear message", async () => {
  const { engine, t, server } = setup();
  await engine.load();
  await engine.record(benchWorkout(), { active: true });
  t.mode = "not_set_up";
  const st = await engine.flush();
  assert.equal(st.mode, "not_set_up");
  assert.match(st.message!, /Saved on this device.*isn't set up for your account yet/);
  assert.ok(!/migration|\.sql/i.test(st.message!), "no migration number is shown");
  assert.equal(st.pending, 3);
  t.mode = "ok";
  assert.equal((await engine.flush()).pending, 0);
  assert.equal(server.live("set").length, 1);
});

test("rejected ops are retried, then parked as failed without blocking other workouts", async () => {
  const server = new FakeStrengthServer();
  const engine = new SyncEngine(new MemoryStore(), transportFor(server, "user-b"), clock());
  await engine.load();
  // someone else's session id (RLS): user-a owns it on the server
  const victim = benchWorkout();
  server.apply([{ op_id: uid(), kind: "session", id: victim.id, rev: 1, deleted: false, data: {} }], "user-a");
  await engine.record(victim, { active: true });
  for (let i = 0; i < 5; i++) await engine.flush();
  assert.equal(engine.status.failed, 3, "the session, its exercise and set are parked");
  assert.equal(server.rows.get(`session:${victim.id}`)?.user, "user-a", "the other user's row is untouched");
  const mine = benchWorkout();
  await engine.record(mine);
  await engine.flush();
  assert.equal(server.live("set").filter((r) => r.user === "user-b").length, 1, "later work still syncs");
});
