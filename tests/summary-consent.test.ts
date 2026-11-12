// Regression tests for AI summaries: server-side consent and the durable rate limit. Synthetic data only; Gemini is a recorder.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SummaryError, runSummary, summaryConsent, type Row, type SummaryDeps, type SummaryRequest } from "../lib/summaryService.ts";
import { SUMMARY_SYSTEM } from "../lib/summary.ts";
import { QuotaUnavailable, consumeCoachQuota } from "../lib/coach/quota.ts";

// Distinctive synthetic values, so their presence in a prompt is unambiguous.
const HRV = 93.21, RHR = 37, SLEEP_MIN = 523;                 // -> "HRV 93 ms", "resting HR 37", "8.7 h"
// Values and the sections that carry them. (The "Not shared" line may NAME the category, but never contains a value.)
const WELLNESS_MARKERS = ["93", "resting HR 37", "8.7", "sleep score", "That morning", "Previous 7-day averages", "Recovery this week"];
const act = (id: number, started_at: string, note: string | null, sport = "run"): Row => ({ id, started_at, sport, title: `Session ${id}`, duration_s: 3000, distance_m: 10000, avg_hr: 150, load: 60, note });
const ROWS = [
  act(1, "2026-10-20T07:00:00Z", "OLD-NOTE knee felt odd"),
  act(2, "2026-11-03T07:00:00Z", "WEEK-NOTE-1 tired"),
  act(3, "2026-11-05T07:00:00Z", "WEEK-NOTE-2 private remark"),
  act(4, "2026-11-08T07:00:00Z", "TARGET-NOTE felt strong"),
];

interface Limiter { used: Map<string, number>; limit: number }
const limiter = (limit: number): Limiter => ({ used: new Map(), limit });
/** Atomic like consume_coach_quota: check + record happen together (synchronously), per user, counting every allowed request. */
function consumeFrom(l: Limiter, uid: string) {
  return async (_kind: "session" | "daily") => {
    const n = l.used.get(uid) ?? 0;
    if (n >= l.limit) return { allowed: false, retryAfterSeconds: 1800, usageId: null };
    l.used.set(uid, n + 1);
    return { allowed: true, retryAfterSeconds: 0, usageId: `${uid}-${n + 1}` };
  };
}

function harness(o: { uid?: string; lim?: Limiter; failAsk?: boolean } = {}) {
  const uid = o.uid ?? "user-a", lim = o.lim ?? limiter(100);
  const calls = { prompts: [] as string[], wellnessReads: 0, raceReads: 0, activityReads: 0, outcomes: [] as Array<[string | null, string]>, saved: 0 };
  const deps: SummaryDeps = {
    timezone: async () => "Europe/Lisbon",
    getActivity: async (id) => { calls.activityReads++; return ROWS.find((r) => r.id === id) ?? null; },
    activities: async () => { calls.activityReads++; return ROWS; },
    dailyOn: async () => { calls.wellnessReads++; return { hrv: HRV, rhr: RHR, sleepH: SLEEP_MIN / 60, sleepScore: 81 }; },
    dailyAvg: async () => { calls.wellnessReads++; return { hrv: HRV, rhr: RHR, sleepH: SLEEP_MIN / 60 }; },
    nextRace: async () => { calls.raceReads++; return { name: "SECRET-RACE Marathon", race_date: "2026-12-20" }; },
    consume: consumeFrom(lim, uid),
    recordOutcome: async (id, outcome) => { calls.outcomes.push([id, outcome]); },
    ask: async (p) => { calls.prompts.push(p); if (o.failAsk) throw new Error("gemini 503"); return { text: "Summary text.", model: "gemini-test" }; },
    saveActivitySummary: async () => { calls.saved++; },
    saveWeekSummary: async () => { calls.saved++; },
    now: () => new Date("2026-11-10T09:00:00Z"),
  };
  return { deps, calls, lim };
}
const ACT: SummaryRequest = { kind: "activity", id: 4 };
const WEEK: SummaryRequest = { kind: "week", weekStart: "2026-11-02" };
const grant = (...c: string[]) => summaryConsent(c, "yes");

// ------------------------------------------------------------------ consent
test("all relevant consent granted: activities, load, wellness and races are used; only the summarised activity's note", async () => {
  const h = harness();
  const r = await runSummary(h.deps, ACT, grant("activities", "load", "wellness", "races"));
  const p = h.calls.prompts[0];
  for (const s of ["TARGET-NOTE", "HRV 93 ms", "resting HR 37", "8.7 h", "CTL (fitness)", "SECRET-RACE"]) assert.ok(p.includes(s), s);
  assert.ok(!p.includes("OLD-NOTE"), "earlier sessions never carry their notes");
  assert.ok(!/Not shared by the athlete/.test(p));
  assert.deepEqual(r.used, ["activities", "load", "wellness", "races"]); assert.deepEqual(r.notShared, []);
});

