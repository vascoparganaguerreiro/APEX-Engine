import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCoach, type CoachDeps } from "../lib/coach/engine.ts";
import { COACH_BUDGET_MS, DISCOVERY_TIMEOUT_MS, GeminiError, PER_MODEL_TIMEOUT_MS, generateJson, generateText, resetModelCache } from "../lib/coach/gemini.ts";
import { QuotaUnavailable, consumeCoachQuota, limitFrom, type RpcDb } from "../lib/coach/quota.ts";
import { createStore } from "../lib/coach/store.ts";
import { deleteAssessment, deleteConversation, listAssessments, listConversations, listMessages } from "../lib/coach/client.ts";
import { CHAT_OK, TODAY, chat } from "./coach-fixtures.ts";

// ------------------------------------------------------------------ the Gemini caller
const reply = (text: string, usage = { promptTokenCount: 11, candidatesTokenCount: 7 }) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: usage }), { status: 200 });
const timeoutErr = () => Object.assign(new Error("timeout"), { name: "TimeoutError" });
const cfg = (f: (url: string, init: RequestInit) => Promise<Response>, over = {}) => ({ apiKey: "KEY123", modelOverride: "gemini-test", fetch: f as unknown as typeof fetch, ...over });

test("Gemini: success returns text and token usage; the key travels in a header, never the URL", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const r = await generateJson(cfg(async (url, init) => { seen = { url, init }; return reply('{"ok":true}'); }), { system: "SYS", user: "USER" });
  assert.deepEqual([r.text, r.usage, r.model, r.attempts], ['{"ok":true}', { promptTokens: 11, outputTokens: 7 }, "gemini-test", 1]);
  assert.ok(!seen!.url.includes("KEY123"));
  assert.equal((seen!.init.headers as Record<string, string>)["x-goog-api-key"], "KEY123");
  const body = JSON.parse(String(seen!.init.body));
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.systemInstruction.parts[0].text, "SYS");
  assert.ok(seen!.init.signal, "every call has a timeout");
});

test("Gemini: timeouts and server errors are retried once; quota and config errors are not", async () => {
  let n = 0;
  await assert.rejects(generateJson(cfg(async () => { n++; throw timeoutErr(); }), { system: "s", user: "u" }), (e: unknown) => e instanceof GeminiError && e.kind === "timeout");
  assert.equal(n, 2, "retried once, then stopped");
  let calls = 0;
  const ok = await generateJson(cfg(async () => (++calls === 1 ? new Response("boom", { status: 503 }) : reply("{}"))), { system: "s", user: "u" });
  assert.deepEqual([ok.attempts, calls], [2, 2]);
  let q = 0;
  await assert.rejects(generateJson(cfg(async () => { q++; return new Response("{}", { status: 429 }); }), { system: "s", user: "u" }), (e: unknown) => e instanceof GeminiError && e.kind === "quota");
  assert.equal(q, 1, "no retry on quota");
  await assert.rejects(generateJson({ apiKey: undefined, fetch: (async () => reply("{}")) as unknown as typeof fetch }, { system: "s", user: "u" }), (e: unknown) => e instanceof GeminiError && e.kind === "config");
  let e2 = 0;
  await assert.rejects(generateJson(cfg(async () => { e2++; return new Response(JSON.stringify({ candidates: [] }), { status: 200 }); }), { system: "s", user: "u" }), (e: unknown) => e instanceof GeminiError && e.kind === "empty");
  assert.equal(e2, 2);
});

test("Gemini: model discovery is used and cached when no model is forced", async () => {
  resetModelCache();
  let lists = 0;
  const f = async (url: string) => {
    if (url.includes("/models?")) { lists++; return new Response(JSON.stringify({ models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }] }), { status: 200 }); }
    assert.ok(url.includes("/models/gemini-2.5-flash:generateContent"));
    return reply("{}");
  };
  await generateJson({ apiKey: "K", fetch: f as unknown as typeof fetch }, { system: "s", user: "u" });
  await generateJson({ apiKey: "K", fetch: f as unknown as typeof fetch }, { system: "s", user: "u" });
  assert.equal(lists, 1);
  resetModelCache();
});

