// Strength local-data isolation: every device-side name is scoped by the authenticated user id, queued changes keep their owner and are
// only uploaded while that same user is signed in, account switches dispose the old engine, and legacy unscoped data is never read.
// Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { MemoryStore, SyncEngine, type EngineOwner, type Op } from "../lib/strength/sync.ts";
import { jwtSubject, supabaseTransport, type Db } from "../lib/strength/data.ts";
import { pickStore } from "../lib/strength/idb.ts";
import { createEngineHost, type BuiltEngine } from "../lib/strength/engineHost.ts";
import { GYM_KEY, LEGACY_KEYS, LOCAL_KEY, REST_KEY, readScoped, scopedDb, scopedKey, writeScoped } from "../lib/strength/scope.ts";
import { addExercise, startWorkout, updateSet, type Workout } from "../lib/strength/workout.ts";
import { FakeStrengthServer, T0, clock, ex, fakeToken, transportFor, uid } from "./strength-fixtures.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const bench = (): Workout => {
  let w = startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "kg" });
  w = addExercise(w, ex("barbell_bench_press"), { id: uid(), unit: "kg", setId: uid() });
  const e = w.exercises[0];
  return updateSet(w, e.id, e.sets[0].id, { weight: 80, reps: 8 });
};
function lsStub() { const m = new Map<string, string>(); return { m, getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } }; }
async function withLs<T>(ls: ReturnType<typeof lsStub>, f: () => Promise<T>): Promise<T> {
  const o = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), i = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true, writable: true });
  Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true, writable: true });
  try { return await f(); } finally {
    if (o) Object.defineProperty(globalThis, "localStorage", o); else delete (globalThis as Record<string, unknown>).localStorage;
    if (i) Object.defineProperty(globalThis, "indexedDB", i); else delete (globalThis as Record<string, unknown>).indexedDB;
  }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const owner = (userId: string, signedIn: () => string | null): EngineOwner => ({ userId, session: async () => { const u = signedIn(); return u ? { userId: u, accessToken: fakeToken(u) } : null; } });

test("scoping: names differ per user, and a missing or malformed user id is refused (no shared fallback name)", () => {
  assert.notEqual(scopedKey(REST_KEY, A), scopedKey(REST_KEY, B));
  assert.notEqual(scopedDb(A), scopedDb(B));
  for (const k of LEGACY_KEYS) assert.notEqual(scopedKey(k, A), k);
  for (const bad of ["", "null", "undefined", "../x", null, undefined]) assert.throws(() => scopedKey(REST_KEY, bad as string));
});

test("A and B cannot read each other's local data (device storage)", async () => {
  const ls = lsStub();
  await withLs(ls, async () => {
    const a = await pickStore(A), b = await pickStore(B);
    assert.equal(a.kind, "localstorage");
    const ea = new SyncEngine(a.store, transportFor(new FakeStrengthServer(A), A), clock(), owner(A, () => A)); await ea.load();
    const w = bench(); await ea.record(w, { active: true });
    const eb = new SyncEngine((await pickStore(B)).store, transportFor(new FakeStrengthServer(B), B), clock(), owner(B, () => B));
    const local = await eb.load();
    assert.equal(local.activeId, null); assert.deepEqual(local.workouts, {}); assert.equal(eb.status.pending, 0);
    // a store opened for A again still has A's workout
    const ea2 = new SyncEngine((await pickStore(A)).store, transportFor(new FakeStrengthServer(A), A), clock(), owner(A, () => A));
    assert.equal((await ea2.load()).activeId, w.id);
    assert.ok(ls.m.has(scopedKey(LOCAL_KEY, A)));
    assert.ok([...ls.m.keys()].every((k) => k.includes(":u:")), "every key written carries a user scope");
  });
});

test("an engine refuses device data that names another owner", async () => {
  const store = new MemoryStore(), server = new FakeStrengthServer(A);
  const ea = new SyncEngine(store, transportFor(server, A), clock(), owner(A, () => A)); await ea.load();
  await ea.record(bench(), { active: true });
  const eb = new SyncEngine(store, transportFor(new FakeStrengthServer(B), B), clock(), owner(B, () => B));
  const local = await eb.load();
  assert.deepEqual(local.workouts, {}); assert.equal(eb.status.pending, 0, "A's queue is not loaded for B");
});

