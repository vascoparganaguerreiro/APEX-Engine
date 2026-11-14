import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_LIMITS, AiLimitError, AiUsageError, consume, dailyLimit, parseLimit, release, withUsage, type Db,
} from "../lib/aiUsage.ts";

// Fake of 09_ai_usage.sql: consume_ai_usage counts today's (UTC) events of one kind for one user and inserts one
// if under the limit, atomically (the real function holds a per-user lock; here JS runs it in one go).
type Ev = { id: number; user_id: string; kind: string; created_at: Date };
function fakeDb(opts: { rpcError?: boolean; deleteError?: boolean } = {}) {
  const events: Ev[] = [];
  let next = 1;
  const calls: Array<Record<string, unknown>> = [];
  const db: Db = {
    async rpc(fn, args) {
      calls.push(args);
      if (opts.rpcError || fn !== "consume_ai_usage") return { data: null, error: { message: "boom" } };
      const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
      const used = events.filter((e) => e.user_id === args.p_user && e.kind === args.p_kind && e.created_at >= dayStart).length;
      if (used >= (args.p_limit as number)) return { data: null, error: null };
      const ev = { id: next++, user_id: args.p_user as string, kind: args.p_kind as string, created_at: new Date() };
      events.push(ev);
      return { data: ev.id, error: null };
    },
    from(table: string) {
      assert.equal(table, "ai_usage_events");
      const filters: Record<string, unknown> = {};
      const q = {
        delete() { return q; },
        eq(col: string, v: unknown) { filters[col] = v; return q; },
        then(res: (v: unknown) => void, rej: (e: unknown) => void) {
          if (opts.deleteError) return Promise.resolve({ error: { message: "nope" } }).then(res, rej);
          for (let i = events.length - 1; i >= 0; i--) {
            if (Object.entries(filters).every(([c, v]) => (events[i] as Record<string, unknown>)[c] === v)) events.splice(i, 1);
          }
          return Promise.resolve({ error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
  const count = (uid: string, kind: string) => events.filter((e) => e.user_id === uid && e.kind === kind).length;
  return { db, events, calls, count };
}

const env = (o: Record<string, string>) => o;

test("limit reached: the next call is refused with a typed 429 error, and nothing is recorded", async () => {
  const { db, count } = fakeDb();
  const e = env({ SUMMARY_DAILY_LIMIT: "2" });
  await consume(db, "u1", "summary", e);
  await consume(db, "u1", "summary", e);
  await assert.rejects(consume(db, "u1", "summary", e), (err: unknown) => {
    assert.ok(err instanceof AiLimitError && err instanceof AiUsageError);
    assert.equal(err.status, 429);
    assert.equal(err.limit, 2);
    assert.equal(err.kind, "summary");
    assert.match(err.message, /Daily limit of 2 AI summaries reached/);
    return true;
  });
  assert.equal(count("u1", "summary"), 2);
});

test("regenerating the same item still counts every time", async () => {
  const { db, count } = fakeDb();
  const e = env({ SUMMARY_DAILY_LIMIT: "3" });
  const summarizeActivity42 = async () => ({ summary: "same activity again" });
  for (let i = 0; i < 3; i++) await withUsage(db, "u1", "summary", summarizeActivity42, e);
  assert.equal(count("u1", "summary"), 3);
  await assert.rejects(withUsage(db, "u1", "summary", summarizeActivity42, e), AiLimitError);
});

test("parallel requests cannot all pass: exactly `limit` succeed", async () => {
  const { db, count } = fakeDb();
  const e = env({ SUMMARY_DAILY_LIMIT: "3" });
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => consume(db, "u1", "summary", e)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof AiLimitError));
  assert.equal(count("u1", "summary"), 3);
});

test("a failed generation or save is released (not charged) and the original error is rethrown", async () => {
  const { db, count } = fakeDb();
  const e = env({ SUMMARY_DAILY_LIMIT: "1" });
  const geminiDown = new Error("gemini 503");
  await assert.rejects(withUsage(db, "u1", "summary", async () => { throw geminiDown; }, e), (err) => err === geminiDown);
  assert.equal(count("u1", "summary"), 0);
  // The allowance is still available afterwards.
  assert.deepEqual(await withUsage(db, "u1", "summary", async () => "ok", e), "ok");
  assert.equal(count("u1", "summary"), 1);
});

test("a failing release never hides the original error", async () => {
  const { db, count } = fakeDb({ deleteError: true });
  const orig = console.error; console.error = () => {};
  try {
    const boom = new Error("save failed");
    await assert.rejects(withUsage(db, "u1", "summary", async () => { throw boom; }, {}), (err) => err === boom);
  } finally { console.error = orig; }
  assert.equal(count("u1", "summary"), 1);   // still charged: release is best effort
});

test("release only deletes the given event of the given user and never throws", async () => {
  const { db, count } = fakeDb();
  const a = await consume(db, "u1", "summary", {});
  await consume(db, "u2", "summary", {});
  assert.equal(await release(db, { ...a, uid: "u2" }), true);    // wrong owner: nothing removed
  assert.equal(count("u1", "summary"), 1);
  assert.equal(await release(db, a), true);
  assert.equal(count("u1", "summary"), 0);
  assert.equal(count("u2", "summary"), 1);
  const broken: Db = { from() { throw new Error("down"); }, rpc: db.rpc };
  assert.equal(await release(broken, a), false);
});

test("kinds and users have separate allowances; report_extract uses REPORT_DAILY_LIMIT", async () => {
  const { db, calls } = fakeDb();
  const e = env({ SUMMARY_DAILY_LIMIT: "1", REPORT_DAILY_LIMIT: "2" });
  await consume(db, "u1", "summary", e);
  await assert.rejects(consume(db, "u1", "summary", e), AiLimitError);
  await consume(db, "u2", "summary", e);
  await consume(db, "u1", "report_extract", e);
  await consume(db, "u1", "report_extract", e);
  await assert.rejects(consume(db, "u1", "report_extract", e), (err: unknown) =>
    err instanceof AiLimitError && err.status === 429 && /lab report readings/.test(err.message));
  assert.deepEqual(calls.at(-1), { p_user: "u1", p_kind: "report_extract", p_limit: 2 });
});

test("bad env values fall back to the default and never disable the limit", async () => {
  for (const bad of [undefined, "", "abc", "NaN", "-5", "1.5", "Infinity", "1e3", "0x10", " ", "999999999999"]) {
    assert.equal(parseLimit(bad, 30), 30, `value ${JSON.stringify(bad)}`);
    assert.equal(dailyLimit("summary", bad === undefined ? {} : { SUMMARY_DAILY_LIMIT: bad }), 30);
    assert.equal(dailyLimit("report_extract", bad === undefined ? {} : { REPORT_DAILY_LIMIT: bad }), 10);
  }
  assert.equal(parseLimit("7", 30), 7);
  assert.equal(parseLimit(" 12 ", 30), 12);
  assert.equal(parseLimit("0", 30), 0);                         // 0 = feature off, never "unlimited"
  assert.equal(AI_LIMITS.summary.fallback, 30);
  assert.equal(AI_LIMITS.report_extract.fallback, 10);

  // End to end: a garbage value still enforces the default of 30.
  const { db, count } = fakeDb();
  const e = env({ SUMMARY_DAILY_LIMIT: "lots" });
  for (let i = 0; i < 30; i++) await consume(db, "u1", "summary", e);
  await assert.rejects(consume(db, "u1", "summary", e), AiLimitError);
  assert.equal(count("u1", "summary"), 30);
  // And 0 blocks everything.
  await assert.rejects(consume(db, "u9", "summary", { SUMMARY_DAILY_LIMIT: "0" }), AiLimitError);
});

test("ledger errors fail closed; bad uid or kind are rejected before touching the database", async () => {
  const { db } = fakeDb({ rpcError: true });
  await assert.rejects(consume(db, "u1", "summary", {}), (err: unknown) =>
    err instanceof AiUsageError && !(err instanceof AiLimitError) && err.status === 500);
  const throwing: Db = { from() { throw new Error("x"); }, async rpc() { throw new Error("network"); } };
  await assert.rejects(consume(throwing, "u1", "summary", {}), (err: unknown) => err instanceof AiUsageError && err.status === 500);
  let ran = false;
  await assert.rejects(withUsage(db, "u1", "summary", async () => { ran = true; }, {}), AiUsageError);
  assert.equal(ran, false, "the AI call must not run when the limit cannot be checked");

  const ok = fakeDb();
  await assert.rejects(consume(ok.db, "", "summary", {}), (err: unknown) => err instanceof AiUsageError && err.status === 401);
  // @ts-expect-error runtime guard for untyped callers
  await assert.rejects(consume(ok.db, "u1", "anything", {}), AiUsageError);
  assert.equal(ok.calls.length, 0);
});
