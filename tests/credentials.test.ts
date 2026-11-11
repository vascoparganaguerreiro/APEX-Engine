import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CryptoConfigError, activeVersion, decryptSecret, encryptSecret, needsRotation, type Env } from "../lib/crypto.ts";
import { ConnectionError, deleteConnection, getConnection, saveConnection, type CryptoOps, type Db } from "../lib/connectionStore.ts";

const k = () => randomBytes(32).toString("base64");
const env1: Env = { INTERVALS_ENCRYPTION_KEY: k() };

// ------------------------------------------------------------------ crypto
test("round trip, random IV, ciphertext hides the key", () => {
  const a = encryptSecret("my-secret-key", "user-1", env1).blob, b = encryptSecret("my-secret-key", "user-1", env1).blob;
  assert.notEqual(a, b);
  assert.ok(!a.includes("my-secret-key"));
  assert.equal(decryptSecret(a, "user-1", env1), "my-secret-key");
});

test("missing or invalid encryption key is rejected, with no fallback", () => {
  for (const bad of [undefined, "", "short", randomBytes(16).toString("base64"), randomBytes(33).toString("base64"), "!!!" + k().slice(3)]) {
    assert.throws(() => encryptSecret("x", "u", { INTERVALS_ENCRYPTION_KEY: bad }), CryptoConfigError);
  }
  assert.throws(() => encryptSecret("x", "u", {}), CryptoConfigError);
  assert.throws(() => encryptSecret("x", "u", { ...env1, INTERVALS_ENCRYPTION_ACTIVE_VERSION: "2" }), CryptoConfigError); // V2 key not set
  assert.throws(() => activeVersion({ INTERVALS_ENCRYPTION_ACTIVE_VERSION: "abc" }), CryptoConfigError);
});