test("A's queued workouts cannot upload under B: nothing is sent while another user is signed in, and ops keep their owner", async () => {
  const server = new FakeStrengthServer(A), t = transportFor(server, A), store = new MemoryStore();
  let signedIn: string | null = A;
  const e = new SyncEngine(store, t, clock(), owner(A, () => signedIn)); await e.load();
  await e.record(bench(), { active: false });
  assert.ok(e.local.sync.queue.length > 0 && e.local.sync.queue.every((q) => q.userId === A), "every queued op is stamped with A");
  signedIn = B;                                            // B signs in on this device while A's engine still holds A's queue
  const st = await e.flush();
  assert.equal(t.sent.length, 0, "nothing reached the server"); assert.equal(st.mode, "auth"); assert.ok(st.pending > 0, "A's changes are still queued");
  assert.equal(server.rows.size, 0);
  signedIn = null;                                         // signed out: same
  assert.equal((await e.flush()).mode, "auth"); assert.equal(t.sent.length, 0);
  signedIn = A;                                            // A returns: the queue uploads under A
  assert.equal((await e.flush()).mode, "synced"); assert.ok(server.rows.size > 0);
});

test("the user is verified immediately before every upload batch, not just once", async () => {
  const server = new FakeStrengthServer(A), t = transportFor(server, A);
  let checks = 0, signedIn: string | null = A;
  const o: EngineOwner = { userId: A, session: async () => { checks++; return signedIn ? { userId: signedIn, accessToken: fakeToken(signedIn) } : null; } };
  const e = new SyncEngine(new MemoryStore(), t, clock(), o); await e.load();
  await e.record(bench(), { active: false });
  await e.flush();
  assert.ok(checks >= 1, "the session was consulted before sending");
  const before = checks; await e.record(bench(), { active: false }); signedIn = B; await e.flush();
  assert.ok(checks > before, "and again for the next flush"); assert.equal(e.status.mode, "auth");
});

test("an op without the owner's id (or with another one) is never sent", async () => {
  const store = new MemoryStore(), server = new FakeStrengthServer(A), t = transportFor(server, A);
  const e = new SyncEngine(store, t, clock(), owner(A, () => A)); await e.load();
  await e.record(bench(), { active: false });
  // tamper: strip / swap the owner on the persisted queue, then reload
  const raw = await store.read(); raw!.sync.queue = raw!.sync.queue.map((q, i) => (i % 2 ? { ...q, userId: B } : { ...q, userId: undefined }));
  await store.write(raw!);
  const e2 = new SyncEngine(store, t, clock(), owner(A, () => A)); await e2.load();
  await e2.flush();
  assert.equal(t.sent.length, 0, "untrusted ops are held back");
});

test("switching accounts disposes the old engine and isolates state; a build for a user who left is disposed, never handed out", async () => {
  const built: Array<{ uid: string; engine: SyncEngine; cleaned: boolean }> = [];
  let signedIn: string | null = A, gate: Promise<void> | null = null;
  const host = createEngineHost({
    userId: async () => signedIn,
    build: async (u): Promise<BuiltEngine> => {
      if (gate) await gate;
      const engine = new SyncEngine(new MemoryStore(), transportFor(new FakeStrengthServer(u), u), clock(), owner(u, () => signedIn)); await engine.load();
      const rec = { uid: u, engine, cleaned: false }; built.push(rec);
      return { engine, storage: "memory", cleanup: () => { rec.cleaned = true; } };
    },
  });
  const a = await host.get(); assert.equal(host.activeUserId, A);
  assert.equal((await host.get()).engine, a.engine, "same user: the same engine");
  await a.engine.record(bench(), { active: true });
  signedIn = B;
  const b = await host.get();
  assert.notEqual(b.engine, a.engine); assert.equal(host.activeUserId, B);
  assert.equal(built[0].cleaned, true, "A's timers and listeners were released");
  assert.deepEqual(b.engine.local.workouts, {}, "B starts with none of A's in-memory state");
  assert.equal((await a.engine.flush()).pending, a.engine.status.pending, "A's disposed engine does nothing");
  // sign out: engine dropped; get() refuses
  signedIn = null; host.onAuthChange(null); await tick();
  assert.equal(host.activeUserId, null); assert.equal(built[1].cleaned, true);
  await assert.rejects(host.get());
  // a build still running when the user leaves is disposed on arrival
  signedIn = A;
  let open!: () => void; gate = new Promise<void>((r) => { open = r; });
  const pending = host.get(); await tick(); host.onAuthChange(B); open();
  await assert.rejects(pending); await tick();
  assert.equal(built[2].cleaned, true); assert.equal(host.activeUserId, null);
});

