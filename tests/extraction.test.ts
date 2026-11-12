import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { QuotaUnavailableError, consumeExtractionQuota, limitFromEnv, retryText, type RpcDb } from "../lib/rateLimit.ts";
import { ExtractError, MAX_BYTES, runExtraction, type FlowDeps } from "../lib/extractFlow.ts";

// ---- a stand-in for consume_extraction_quota: calls for the same database are serialised (like the advisory lock),
// ---- with an await between "count" and "insert" so an unlocked implementation would race.
function fakeLimiterDb() {
  const rows = new Map<string, number[]>();
  let lock: Promise<unknown> = Promise.resolve();
  const clock = { now: 1_000_000 };
  const db: RpcDb = {
    rpc(_fn, args) {
      const run = lock.then(async () => {
        const user = String(args.p_user), limit = Number(args.p_limit), win = Number(args.p_window_seconds) * 1000;
        const mine = (rows.get(user) ?? []).filter((t) => t >= clock.now - win);
        await new Promise((r) => setImmediate(r));
        if (mine.length >= limit) {
          rows.set(user, mine);
          return { data: [{ allowed: false, remaining: 0, retry_after_seconds: Math.max(1, Math.ceil((mine[0] + win - clock.now) / 1000)) }], error: null };
        }
        mine.push(clock.now); rows.set(user, mine);
        return { data: [{ allowed: true, remaining: limit - mine.length, retry_after_seconds: 0 }], error: null };
      });
      lock = run.catch(() => undefined);
      return run;
    },
  };
  return { db, clock, rows };
}

test("requests below the limit succeed and the allowance counts down", async () => {
  const { db } = fakeLimiterDb();
  const r = [await consumeExtractionQuota(db, "u1"), await consumeExtractionQuota(db, "u1"), await consumeExtractionQuota(db, "u1")];
  assert.deepEqual(r.map((x) => [x.allowed, x.remaining]), [[true, 9], [true, 8], [true, 7]]);
});

test("the limit is enforced exactly at the threshold, with retry information, and frees up after the window", async () => {
  const { db, clock } = fakeLimiterDb();
  for (let i = 0; i < 10; i++) assert.equal((await consumeExtractionQuota(db, "u1")).allowed, true);
  const denied = await consumeExtractionQuota(db, "u1");
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSeconds >= 1 && denied.retryAfterSeconds <= 3600);
  clock.now += 3601 * 1000;
  assert.equal((await consumeExtractionQuota(db, "u1")).allowed, true, "rolling window: old requests expire");
});

test("different users have independent limits", async () => {
  const { db } = fakeLimiterDb();
  for (let i = 0; i < 10; i++) await consumeExtractionQuota(db, "alice");
  assert.equal((await consumeExtractionQuota(db, "alice")).allowed, false);
  assert.equal((await consumeExtractionQuota(db, "bob")).allowed, true);
});

test("concurrent requests can never exceed the allowance", async () => {
  const { db, rows } = fakeLimiterDb();
  const results = await Promise.all([
    ...Array.from({ length: 25 }, () => consumeExtractionQuota(db, "alice")),
    ...Array.from({ length: 25 }, () => consumeExtractionQuota(db, "bob")),
  ]);
  assert.equal(results.filter((r) => r.allowed).length, 20, "10 allowed per user, no more");
  assert.equal(rows.get("alice")!.length, 10);
  assert.equal(rows.get("bob")!.length, 10);
});

test("if the limiter cannot be consulted it fails closed", async () => {
  await assert.rejects(consumeExtractionQuota({ rpc: async () => ({ data: null, error: { message: "boom" } }) }, "u"), QuotaUnavailableError);
  await assert.rejects(consumeExtractionQuota({ rpc: async () => { throw new Error("network"); } }, "u"), QuotaUnavailableError);
  await assert.rejects(consumeExtractionQuota({ rpc: async () => ({ data: [{ nope: 1 }], error: null }) }, "u"), QuotaUnavailableError);
});