// ------------------------------------------------------------------ model fallback, time budget and safe diagnostics (Task 8H). Fake fetch only.
const MA = "gemini-3-flash", MB = "gemini-2.5-flash", MC = "gemini-2.0-flash";     // ranked A, B, C by the existing ranking
const listing = () => new Response(JSON.stringify({ models: [MB, MC, MA].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ["generateContent"] })) }), { status: 200 });
/** Fake Gemini: a model list, and a per-model handler. `calls` records the model of every generateContent call, in order. */
function fakeGemini(handler: (model: string, n: number) => Promise<Response>) {
  const calls: string[] = [], lists: number[] = [];
  const f = (async (url: string) => {
    if (url.includes("/models?")) { lists.push(1); return listing(); }
    const m = /models\/([^:]+):generateContent/.exec(url)![1];
    calls.push(m);
    return handler(m, calls.length);
  }) as unknown as typeof fetch;
  return { f, calls, lists };
}
const quiet = () => undefined;
const run = (f: typeof fetch, over: Record<string, unknown> = {}) => generateJson({ apiKey: "KEY123", fetch: f, log: quiet, ...over }, { system: "s", user: "u" });

test("Gemini fallback: a timeout on the first model moves to the next model, which answers", async () => {
  resetModelCache();
  const g = fakeGemini(async (m) => { if (m === MA) throw timeoutErr(); return reply('{"ok":1}'); });
  const r = await run(g.f);
  assert.deepEqual(g.calls, [MA, MB], "second-ranked model tried after the first timed out");
  assert.deepEqual([r.model, r.text, r.attempts], [MB, '{"ok":1}', 2], "the fallback's answer is returned");
  resetModelCache();
});

test("Gemini fallback: the same model is never retried while another is available; every model is tried once, then it stops", async () => {
  resetModelCache();
  const g = fakeGemini(async () => { throw timeoutErr(); });
  await assert.rejects(run(g.f), (e: unknown) => e instanceof GeminiError && e.kind === "timeout" && /took too long/.test(e.message));
  assert.deepEqual(g.calls, [MA, MB, MC], "three distinct models, one call each");
  resetModelCache();
  const h = fakeGemini(async () => new Response("x", { status: 503 }));
  await assert.rejects(run(h.f), (e: unknown) => e instanceof GeminiError && e.kind === "unavailable");
  assert.deepEqual(h.calls, [MA, MB, MC], "a server error also moves on instead of retrying the same model");
  resetModelCache();
});

test("Gemini fallback: the model that answered last time goes first next time (no repeated wait on a slow model)", async () => {
  resetModelCache();
  const g = fakeGemini(async (m) => { if (m === MA) throw timeoutErr(); return reply("{}"); });
  await run(g.f); g.calls.length = 0;
  await run(g.f);
  assert.deepEqual(g.calls, [MB], "straight to the model that worked; discovery was cached too");
  resetModelCache();
});

test("Gemini fallback: permanent errors do not trigger pointless attempts; an unusable model is skipped, never retried", async () => {
  resetModelCache();
  for (const res of [() => new Response("{}", { status: 401 }), () => new Response(JSON.stringify({ error: { message: "API key not valid", details: [{ reason: "API_KEY_INVALID" }] } }), { status: 400 })]) {
    resetModelCache();
    const g = fakeGemini(async () => res());
    await assert.rejects(run(g.f), (e: unknown) => e instanceof GeminiError && e.kind === "config" && !/KEY123/.test(e.message));
    assert.equal(g.calls.length, 1, "rejected credentials: stop at once, no other model will help");
  }
  resetModelCache();
  const q = fakeGemini(async () => new Response("{}", { status: 429 }));
  await assert.rejects(run(q.f), (e: unknown) => e instanceof GeminiError && e.kind === "quota");
  assert.equal(q.calls.length, 1, "quota: no fallback");
  resetModelCache();
  const u = fakeGemini(async (m) => (m === MA ? new Response("{}", { status: 404 }) : m === MB ? new Response('{"error":{"message":"bad"}}', { status: 400 }) : reply("{}")));
  const r = await run(u.f);
  assert.deepEqual(u.calls, [MA, MB, MC]); assert.equal(r.model, MC, "unsupported model (404) and a model that rejects the request (400) are each skipped once");
  resetModelCache();
});