test("signing out preserves the previous user's scoped offline data", async () => {
  const ls = lsStub();
  await withLs(ls, async () => {
    const t = transportFor(new FakeStrengthServer(A), A); t.mode = "offline";
    const host = createEngineHost({ userId: async () => A, build: async (u) => {
      const { store, kind } = await pickStore(u); const engine = new SyncEngine(store, t, clock(), owner(u, () => u)); await engine.load();
      return { engine, storage: kind, cleanup: () => undefined };
    } });
    const w = bench();
    await (await host.get()).engine.record(w, { active: true });
    host.onAuthChange(null);                                           // sign-out
    assert.ok(ls.m.get(scopedKey(LOCAL_KEY, A)), "A's workout and queue are still on the device");
    const again = new SyncEngine((await pickStore(A)).store, t, clock(), owner(A, () => A));
    const local = await again.load();
    assert.equal(local.activeId, w.id); assert.equal(again.status.pending, 3);
  });
});

test("legacy unscoped data never leaks into either account and is left untouched", async () => {
  const ls = lsStub();
  const legacyWorkout = bench();
  const legacy = JSON.stringify({ version: 1, activeId: legacyWorkout.id, workouts: { [legacyWorkout.id]: legacyWorkout }, sync: { queue: [{ op_id: uid(), kind: "session", id: legacyWorkout.id, rev: 1, deleted: false, data: {}, sessionId: legacyWorkout.id, attempts: 0, error: null, failed: false }], known: {}, lastRev: 1, sent: [], stale: 0 } });
  ls.setItem(LOCAL_KEY, legacy); ls.setItem("apex-strength-history-v1", "[{\"x\":1}]"); ls.setItem(REST_KEY, "{\"endAt\":1,\"pausedLeft\":null,\"total\":1,\"label\":\"x\"}");
  await withLs(ls, async () => {
    for (const u of [A, B]) {
      const t = transportFor(new FakeStrengthServer(u), u);
      const e = new SyncEngine((await pickStore(u)).store, t, clock(), owner(u, () => u));
      const local = await e.load();
      assert.equal(local.activeId, null); assert.deepEqual(local.workouts, {}); assert.equal(e.status.pending, 0);
      await e.flush(); assert.equal(t.sent.length, 0, "legacy queued ops are never uploaded");
    }
    assert.equal(ls.getItem(LOCAL_KEY), legacy, "legacy data is quarantined, not modified or deleted");
  });
});

test("production code cannot create an unscoped engine or use the legacy names directly", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(new URL(d, import.meta.url), { withFileTypes: true })) { const p = `${d}${f.name}`; if (f.isDirectory()) { if (!["node_modules", ".next", "tests"].includes(f.name)) walk(`${p}/`); } else if (/\.(ts|tsx)$/.test(f.name)) files.push(p); } };
  for (const d of ["../lib/", "../app/", "../components/"]) walk(d);
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    if (/new SyncEngine\(/.test(src) && !/sync\.ts$/.test(f)) assert.ok(/runtime\.ts$/.test(f) && /session: sessionAuth/.test(src), `${f}: engines are only built in runtime.ts, with an owner`);
    if (!/scope\.ts$/.test(f)) for (const k of LEGACY_KEYS) assert.ok(!src.includes(`"${k}"`), `${f} uses the unscoped key ${k}`);
    if (!/(scope|idb)\.ts$/.test(f)) assert.ok(!/pickStore\(\s*\)/.test(src), `${f} calls pickStore without a user`);
  }
});

test("an engine cannot exist without a valid owner (also enforced by the type system)", () => {
  const t = transportFor(new FakeStrengthServer(A), A);
  assert.throws(() => new SyncEngine(new MemoryStore(), t, clock(), undefined as unknown as EngineOwner));
  assert.throws(() => new SyncEngine(new MemoryStore(), t, clock(), { userId: "", session: async () => null }));
  assert.throws(() => new SyncEngine(new MemoryStore(), t, clock(), { userId: "not-a-uuid", session: async () => null }));
  // @ts-expect-error the owner argument is mandatory
  assert.throws(() => new SyncEngine(new MemoryStore(), t, clock()));
});

test("a disposed engine refuses every write, so a stale page can never store anything after the user changed", async () => {
  const e = new SyncEngine(new MemoryStore(), transportFor(new FakeStrengthServer(A), A), clock(), owner(A, () => A)); await e.load();
  const w = bench(); await e.record(w, { active: true });
  e.dispose();
  await assert.rejects(e.record(w), /signed-in user changed/); await assert.rejects(e.discard(w)); await assert.rejects(e.prune()); await assert.rejects(e.adopt(w));
});