test("limit configuration is validated and texts are readable", () => {
  assert.deepEqual([undefined, "5", "0", "abc", "5000", "2.5", ""].map(limitFromEnv), [10, 5, 10, 10, 10, 10, 10]);
  assert.equal(retryText(30), "about 30 seconds");
  assert.equal(retryText(1), "about 1 second");
  assert.equal(retryText(125), "about 3 minutes");
  assert.equal(retryText(3600), "about 60 minutes");
});

// ---------------------------------------------------------------- the endpoint's order of operations
const pdf = () => { const f = new FormData(); f.append("file", new Blob([Buffer.from("%PDF-1.4 fake")], { type: "application/pdf" }), "r.pdf"); return f; };
function deps(over: Partial<FlowDeps> = {}) {
  const calls: string[] = [];
  const d: FlowDeps = {
    geminiConfigured: true, limit: 10,
    consume: async () => { calls.push("consume"); return { allowed: true, retryAfterSeconds: 0 }; },
    readForm: async () => { calls.push("readForm"); return pdf(); },
    findDuplicate: async () => { calls.push("findDuplicate"); return null; },
    read: async () => { calls.push("gemini"); return { results: [] }; },
    parse: (raw) => ({ parsed: raw }),
    retryText,
    ...over,
  };
  return { d, calls };
}

test("a rejected request (429) never reads the upload and never calls Gemini", async () => {
  const { d, calls } = deps({ consume: async () => { calls.push("consume"); return { allowed: false, retryAfterSeconds: 754 }; } });
  await assert.rejects(runExtraction(d, "yes"), (e: ExtractError) => {
    assert.equal(e.status, 429);
    assert.equal(e.extra.retryAfterSeconds, 754);
    assert.match(e.message, /limit of 10 report readings per hour/);
    assert.match(e.message, /about 13 minutes/);
    return true;
  });
  assert.deepEqual(calls, ["consume"], "only the limiter ran");
});

test("an allowed request checks the limit first, then reads the upload, then calls Gemini once", async () => {
  const { d, calls } = deps();
  const out = await runExtraction(d, "yes");
  assert.deepEqual(calls, ["consume", "readForm", "findDuplicate", "gemini"]);
  assert.equal(out.mime, "application/pdf");
  assert.match(String(out.sha256), /^[0-9a-f]{64}$/);
});

test("consent and configuration are still required before anything is consumed", async () => {
  for (const header of [null, "", "no", "YES"]) {
    const { d, calls } = deps();
    await assert.rejects(runExtraction(d, header), (e: ExtractError) => e.status === 400);
    assert.deepEqual(calls, [], "no consent: no quota used, no Gemini call");
  }
  const { d, calls } = deps({ geminiConfigured: false });
  await assert.rejects(runExtraction(d, "yes"), (e: ExtractError) => e.status === 503);
  assert.deepEqual(calls, []);
});

test("file validation is intact: missing, empty, oversized and wrong-type files never reach Gemini", async () => {
  const cases: Array<[string, FormData | null, number]> = [
    ["no body", null, 400],
    ["no file", new FormData(), 400],
    ["empty", (() => { const f = new FormData(); f.append("file", new Blob([])); return f; })(), 413],
    ["too large", (() => { const f = new FormData(); f.append("file", new Blob([new Uint8Array(MAX_BYTES + 1)])); return f; })(), 413],
    ["text pretending to be a pdf", (() => { const f = new FormData(); f.append("file", new Blob(["hello"], { type: "application/pdf" })); return f; })(), 415],
  ];
  for (const [name, form, status] of cases) {
    const { d, calls } = deps({ readForm: async () => form });
    await assert.rejects(runExtraction(d, "yes"), (e: ExtractError) => e.status === status, name);
    assert.ok(!calls.includes("gemini"), `${name}: Gemini must not be called`);
  }
});

test("a report that was already imported is reported without calling Gemini", async () => {
  const { d, calls } = deps({ findDuplicate: async () => ({ id: "p1", collected_on: "2026-05-01" }) });
  const out = await runExtraction(d, "yes");
  assert.deepEqual(out.duplicate, { id: "p1", collected_on: "2026-05-01" });
  assert.ok(!calls.includes("gemini"));
});