/** Replace AbortSignal.timeout with a recorder, so the exact timeout given to each call can be asserted without waiting. */
function recordTimeouts() {
  const orig = AbortSignal.timeout, ms: number[] = [];
  (AbortSignal as unknown as { timeout: (n: number) => AbortSignal }).timeout = (n: number) => { ms.push(n); return new AbortController().signal; };
  return { ms, restore: () => { (AbortSignal as unknown as { timeout: typeof orig }).timeout = orig; } };
}

test("time budget: discovery and every model call fit inside the budget, which sits well inside the 60 s route limit", async () => {
  resetModelCache();
  const rec = recordTimeouts();
  try {
    const clockMs = { t: 1_000_000 };
    const start = clockMs.t, deadline = start + COACH_BUDGET_MS;
    // every call "hangs" until its own timeout fires: the clock advances by exactly the timeout given to it
    const f = (async (url: string) => {
      const before = rec.ms.length;
      if (url.includes("/models?")) { clockMs.t += 8_000; return listing(); }                    // slow discovery that still succeeds
      clockMs.t += rec.ms[rec.ms.length - 1]; void before; throw timeoutErr();
    }) as unknown as typeof fetch;
    await assert.rejects(generateJson({ apiKey: "K", fetch: f, deadline, now: () => clockMs.t, log: quiet }, { system: "s", user: "u" }), (e: unknown) => e instanceof GeminiError && e.kind === "timeout");
    assert.ok(rec.ms.every((n) => n <= PER_MODEL_TIMEOUT_MS), `no call is given more than ${PER_MODEL_TIMEOUT_MS} ms: ${rec.ms}`);
    assert.ok(rec.ms[0] <= DISCOVERY_TIMEOUT_MS, "discovery is capped");
    assert.ok(clockMs.t - start <= COACH_BUDGET_MS, `the request finished inside the budget (${clockMs.t - start} ms)`);
    assert.ok(rec.ms.length >= 3, "a fallback model really got a turn after the first timed out");
  } finally { rec.restore(); resetModelCache(); }
  assert.ok(COACH_BUDGET_MS <= 50_000 && PER_MODEL_TIMEOUT_MS < COACH_BUDGET_MS / 2 + 1, "budget leaves >= 10 s of the 60 s route limit, and two full model calls fit");
  const read = (p: string) => readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), p), "utf8");
  assert.match(read("app/api/coach/route.ts"), /export const maxDuration = 60;/);
  assert.match(read("app/api/coach/route.ts"), /deadline: startedAt \+ COACH_BUDGET_MS/);
});

test("time budget: calls made by the same request share it; nothing is sent when too little time is left", async () => {
  resetModelCache();
  const rec = recordTimeouts();
  try {
    const clockMs = { t: 5_000_000 }; let sent = 0;
    const f = (async () => { sent++; return reply("{}"); }) as unknown as typeof fetch;
    const deadline = clockMs.t + 3_000;                       // e.g. the first call used up the budget; the schema-retry call must not start
    await assert.rejects(generateJson({ apiKey: "K", modelOverride: MA, fetch: f, deadline, now: () => clockMs.t, log: quiet }, { system: "s", user: "u" }), (e: unknown) => e instanceof GeminiError && e.kind === "timeout");
    assert.equal(sent, 0); assert.equal(rec.ms.length, 0);
    // with 9 s left the single attempt is cut to what remains (never the full per-model timeout)
    const ok = await generateJson({ apiKey: "K", modelOverride: MA, fetch: f, deadline: clockMs.t + 9_000, now: () => clockMs.t, log: quiet }, { system: "s", user: "u" });
    assert.equal(ok.attempts, 1); assert.ok(rec.ms[0] <= 8_500, `timeout cut to the time left: ${rec.ms[0]}`);
  } finally { rec.restore(); resetModelCache(); }
});