test("direct account switch A to B (no sign-out in between): old engine disposed, B gets a fresh engine with none of A's data", async () => {
  let signedIn: string | null = A;
  const stores: Record<string, MemoryStore> = { [A]: new MemoryStore(), [B]: new MemoryStore() };
  const host = createEngineHost({ userId: async () => signedIn, build: async (u) => {
    const engine = new SyncEngine(stores[u], transportFor(new FakeStrengthServer(u), u), clock(), owner(u, () => signedIn)); await engine.load();
    return { engine, storage: "memory", cleanup: () => undefined };
  } });
  const a = await host.get(); const w = bench(); await a.engine.record(w, { active: true });
  signedIn = B; host.onAuthChange(B);                                // the auth listener fires with the new user, never null
  assert.ok(a.engine.isDisposed); await assert.rejects(a.engine.record(w));
  const b = await host.get();
  assert.equal(b.engine.ownerId, B); assert.deepEqual(b.engine.local.workouts, {}); assert.equal(b.engine.status.pending, 0);
  signedIn = A; host.onAuthChange(A);                                // and back: A's offline data is still there
  const a2 = await host.get(); assert.equal(a2.engine.local.activeId, w.id);
});

test("get() never returns an engine for a user whose session changed during creation or hand-over", async () => {
  // 1. the session changes while the engine is being built
  let calls = 0; const seq: Array<string | null> = [A, B];
  const disposed: SyncEngine[] = [];
  const host = createEngineHost({ userId: async () => seq[Math.min(calls++, seq.length - 1)], build: async (u) => {
    const engine = new SyncEngine(new MemoryStore(), transportFor(new FakeStrengthServer(u), u), clock(), owner(u, () => u)); await engine.load();
    return { engine, storage: "memory", cleanup: () => { disposed.push(engine); } };
  } });
  await assert.rejects(host.get(), /signed-in user changed/);       // built for A, but the hand-over check sees B
  await tick(); assert.equal(disposed.length, 1, "the stale engine was disposed");
  assert.equal(host.activeUserId, null);
  // 2. sign-out during creation
  let who: string | null = A, gate!: () => void; const hold = new Promise<void>((r) => { gate = r; });
  const host2 = createEngineHost({ userId: async () => who, build: async (u) => { await hold; const engine = new SyncEngine(new MemoryStore(), transportFor(new FakeStrengthServer(u), u), clock(), owner(u, () => who)); return { engine, storage: "memory", cleanup: () => undefined }; } });
  const p = host2.get(); await tick(); who = null; host2.onAuthChange(null); gate();
  await assert.rejects(p);
});