// ---------------------------------------------------------------- static checks of the SQL and the wiring
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");
const sql = read("09_biomarker_rate_limit.sql").replace(/--.*$/gm, "").toLowerCase();

test("09: server-only table and function, no browser access, atomic, safe search_path", () => {
  assert.match(sql, /alter table public\.biomarker_extract_requests enable row level security/);
  assert.match(sql, /revoke all on public\.biomarker_extract_requests from public, anon, authenticated;/);
  assert.ok(!/create policy/.test(sql), "no policy: browser roles can never read the records");
  assert.ok(!/grant[^;]*\b(anon|authenticated)\b/.test(sql), "nothing is granted to browser roles");
  assert.match(sql, /grant select, insert, delete on public\.biomarker_extract_requests to service_role;/);
  assert.match(sql, /security invoker set search_path = public/);
  assert.ok(!/security definer/.test(sql));
  assert.match(sql, /revoke all on function public\.consume_extraction_quota\(uuid, integer, integer\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.consume_extraction_quota\(uuid, integer, integer\) to service_role;/);
  assert.ok(sql.indexOf("pg_advisory_xact_lock") < sql.indexOf("select count(*)") && sql.indexOf("select count(*)") < sql.indexOf("insert into public.biomarker_extract_requests (user_id, requested_at)"),
    "the per-user lock is taken before counting and inserting");
});

test("09: the rolling window uses the real clock read after the lock, never the transaction start time", () => {
  const fn = sql.match(/create or replace function public\.consume_extraction_quota[\s\S]*?end \$\$;/)![0];
  assert.match(fn, /v_now\s+timestamptz;/);
  const lock = fn.indexOf("pg_advisory_xact_lock"), clock = fn.indexOf("v_now := clock_timestamp()");
  assert.ok(lock > 0 && clock > lock, "clock_timestamp() is read immediately after the lock is acquired");
  assert.ok(fn.indexOf("delete from") > clock, "nothing is computed before the clock is read");
  assert.equal((fn.match(/clock_timestamp\(\)/g) ?? []).length, 1, "read once: one consistent timestamp for the whole call");
  assert.ok(!/\bnow\(\)/.test(fn), "transaction-start now() is not used for the rolling window");
  assert.match(fn, /requested_at < v_now - win/);
  assert.match(fn, /oldest \+ win - v_now/);
  assert.match(fn, /insert into public\.biomarker_extract_requests \(user_id, requested_at\) values \(p_user, v_now\)/);
});

test("09: the records hold no health information", () => {
  const block = sql.match(/create table if not exists public\.biomarker_extract_requests \(([^;]*)\);/)![1];
  const columns = block.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((w) => w && !w.startsWith("(") && !w.startsWith(")"));
  assert.deepEqual(columns, ["id", "user_id", "requested_at"]);
});

test("the endpoint wiring: limiter is durable, server-side and ahead of everything else; consent stays mandatory", () => {
  const route = read("app/api/biomarkers/extract/route.ts"), flow = read("lib/extractFlow.ts"), limiter = read("lib/rateLimit.ts");
  assert.ok(route.indexOf("authUser(req)") < route.indexOf("runExtraction("));
  assert.ok(flow.indexOf("deps.consume()") < flow.indexOf("deps.readForm()") && flow.indexOf("deps.readForm()") < flow.indexOf("deps.read("));
  assert.match(route, /consumeExtractionQuota\(adminClient\(\), uid, limit\)/, "consumed with the service-role client and the verified user id");
  assert.ok(!/rpc\("consume_extraction_quota"/.test(route), "the browser-facing user client never calls the limiter");
  for (const src of [route, flow, limiter]) assert.ok(!/new Map\(|let (count|used|hits)\b/.test(src), "no process-local counter");
  assert.match(route, /"Retry-After"/);
  assert.match(flow, /consentHeader !== "yes"/);
  assert.match(read("lib/api.ts"), /"X-Report-Consent": "yes"/);
  const page = read("app/(app)/biomarkers/panels/[id]/page.tsx");
  assert.match(page, /disabled=\{!consent \|\| reading\}/);
  assert.match(page, /if \(!file \|\| !consent\) return;/);
});