test("all relevant consent declined: no data is read, no quota is used and nothing reaches Gemini", async () => {
  for (const c of [grant(), grant("profile", "biomarkers", "supplements")]) {
    const h = harness();
    await assert.rejects(runSummary(h.deps, WEEK, c), (e: SummaryError) => e.status === 403 && /Recent activities/.test(e.message));
    assert.equal(h.calls.prompts.length, 0); assert.equal(h.calls.activityReads, 0); assert.equal(h.calls.wellnessReads, 0); assert.equal(h.lim.used.size, 0);
  }
});

test("missing consent: without the X-Coach-Consent header (or without a list) nothing is granted, never inferred", async () => {
  for (const c of [summaryConsent(["activities", "wellness", "load", "races"], null), summaryConsent(["activities", "wellness"], "no"), summaryConsent(undefined, "yes"), summaryConsent(null, null)]) {
    assert.equal(c.granted.size, 0);
    const h = harness();
    await assert.rejects(runSummary(h.deps, ACT, c), (e: SummaryError) => e.status === 403);
    assert.equal(h.calls.prompts.length, 0);
  }
  assert.throws(() => summaryConsent(["activities", "everything"], "yes"), (e: SummaryError) => e.status === 400);
  assert.throws(() => summaryConsent("activities", "yes"), (e: SummaryError) => e.status === 400);
  assert.throws(() => summaryConsent(["activities", "activities"], "yes"), (e: SummaryError) => e.status === 400);
});

test("partial consent (activities only): load, wellness and races are left out and named as not shared", async () => {
  const h = harness();
  const r = await runSummary(h.deps, WEEK, grant("activities"));
  const p = h.calls.prompts[0];
  for (const s of [...WELLNESS_MARKERS, "CTL (fitness)", "TSB (form)", "Training load model", "SECRET-RACE", "Next race"]) assert.ok(!p.includes(s), `must not contain ${s}`);
  assert.match(p, /Not shared by the athlete: the training-load model \(CTL, ATL, TSB\); recovery data \(HRV, resting heart rate, sleep\); races\. Do not mention, estimate or imply/);
  assert.equal(h.calls.wellnessReads, 0, "wellness is not even read"); assert.equal(h.calls.raceReads, 0);
  assert.deepEqual(r.used, ["activities"]); assert.equal(r.notShared.length, 3);
  assert.match(SUMMARY_SYSTEM, /do not mention it, estimate it, or imply that it was considered/);
});

test("activity notes: weekly summaries never send notes; an activity summary sends only that activity's note", async () => {
  const w = harness();
  await runSummary(w.deps, WEEK, grant("activities", "load", "wellness", "races"));
  assert.ok(!/NOTE/.test(w.calls.prompts[0]), "no session note in a weekly summary, even with every category granted");
  const a = harness();
  await runSummary(a.deps, ACT, grant("activities"));
  assert.ok(a.calls.prompts[0].includes("TARGET-NOTE") && !a.calls.prompts[0].includes("OLD-NOTE"));
  const none = harness();
  await assert.rejects(runSummary(none.deps, ACT, grant("wellness", "load")));
  assert.equal(none.calls.prompts.length, 0, "no activities consent: the note (and everything else) stays on the server");
});

test("HRV, resting HR and sleep are excluded whenever wellness is not granted (every combination)", async () => {
  const others = ["load", "races"];
  for (let mask = 0; mask < 4; mask++) {
    const cats = ["activities", ...others.filter((_, i) => mask & (1 << i))];
    for (const req of [ACT, WEEK]) {
      const h = harness();
      await runSummary(h.deps, req, grant(...cats));
      const p = h.calls.prompts[0];
      for (const s of WELLNESS_MARKERS) assert.ok(!p.includes(s), `${cats.join("+")} ${req.kind}: ${s}`);
      assert.ok(!p.includes(`resting HR ${RHR}`));
      assert.equal(h.calls.wellnessReads, 0);
    }
  }
});

test("no sensitive wellness value reaches Gemini without consent, whatever else is granted", async () => {
  const all = ["activities", "load", "races", "profile", "biomarkers", "supplements"];
  const h = harness();
  await runSummary(h.deps, ACT, grant(...all));
  await runSummary(h.deps, WEEK, grant(...all));
  for (const p of h.calls.prompts) {
    for (const s of WELLNESS_MARKERS) assert.ok(!p.includes(s), s);
    // Outside the single "Not shared" line, wellness terms do not appear at all.
    const body = p.split("\n").filter((l) => !l.startsWith("Not shared by the athlete")).join("\n");
    for (const s of ["HRV", "resting heart rate", "resting HR", "sleep"]) assert.ok(!body.includes(s), s);
  }
});