test("the app layout rebuilds the whole signed-in area per user, and hooks never write caches for a user who left", () => {
  const layout = readFileSync(new URL("../app/(app)/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /<main className="main" key=\{session\.user\.id\}>/, "a direct A to B switch remounts every page, so no state of A survives");
  const hooks = readFileSync(new URL("../lib/strength/hooks.ts", import.meta.url), "utf8");
  assert.match(hooks, /uid === \(await sessionUserId\(\)\)/, "cache writes are skipped when the user changed while loading");
  assert.match(hooks, /if \(await changedUser\(uid\)\) return;/, "results for a user who left are dropped, not shown");
});

// ------------------------------------------------------------------ equipment preference is per user
test("gym equipment preference is stored per user; the legacy unscoped value is never inherited by either account", () => {
  const ls = lsStub();
  ls.setItem(GYM_KEY, JSON.stringify(["barbell"]));                          // legacy, unscoped, owner unknown
  assert.deepEqual(readScoped(ls, GYM_KEY, A, []), [], "A does not get the legacy value");
  assert.deepEqual(readScoped(ls, GYM_KEY, B, []), [], "B does not get it either");
  writeScoped(ls, GYM_KEY, A, ["dumbbell"]);
  assert.deepEqual(readScoped(ls, GYM_KEY, A, []), ["dumbbell"]);
  assert.deepEqual(readScoped(ls, GYM_KEY, B, []), [], "B does not see A's choice");
  writeScoped(ls, GYM_KEY, B, ["cable"]);
  assert.deepEqual(readScoped(ls, GYM_KEY, A, []), ["dumbbell"], "A's own preference is preserved");
  assert.equal(ls.getItem(GYM_KEY), JSON.stringify(["barbell"]), "the legacy value is left untouched (quarantined)");
  assert.deepEqual(readScoped(ls, GYM_KEY, null, ["x"]), ["x"]); writeScoped(ls, GYM_KEY, null, ["y"]);
  assert.ok([...ls.m.keys()].every((k) => k === GYM_KEY || k.includes(":u:")), "nothing was written without a user");
  const page = readFileSync(new URL("../app/(app)/strength/page.tsx", import.meta.url), "utf8");
  assert.ok(!/localStorage\.(get|set)Item\(GYM_KEY/.test(page) && /readScoped<Equipment\[\]>/.test(page) && /writeScoped\(localStorage, GYM_KEY/.test(page));
});

// ------------------------------------------------------------------ the upload is bound to the verified session
test("engine: the session is read once per batch and that same object is what the transport receives", async () => {
  const server = new FakeStrengthServer(A), t = transportFor(server, A);
  let reads = 0, who: string = A;
  const o: EngineOwner = { userId: A, session: async () => { reads++; const r = { userId: who, accessToken: fakeToken(who) }; who = B; return r; } };   // the session flips right after it was read
  const e = new SyncEngine(new MemoryStore(), t, clock(), o); await e.load();
  await e.record(bench(), { active: false });
  await e.flush();
  assert.equal(reads, 1, "read once for the batch, not again at request time");
  assert.equal(t.auths.length, 1); assert.equal(t.auths[0]!.userId, A); assert.equal(jwtSubject(t.auths[0]!.accessToken), A, "the request carries the verified A token, not B's");
  assert.ok(server.rows.size > 0);
});

function fakeSupabase(sub: { current: string }) {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const jwt = (u: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: u, exp: Math.floor(Date.now() / 1000) + 3600, role: "authenticated", aud: "authenticated" })).toString("base64url")}.sig`;
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), h = new Headers(init?.headers);
    if (url.includes("/auth/v1/user")) { const tok = (h.get("authorization") ?? "").replace("Bearer ", ""); return json({ id: jwtSubject(tok), aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" }); }
    seen.push({ url, auth: h.get("authorization") });
    return json([]);
  };
  const client = createClient("http://localhost:54321", "anon-key", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetch as typeof globalThis.fetch } });
  return { client, seen, jwt, signInAs: async (u: string) => { sub.current = u; const r = await client.auth.setSession({ access_token: jwt(u), refresh_token: `r-${u}` }); assert.equal(r.error, null); return jwt(u); } };
}
const opsFor = (): Op[] => [{ op_id: uid(), kind: "session", id: uid(), rev: 1, deleted: false, data: {} }];

test("real supabase-js client: a session switch between verification and request cannot change the identity the request uses", async () => {
  const f = fakeSupabase({ current: A });
  const tokenA = await f.signInAs(A);
  const verified = { userId: A, accessToken: (await f.client.auth.getSession()).data.session!.access_token };   // read once and verified as A
  assert.equal(verified.accessToken, tokenA);
  await f.signInAs(B);                                                   // B signs in AFTER A was verified, BEFORE the request is made
  const tr = supabaseTransport(f.client as unknown as Db);
  // control: without binding, supabase-js picks up whichever session is current at request time (this is the window being closed)
  await tr.send(opsFor());
  assert.equal(jwtSubject(f.seen.at(-1)!.auth!.replace("Bearer ", "")), B, "unbound: the request goes out as B");
  // bound: the verified A token is what is sent, even though B is now the current session
  await tr.send(opsFor(), verified);
  const last = f.seen.at(-1)!;
  assert.ok(last.url.includes("/rest/v1/rpc/apply_strength_ops"));
  assert.equal(last.auth, `Bearer ${tokenA}`, "bound: the request carries A's token");
  assert.equal(jwtSubject(last.auth!.replace("Bearer ", "")), A);
});

test("a token that does not name the verified user, or a client that cannot carry the header, sends nothing", async () => {
  const f = fakeSupabase({ current: A }); await f.signInAs(A);
  const tr = supabaseTransport(f.client as unknown as Db), before = f.seen.length;
  await assert.rejects(tr.send(opsFor(), { userId: A, accessToken: fakeToken(B) }), (e: unknown) => (e as { kind?: string }).kind === "auth");
  await assert.rejects(tr.send(opsFor(), { userId: A, accessToken: "not-a-jwt" }), (e: unknown) => (e as { kind?: string }).kind === "auth");
  const noHeader: Db = { from: () => ({}), rpc: () => Promise.resolve({ data: [], error: null }) };             // a builder without setHeader
  await assert.rejects(supabaseTransport(noHeader).send(opsFor(), { userId: A, accessToken: fakeToken(A) }), (e: unknown) => (e as { kind?: string }).kind === "auth");
  assert.equal(f.seen.length, before, "no request was made");
  assert.equal(jwtSubject(fakeToken(A)), A);
});