test("authentication failures: tampering, wrong key, wrong owner, truncated tag, malformed blob", () => {
  const blob = encryptSecret("secret-value", "user-1", env1).blob;
  const [v, iv, tag, ct] = blob.split(".");
  const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
  assert.throws(() => decryptSecret([v, iv, tag, flip(ct)].join("."), "user-1", env1));
  assert.throws(() => decryptSecret([v, iv, flip(tag), ct].join("."), "user-1", env1));
  assert.throws(() => decryptSecret(blob, "user-1", { INTERVALS_ENCRYPTION_KEY: k() }));
  assert.throws(() => decryptSecret(blob, "user-2", env1), "a blob copied to another user must not decrypt");
  assert.throws(() => decryptSecret([v, iv, Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url"), ct].join("."), "user-1", env1));
  for (const junk of ["", "v1", "v1.a.b", "x1.a.b.c", `${blob}.extra`]) assert.throws(() => decryptSecret(junk, "user-1", env1));
});

test("key rotation: old blobs stay readable, new ones use the active version", () => {
  const v1 = k(), v2 = k();
  const old = encryptSecret("rotate-me", "u", { INTERVALS_ENCRYPTION_KEY: v1 }).blob;
  const env2: Env = { INTERVALS_ENCRYPTION_KEY: v1, INTERVALS_ENCRYPTION_KEY_V2: v2, INTERVALS_ENCRYPTION_ACTIVE_VERSION: "2" };
  assert.equal(decryptSecret(old, "u", env2), "rotate-me");
  assert.equal(needsRotation(old, env2), true);
  const fresh = encryptSecret("rotate-me", "u", env2);
  assert.equal(fresh.version, 2);
  assert.equal(needsRotation(fresh.blob, env2), false);
  assert.equal(decryptSecret(fresh.blob, "u", env2), "rotate-me");
});

// ------------------------------------------------------- store with a fake DB
type Tables = Record<string, Map<string, Record<string, unknown>>>;
function fakeDb(seed: Partial<Tables> = {}, failUpsertOn?: string): { db: Db; t: Tables } {
  const t: Tables = { intervals_connections: new Map(), intervals_credentials: new Map(), ...seed } as Tables;
  const db: Db = {
    from(name: string) {
      const m = t[name];
      let op = "select", payload: Record<string, unknown> = {}, uid: unknown = undefined;
      const run = async () => {
        if (op === "upsert") {
          if (failUpsertOn === name) return { error: { message: "boom" } };
          m.set(payload.user_id as string, { ...(m.get(payload.user_id as string) ?? {}), ...payload }); return { error: null };
        }
        if (uid === undefined) throw new Error("query without a user_id filter");   // every real query must be scoped
        const r = m.get(uid as string);
        if (op === "delete") { m.delete(uid as string); return { error: null }; }
        if (op === "update") { if (r) m.set(uid as string, { ...r, ...payload }); return { error: null }; }
        return { data: r ? { ...r } : null, error: null };
      };
      const b = {
        select() { op = "select"; return b; }, upsert(p: Record<string, unknown>) { op = "upsert"; payload = p; return run(); },
        update(p: Record<string, unknown>) { op = "update"; payload = p; return b; }, delete() { op = "delete"; return b; },
        eq(_c: string, v: unknown) { uid = v; return b; }, maybeSingle() { return run(); },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return run().then(res, rej); },
      };
      return b;
    },
  };
  return { db, t };
}
const ops = (env: Env = env1): CryptoOps => ({
  encrypt: (p, aad) => encryptSecret(p, aad, env), decrypt: (b, aad) => decryptSecret(b, aad, env), needsRotation: (b) => needsRotation(b, env),
});

test("save stores only ciphertext, in the credentials table, and clears any plaintext", async () => {
  const { db, t } = fakeDb({ intervals_connections: new Map([["u1", { user_id: "u1", athlete_id: "i1", api_key: "OLD-PLAINTEXT" }]]) });
  await saveConnection(db, ops(), "u1", "i1", "NEW-KEY-12345");
  assert.equal(t.intervals_connections.get("u1")!.api_key, null);
  assert.ok(!JSON.stringify([...t.intervals_connections.values()]).includes("NEW-KEY-12345"));
  const blob = String(t.intervals_credentials.get("u1")!.api_key_enc);
  assert.ok(!blob.includes("NEW-KEY-12345"));
  assert.deepEqual(await getConnection(db, ops(), "u1"), { athleteId: "i1", apiKey: "NEW-KEY-12345" });
});

test("legacy plaintext is encrypted and verified before the plaintext is removed", async () => {
  const { db, t } = fakeDb({ intervals_connections: new Map([["u1", { user_id: "u1", athlete_id: "i1", api_key: "LEGACY-KEY-1" }]]) });
  const c = await getConnection(db, ops(), "u1");
  assert.equal(c?.apiKey, "LEGACY-KEY-1");
  assert.equal(t.intervals_connections.get("u1")!.api_key, null);
  assert.equal(decryptSecret(String(t.intervals_credentials.get("u1")!.api_key_enc), "u1", env1), "LEGACY-KEY-1");
});

test("if encryption is misconfigured the legacy key is kept and still works (no silent loss)", async () => {
  const { db, t } = fakeDb({ intervals_connections: new Map([["u1", { user_id: "u1", athlete_id: "i1", api_key: "LEGACY-KEY-1" }]]) });
  const c = await getConnection(db, ops({}), "u1");
  assert.equal(c?.apiKey, "LEGACY-KEY-1");
  assert.equal(t.intervals_connections.get("u1")!.api_key, "LEGACY-KEY-1");
  assert.equal(t.intervals_credentials.size, 0);
  const failing = fakeDb({ intervals_connections: new Map([["u1", { user_id: "u1", athlete_id: "i1", api_key: "LEGACY-KEY-1" }]]) }, "intervals_credentials");
  assert.equal((await getConnection(failing.db, ops(), "u1"))?.apiKey, "LEGACY-KEY-1");
  assert.equal(failing.t.intervals_connections.get("u1")!.api_key, "LEGACY-KEY-1");
});

test("saving with a broken encryption setup fails loudly and stores nothing", async () => {
  const { db, t } = fakeDb();
  await assert.rejects(saveConnection(db, ops({}), "u1", "i1", "KEY-12345678"), ConnectionError);
  assert.equal(t.intervals_connections.size + t.intervals_credentials.size, 0);
});

test("a blob moved to another user's row cannot be decrypted (user isolation at the crypto level)", async () => {
  const { db, t } = fakeDb();
  await saveConnection(db, ops(), "u1", "i1", "ALICE-KEY-1234");
  t.intervals_connections.set("u2", { user_id: "u2", athlete_id: "i2", api_key: null });
  t.intervals_credentials.set("u2", { user_id: "u2", api_key_enc: t.intervals_credentials.get("u1")!.api_key_enc });
  await assert.rejects(getConnection(db, ops(), "u2"), ConnectionError);
});

test("user isolation: each user only ever reads, changes or deletes their own connection", async () => {
  const { db, t } = fakeDb();
  await saveConnection(db, ops(), "alice", "i1", "ALICE-KEY-1234");
  await saveConnection(db, ops(), "bob", "i2", "BOB-KEY-123456");
  assert.equal((await getConnection(db, ops(), "alice"))?.apiKey, "ALICE-KEY-1234");
  assert.equal((await getConnection(db, ops(), "bob"))?.apiKey, "BOB-KEY-123456");
  assert.equal(await getConnection(db, ops(), "mallory"), null);
  await deleteConnection(db, "alice");
  assert.equal(await getConnection(db, ops(), "alice"), null);
  assert.equal((await getConnection(db, ops(), "bob"))?.apiKey, "BOB-KEY-123456");
  assert.equal(t.intervals_credentials.size, 1);
});

test("rotation happens on use and the connection keeps working", async () => {
  const v1 = k();
  const { db, t } = fakeDb();
  await saveConnection(db, ops({ INTERVALS_ENCRYPTION_KEY: v1 }), "u1", "i1", "ROTATE-KEY-123");
  const env2: Env = { INTERVALS_ENCRYPTION_KEY: v1, INTERVALS_ENCRYPTION_KEY_V2: k(), INTERVALS_ENCRYPTION_ACTIVE_VERSION: "2" };
  assert.equal((await getConnection(db, ops(env2), "u1"))?.apiKey, "ROTATE-KEY-123");
  assert.ok(String(t.intervals_credentials.get("u1")!.api_key_enc).startsWith("v2."));
});