test("the Coach's own consent behaviour is unchanged", () => {
  const route = readFileSync(new URL("../app/api/coach/route.ts", import.meta.url), "utf8");
  assert.match(route, /req\.headers\.get\("x-coach-consent"\) === "yes"/);
  const engine = readFileSync(new URL("../lib/coach/engine.ts", import.meta.url), "utf8");
  assert.match(engine, /if \(req\.categories\.length > 0 && !consent\) throw new CoachError\(400/);
});

// ------------------------------------------------------------------ rate limiting
test("normal request: one quota unit is taken before Gemini is called, and the outcome is recorded", async () => {
  const h = harness();
  const order: string[] = [];
  const consume = h.deps.consume, ask = h.deps.ask;
  h.deps.consume = async (k) => { order.push("consume"); return consume(k); };
  h.deps.ask = async (p) => { order.push("ask"); return ask(p); };
  await runSummary(h.deps, ACT, grant("activities"));
  assert.deepEqual(order, ["consume", "ask"]);
  assert.equal(h.lim.used.get("user-a"), 1); assert.deepEqual(h.calls.outcomes, [["user-a-1", "ok"]]);
});

test("bad requests cost nothing: unknown activity or an empty week does not consume quota", async () => {
  const h = harness();
  await assert.rejects(runSummary(h.deps, { kind: "activity", id: 999 }, grant("activities")), (e: SummaryError) => e.status === 404);
  await assert.rejects(runSummary(h.deps, { kind: "week", weekStart: "2026-01-05" }, grant("activities")), (e: SummaryError) => e.status === 400);
  assert.equal(h.lim.used.size, 0);
});

test("client timestamp manipulation cannot reset the limit (the limit no longer reads user-editable columns)", async () => {
  const lim = limiter(2);
  const h = harness({ lim });
  await runSummary(h.deps, ACT, grant("activities"));
  await runSummary(h.deps, ACT, grant("activities"));
  // An attacker clears ai_summary_at / weekly_summaries.created_at in their own rows: irrelevant to the server-side counter.
  h.deps.saveActivitySummary = async () => undefined;
  await assert.rejects(runSummary(h.deps, ACT, grant("activities")), (e: SummaryError) => e.status === 429);
  const route = readFileSync(new URL("../app/api/summarize/route.ts", import.meta.url), "utf8");
  assert.ok(!/enforceLimit|gte\("ai_summary_at"|gte\("created_at"|SUMMARY_DAILY_LIMIT/.test(route), "the old client-editable counter is gone");
  assert.match(route, /consumeCoachQuota\(admin, uid, kind/, "the durable server-side limiter is used, bound to the verified user");
});

test("failed Gemini attempts count towards the limit and are recorded as errors", async () => {
  const lim = limiter(2);
  const h = harness({ lim, failAsk: true });
  for (let i = 0; i < 2; i++) await assert.rejects(runSummary(h.deps, ACT, grant("activities")), /gemini 503/);
  assert.equal(lim.used.get("user-a"), 2);
  assert.deepEqual(h.calls.outcomes.map(([, o]) => o), ["error", "error"]);
  await assert.rejects(runSummary(h.deps, ACT, grant("activities")), (e: SummaryError) => e.status === 429);
  assert.equal(h.calls.prompts.length, 2, "the third attempt never reaches Gemini");
});

test("concurrent requests cannot exceed the limit", async () => {
  const lim = limiter(3);
  const h = harness({ lim });
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => runSummary(h.deps, WEEK, grant("activities"))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(results.filter((r) => r.status === "rejected" && (r.reason as SummaryError).status === 429).length, 7);
  assert.equal(h.calls.prompts.length, 3);
});

test("per-user isolation: one user's usage never affects another's", async () => {
  const lim = limiter(1);
  const a = harness({ uid: "user-a", lim }), b = harness({ uid: "user-b", lim });
  await runSummary(a.deps, ACT, grant("activities"));
  await assert.rejects(runSummary(a.deps, ACT, grant("activities")), (e: SummaryError) => e.status === 429);
  await runSummary(b.deps, ACT, grant("activities"));
  assert.deepEqual([...lim.used.entries()], [["user-a", 1], ["user-b", 1]]);
});

test("rate-limit response: 429 with a clear message and Retry-After; an unavailable limiter fails closed", async () => {
  const h = harness({ lim: limiter(0) });
  await assert.rejects(runSummary(h.deps, ACT, grant("activities")), (e: SummaryError) => e.status === 429 && e.extra.retryAfterSeconds === 1800 && /about 30 minutes/.test(e.message));
  const route = readFileSync(new URL("../app/api/summarize/route.ts", import.meta.url), "utf8");
  assert.match(route, /"Retry-After": retry/);
  assert.match(route, /e instanceof QuotaUnavailable[\s\S]*status: 503/);
  // The real limiter client: a database error or a missing function means QuotaUnavailable (so the route returns 503, no AI call).
  const sent: Array<Record<string, unknown>> = [];
  const db = { rpc: async (_fn: string, args: Record<string, unknown>) => { sent.push(args); return { data: null, error: { message: "function consume_coach_quota does not exist" } }; } };
  await assert.rejects(consumeCoachQuota(db, "user-a", "daily", 30, 150), QuotaUnavailable);
  assert.equal(sent[0].p_user, "user-a"); assert.equal(sent[0].p_kind, "daily");
  const down = harness();
  down.deps.consume = async () => { throw new QuotaUnavailable("limiter failed"); };
  await assert.rejects(runSummary(down.deps, ACT, grant("activities")), QuotaUnavailable);
  assert.equal(down.calls.prompts.length, 0);
});