test("summaries: the plain-text caller has the same timeout, fallback and budget; the route uses it and has no unguarded fetch", async () => {
  resetModelCache();
  const bodies: Array<Record<string, unknown>> = [];
  const g = fakeGemini(async (m) => { if (m === MA) throw timeoutErr(); return reply("A short summary."); });
  const wrapped = (async (url: string, init: RequestInit) => { if (!url.includes("/models?")) bodies.push(JSON.parse(String(init.body))); assert.ok(init.signal, "every call has a timeout"); return (g.f as unknown as (u: string, i: RequestInit) => Promise<Response>)(url, init); }) as unknown as typeof fetch;
  const r = await generateText({ apiKey: "K", fetch: wrapped, log: quiet }, { system: "SYS", user: "USER" });
  assert.deepEqual([r.model, r.text], [MB, "A short summary."]);
  assert.ok(bodies.every((b) => !("generationConfig" in b)), "summaries keep their plain-text request (no JSON mode)");
  resetModelCache();
  const route = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "app/api/summarize/route.ts"), "utf8");
  assert.match(route, /generateText\(\{[^}]*deadline: startedAt \+ COACH_BUDGET_MS/);
  assert.ok(!/generativelanguage|await fetch\(/.test(route), "no raw, un-timed fetch left in the route");
  assert.match(route, /export const maxDuration = 60;/);
  assert.match(route, /e instanceof GeminiError/);
});

test("diagnostics: safe, useful log lines (model, attempt, time, category, status, error name) and never keys, prompts or content", async () => {
  resetModelCache();
  const lines: string[] = [];
  const origErr = console.error, origWarn = console.warn;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const structured: Array<Record<string, unknown>> = [];
  try {
    const evil = Object.assign(new Error("https://x.test/?key=KEY123 SECRET-PROMPT"), { name: "https://x.test/?key=KEY123", cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    const g = fakeGemini(async (m, n) => {
      if (n === 1) throw timeoutErr();
      if (n === 2) throw evil;
      if (m === MC && n === 3) return new Response("SECRET-ANSWER KEY123 SECRET-PROMPT", { status: 500 });
      return reply("SECRET-ANSWER");
    });
    await assert.rejects(generateJson({ apiKey: "KEY123", fetch: g.f }, { system: "SYSTEM-SECRET", user: "SECRET-PROMPT health data" }), GeminiError);   // default logger
    resetModelCache();
    const g2 = fakeGemini(async (_m, n) => { if (n === 1) throw timeoutErr(); return reply("SECRET-ANSWER"); });
    await generateJson({ apiKey: "KEY123", fetch: g2.f, log: (a) => { structured.push({ ...a }); } }, { system: "s", user: "SECRET-PROMPT" });
  } finally { console.error = origErr; console.warn = origWarn; resetModelCache(); }
  const all = lines.join("\n");
  for (const secret of ["KEY123", "SECRET-PROMPT", "SECRET-ANSWER", "SYSTEM-SECRET", "health data", "x.test", "generativelanguage", "https://"]) assert.ok(!all.includes(secret), `logs must not contain ${secret}`);
  assert.match(all, /"model":"gemini-3-flash"/); assert.match(all, /"attempt":1/); assert.match(all, /"category":"timeout"/); assert.match(all, /"elapsedMs":\d+/);
  assert.match(all, /"category":"network"[^\n]*"errorCode":"UND_ERR_CONNECT_TIMEOUT"/, "a safe error code is kept, an unsafe error name is dropped");
  assert.match(all, /"category":"http_error"[^\n]*"status":500/);
  assert.deepEqual(structured.map((s) => [s.model, s.attempt, s.category]), [[MA, 1, "timeout"], [MB, 2, "ok"]], "a fallback that worked is logged once as ok");
  for (const s of structured) assert.deepEqual(Object.keys(s).filter((k) => !["model", "attempt", "elapsedMs", "category", "status", "errorName", "errorCode"].includes(k)), [], "only the allowed fields");
});

test("the browser only ever sees a short, safe message when every model fails", async () => {
  resetModelCache();
  const g = fakeGemini(async () => { throw timeoutErr(); });
  const e = await run(g.f).catch((x) => x) as GeminiError;
  assert.equal(e.kind, "timeout"); assert.equal(e.message, "The Coach took too long to answer. Please try again in a moment.");
  assert.ok(!/gemini-|KEY123|http/i.test(e.message));
  resetModelCache();
});

// ------------------------------------------------------------------ the durable limiter client
function fakeCoachLimiter() {
  const rows = new Map<string, number[]>(); let lock: Promise<unknown> = Promise.resolve(); const clock = { now: 1_000_000 };
  const db: RpcDb = { rpc(_fn, a) {
    const run = lock.then(async () => {
      const u = String(a.p_user), hour = Number(a.p_hour_limit), mine = (rows.get(u) ?? []).filter((t) => t >= clock.now - 3_600_000);
      await new Promise((r) => setImmediate(r));
      if (mine.length >= hour) { rows.set(u, mine); return { data: [{ allowed: false, remaining_hour: 0, retry_after_seconds: Math.ceil((mine[0] + 3_600_000 - clock.now) / 1000), usage_id: null }], error: null }; }
      mine.push(clock.now); rows.set(u, mine); return { data: [{ allowed: true, remaining_hour: hour - mine.length, retry_after_seconds: 0, usage_id: `use-${u}-${mine.length}` }], error: null };
    });
    lock = run.catch(() => undefined); return run;
  } };
  return { db, rows, clock };
}
test("Coach rate limiting: independent per user, exact at the threshold, safe under concurrency, fail closed", async () => {
  const { db, rows } = fakeCoachLimiter();
  for (let i = 0; i < 3; i++) assert.equal((await consumeCoachQuota(db, "alice", "chat", 3)).allowed, true);
  const denied = await consumeCoachQuota(db, "alice", "chat", 3);
  assert.deepEqual([denied.allowed, denied.retryAfterSeconds > 0, denied.usageId], [false, true, null]);
  assert.equal((await consumeCoachQuota(db, "bob", "chat", 3)).allowed, true, "another user is unaffected");
  const results = await Promise.all(Array.from({ length: 30 }, () => consumeCoachQuota(db, "carol", "chat", 10)));
  assert.equal(results.filter((r) => r.allowed).length, 10);
  assert.equal(rows.get("carol")!.length, 10);
  await assert.rejects(consumeCoachQuota({ rpc: async () => ({ data: null, error: { message: "x" } }) }, "u", "chat"), QuotaUnavailable);
  await assert.rejects(consumeCoachQuota({ rpc: async () => { throw new Error("net"); } }, "u", "chat"), QuotaUnavailable);
  assert.deepEqual([undefined, "5", "0", "x", "9999"].map((v) => limitFrom(v, 30, 500)), [30, 5, 30, 30, 30]);
});

// ------------------------------------------------------------------ real store + engine against a database stand-in that applies RLS
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function fakeDb(tables: Record<string, Row[]>, o: { uid?: string; rls: boolean; denyWrites?: string[]; denyAll?: string[] }) {
  let counter = 0;
  const from = (name: string) => {
    const rows = (tables[name] ??= []);
    let op = "select", payload: Row | Row[] = {}, lim: number | null = null, ord: [string, boolean] | null = null; const eqs: Array<[string, unknown]> = []; const gtes: Array<[string, string]> = []; const nulls: string[] = [];
    const visible = () => rows.filter((r) => (!o.rls || !("user_id" in r) || r.user_id === o.uid) && eqs.every(([c, v]) => r[c] === v) && gtes.every(([c, v]) => String(r[c]) >= v) && nulls.every((c) => r[c] === null || r[c] === undefined));
    const run = async (): Promise<{ data: unknown; error: { message: string } | null }> => {
      if (o.rls && (o.denyAll ?? []).includes(name)) return { data: null, error: { message: "permission denied" } };                                  // no privileges at all
      if (["insert", "update"].includes(op) && o.rls && (o.denyWrites ?? []).includes(name)) return { data: null, error: { message: "permission denied" } };   // users may read and delete, never insert or update
      if (op === "insert") { const list = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`, created_at: `2026-11-12T10:00:${String(counter).padStart(2, "0")}Z`, updated_at: "2026-11-12T10:00:00Z", ...p })); rows.push(...list); return { data: Array.isArray(payload) ? list : list[0], error: null }; }
      if (op === "update") { const hit = visible(); hit.forEach((r) => Object.assign(r, payload)); return { data: hit.map((r) => ({ id: r.id })), error: null }; }
      if (op === "delete") {
        const hit = visible(); hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        if (name === "coach_conversations") for (const r of hit) { const m = (tables.coach_chat_messages ??= []); for (let i = m.length - 1; i >= 0; i--) if (m[i].conversation_id === r.id) m.splice(i, 1); }
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      let out = visible().map((r) => ({ ...r }));
      if (ord) out.sort((a, b) => (String(a[ord![0]]) < String(b[ord![0]]) ? -1 : 1) * (ord![1] ? 1 : -1));
      if (lim !== null) out = out.slice(0, lim);
      return { data: out, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select() { return b; }, insert(p: Row | Row[]) { op = "insert"; payload = p; return b; }, update(p: Row) { op = "update"; payload = p; return b; }, delete() { op = "delete"; return b; },
      eq(c: string, v: unknown) { eqs.push([c, v]); return b; }, gte(c: string, v: string) { gtes.push([c, v]); return b; }, is(c: string) { nulls.push(c); return b; },
      order(c: string, p?: { ascending?: boolean }) { ord = [c, p?.ascending !== false]; return b; }, limit(n: number) { lim = n; return b; },
      single() { return run().then((r) => ({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error })); },
      maybeSingle() { return run().then((r) => ({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error })); },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return run().then(res, rej); },
    };
    return b;
  };
  return { from, rpc: async () => ({ data: [{ allowed: true, remaining_hour: 29, retry_after_seconds: 0, usage_id: "usage1" }], error: null }) };
}
const world = () => {
  const tables: Record<string, Row[]> = {
    profiles: [{ id: "alice", display_name: "Alice", timezone: "UTC", units: "metric", sleep_goal_h: 8 }, { id: "bob", display_name: "Bob" }],
    activities: [{ id: 1, user_id: "alice", started_at: "2026-11-10T08:00:00Z", sport: "run", duration_s: 3000, distance_m: 8000, load: 50 }, { id: 2, user_id: "bob", started_at: "2026-11-10T08:00:00Z", sport: "run", duration_s: 1, distance_m: 1, load: 1 }],
    coach_conversations: [], coach_chat_messages: [], coach_assessments: [], coach_usage: [{ id: "bobuse", user_id: "bob", tokens_in: null }, { id: "usage1", user_id: "alice", tokens_in: null }],
  };
  const deny = ["coach_conversations", "coach_chat_messages", "coach_assessments"];
  const as = (uid: string) => ({ user: fakeDb(tables, { uid, rls: true, denyWrites: deny, denyAll: ["coach_usage"] }), admin: fakeDb(tables, { rls: false }) });
  return { tables, as };
};
const limits = { hour: 30, day: 150 };

test("end to end: a conversation is created, continued, listed and deleted, always scoped to its owner", async () => {
  const { tables, as } = world();
  const alice = as("alice"), store = createStore(alice.user, alice.admin, "alice", limits);
  const deps = (): CoachDeps => ({ today: TODAY, ...store, generate: async () => ({ text: CHAT_OK, usage: { promptTokens: 50, outputTokens: 10 }, model: "m" }) });
  const r1 = await runCoach(deps(), chat("Am I training too much?", ["activities"]), true);
  const id = (r1 as { conversationId: string }).conversationId;
  assert.ok(id && (r1 as { saved: boolean }).saved);
  assert.deepEqual(tables.coach_conversations.map((c) => [c.user_id, c.title, c.domain]), [["alice", "Am I training too much?", "general"]]);
  assert.deepEqual(tables.coach_chat_messages.map((m) => [m.user_id, m.role]), [["alice", "user"], ["alice", "assistant"]]);
  assert.equal(tables.coach_usage.find((u) => u.id === "usage1")!.tokens_in, 50, "token usage is recorded for the caller's own usage row");
  assert.equal(tables.coach_usage.find((u) => u.id === "bobuse")!.tokens_in, null, "another user's usage row is untouched");

  const seen: string[] = [];
  const r2 = await runCoach({ ...deps(), generate: async (_s, u) => { seen.push(u); return { text: CHAT_OK, usage: { promptTokens: 1, outputTokens: 1 }, model: "m" }; } }, chat("and this week?", ["activities"], { conversationId: id }), true);
  assert.equal((r2 as { conversationId: string }).conversationId, id);
  assert.match(seen[0], /Am I training too much\?/, "history comes from the database, not from the browser");
  assert.equal(tables.coach_chat_messages.length, 4);

  assert.deepEqual((await listConversations(alice.user)).map((c) => c.id), [id]);
  assert.deepEqual((await listMessages(alice.user, id)).map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  const bob = as("bob");
  assert.deepEqual(await listConversations(bob.user), [], "bob sees none of alice's conversations");
  assert.deepEqual(await listMessages(bob.user, id), [], "...or their messages");
  await assert.rejects(deleteConversation(bob.user, id), /not found/i);
  assert.equal(tables.coach_conversations.length, 1);
  await deleteConversation(alice.user, id);
  assert.deepEqual([tables.coach_conversations.length, tables.coach_chat_messages.length], [0, 0], "deleting a conversation removes its messages");
});

test("cross-user isolation: another user's conversation, activity and ownership cannot be reached or forged", async () => {
  const { tables, as } = world();
  const alice = as("alice"), bob = as("bob");
  const aliceStore = createStore(alice.user, alice.admin, "alice", limits), bobStore = createStore(bob.user, bob.admin, "bob", limits);
  const convId = await aliceStore.createConversation("Alice private chat", "general");
  assert.equal(await bobStore.loadConversation(convId), null, "bob cannot load alice's conversation");
  await assert.rejects(bobStore.addMessages(convId, [{ role: "user", content: "injected", meta: {} }]), /not found/i, "bob cannot write into it either");
  assert.equal(tables.coach_chat_messages.length, 0);
  assert.equal(await bobStore.getActivity(1), null, "alice's activity is invisible to bob");
  assert.equal(await aliceStore.getActivity(2), null, "...and bob's to alice");
  assert.ok((await aliceStore.loadActivities(400)).every((a) => a.id !== 2), "only the caller's activities are read");
  const forged = await alice.user.from("coach_assessments").insert({ user_id: "alice", kind: "session", result: {}, score: 100, confidence: "high" });
  assert.equal(forged.error?.message, "permission denied", "users cannot write assessments: no forged scores");
  const forgedMsg = await alice.user.from("coach_chat_messages").insert({ conversation_id: convId, user_id: "alice", role: "assistant", content: "fake coach answer" });
  assert.equal(forgedMsg.error?.message, "permission denied", "...or forged Coach answers");
  const id = await aliceStore.saveAssessment({ kind: "daily", mode: null, sport: null, subject: {}, result: {}, score: null, confidence: "low", categories: [] });
  assert.equal(tables.coach_assessments.find((a) => a.id === id)!.user_id, "alice", "the server forces the verified user id");
  assert.deepEqual((await listAssessments(bob.user)).map((a) => a.id), []);
  await assert.rejects(deleteAssessment(bob.user, id), /not found/i);
  await deleteAssessment(alice.user, id);
  assert.equal(tables.coach_assessments.length, 0);
});

// ------------------------------------------------------------------ static guarantees that are not behaviour
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");
test("migration 12: users read and delete only; usage and limiter are server-only; separate from extraction", () => {
  const sql = read("12_coach.sql").replace(/--.*$/gm, "").toLowerCase();
  assert.match(sql, /grant select, delete on public\.coach_conversations, public\.coach_chat_messages, public\.coach_assessments to authenticated;/);
  assert.ok(!/grant[^;]*\b(insert|update)\b[^;]*to authenticated/.test(sql), "no insert/update for browsers");
  assert.ok(!/create policy[^;]*coach_usage/.test(sql), "coach_usage has no policy");
  assert.ok(!/grant[^;]*coach_usage[^;]*(authenticated|anon)/.test(sql));
  assert.match(sql, /revoke all on function public\.consume_coach_quota\(uuid, text, integer, integer\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.consume_coach_quota\(uuid, text, integer, integer\) to service_role;/);
  assert.ok(sql.indexOf("pg_advisory_xact_lock") < sql.indexOf("select count(*)") && sql.indexOf("select count(*)") < sql.indexOf("insert into public.coach_usage"));
  assert.ok(sql.indexOf("v_now := clock_timestamp()") > sql.indexOf("pg_advisory_xact_lock"));
  assert.match(sql, /security invoker set search_path = public/);
  assert.ok(!/security definer/.test(sql));
  assert.match(sql, /domain in \('general', 'strength'\)/);
  assert.ok(!/biomarker_extract_requests|consume_extraction_quota/.test(sql), "the extraction quota is not reused");
  assert.ok(!/drop table|drop column|alter table public\.coach_messages/.test(sql), "the legacy coach_messages table is untouched");
});

test("the route authenticates first, never trusts a client user id, and keeps content out of logs", () => {
  const route = read("app/api/coach/route.ts");
  assert.ok(route.indexOf("authUser(req)") > 0 && route.indexOf("authUser(req)") < route.indexOf("req.json()"));
  assert.ok(!/body\??\.\s*(user_?id|uid)/i.test(route));
  assert.ok(!/lib\/rateLimit"|consume_extraction/.test(route), "separate from the biomarker extraction limiter");
  // The only logs: limiter unavailable, and the model-error summary (kind, number of attempts, elapsed time: no prompt, answer or user data).
  const logs = route.match(/console\.[a-z]+\([^\n]*\)/g) ?? [];
  assert.equal(logs.length, 2);
  assert.equal(logs[0], 'console.error("coach: rate limiter unavailable")');
  assert.match(logs[1], /^console\.error\("coach: model error", e\.kind, JSON\.stringify\(\{ attempts: e\.attempts\.length, elapsedMs: Date\.now\(\) - startedAt \}\)\)/);
  assert.ok(!/e\.message|prompt|req\.|body/.test(logs[1]));
  assert.match(route, /x-coach-consent/);
  for (const f of ["components/coach/ChatPanel.tsx", "components/coach/SessionEvaluator.tsx", "components/coach/consent.tsx", "app/(app)/coach/page.tsx"]) assert.ok(!/GEMINI_API_KEY|SERVICE_ROLE|api_key/i.test(read(f)), `${f} holds no secrets`);
  assert.match(read("app/(app)/layout.tsx"), /\{ href: "\/coach", label: "Coach" \}/);
});