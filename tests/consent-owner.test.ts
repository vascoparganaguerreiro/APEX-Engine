// Account-consistency check: every consent-bearing AI request names the account its consent was loaded for, and the server rejects a
// verified session of another account with 403 before reading data or calling the AI. Simulates a sign-in to account B in another tab
// while this tab still holds account A's consent. Synthetic ids and data only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACCOUNT_MISMATCH_MESSAGE, CONSENT_USER_HEADER, ConsentOwnerMismatch, assertConsentOwner, consentRequestHeaders, sameAccount,
} from "../lib/consentOwner.ts";
import { SummaryError, runSummary, summaryConsent, type Row, type SummaryDeps, type SummaryRequest } from "../lib/summaryService.ts";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const TOKENS: Record<string, string> = { "token-A": A, "token-B": B };
const WELLNESS_CATS = ["activities", "wellness", "load", "races"];

// ------------------------------------------------------------------ the check itself
test("sameAccount: only two valid, equal user ids match", () => {
  assert.equal(sameAccount(A, A), true);
  assert.equal(sameAccount(A.toUpperCase(), ` ${A} `), true, "case and surrounding spaces do not matter");
  assert.equal(sameAccount(A, B), false);
  for (const bad of [null, undefined, "", "yes", "*", `${A},${B}`, 42, {}]) { assert.equal(sameAccount(bad, A), false, String(bad)); assert.equal(sameAccount(A, bad), false); }
  assert.equal(sameAccount(null, null), false, "two missing ids never match");
});

test("server check: a mismatched, missing or malformed consent owner is a 403; the matching owner passes", () => {
  const req = (h: Record<string, string>) => new Request("http://local.test/api/coach", { method: "POST", headers: h });
  assert.doesNotThrow(() => assertConsentOwner(req({ [CONSENT_USER_HEADER]: A }).headers, A));
  assert.doesNotThrow(() => assertConsentOwner(req({ "x-consent-user": A.toUpperCase() }).headers, A), "header names are case-insensitive");
  for (const h of [{ [CONSENT_USER_HEADER]: A }, {}, { [CONSENT_USER_HEADER]: "" }, { [CONSENT_USER_HEADER]: "not-a-uuid" }]) {
    assert.throws(() => assertConsentOwner(req(h).headers, B), (e: unknown) => e instanceof ConsentOwnerMismatch && e.status === 403 && e.message === ACCOUNT_MISMATCH_MESSAGE);
  }
});

test("client: nothing is sent while consent is loading or when the session belongs to another account", () => {
  assert.deepEqual(consentRequestHeaders(WELLNESS_CATS, A, A), { [CONSENT_USER_HEADER]: A, "X-Coach-Consent": "yes" });
  assert.deepEqual(consentRequestHeaders([], A, A), { [CONSENT_USER_HEADER]: A }, "the account is named even when nothing is shared");
  assert.throws(() => consentRequestHeaders(WELLNESS_CATS, A, B), ConsentOwnerMismatch, "tab holds A's consent, session is now B");
  assert.throws(() => consentRequestHeaders(WELLNESS_CATS, null, A), ConsentOwnerMismatch, "consent still loading");
  assert.throws(() => consentRequestHeaders([], A, null), ConsentOwnerMismatch, "signed out");
});

// ------------------------------------------------------------------ cross-tab switch, end to end on the server side
/** Counts every read and AI call, so a rejected request can be proven to have touched nothing. */
function summaryDeps(rowsOwner: string) {
  const n = { reads: 0, wellness: 0, quota: 0, ai: 0 };
  const rows: Row[] = [{ id: 7, started_at: "2026-11-05T07:00:00Z", sport: "run", title: `${rowsOwner} tempo`, duration_s: 3000, distance_m: 10000, avg_hr: 150, load: 60, note: `${rowsOwner}-NOTE` }];
  const deps: SummaryDeps = {
    timezone: async () => { n.reads++; return "UTC"; },
    getActivity: async (id) => { n.reads++; return rows.find((r) => r.id === id) ?? null; },
    activities: async () => { n.reads++; return rows; },
    dailyOn: async () => { n.wellness++; return { hrv: 91, rhr: 38, sleepH: 8.1, sleepScore: 80 }; },
    dailyAvg: async () => { n.wellness++; return { hrv: 90, rhr: 39, sleepH: 8 }; },
    nextRace: async () => { n.reads++; return null; },
    consume: async () => { n.quota++; return { allowed: true, retryAfterSeconds: 0, usageId: "u" }; },
    recordOutcome: async () => undefined,
    ask: async () => { n.ai++; return { text: "ok", model: "m" }; },
    saveActivitySummary: async () => undefined, saveWeekSummary: async () => undefined,
    now: () => new Date("2026-11-12T09:00:00Z"),
  };
  return { deps, n };
}
/** The order app/api/summarize/route.ts and app/api/coach/route.ts use: verify the token, check the consent owner, only then work. */
async function serverHandle(headers: Record<string, string>, _body: { categories: string[] }, work: (uid: string, h: Headers) => Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const h = new Headers(headers);
  const uid = TOKENS[(h.get("authorization") ?? "").replace(/^Bearer\s+/i, "")];
  if (!uid) return { status: 401, body: { error: "Please sign in again." } };
  try {
    assertConsentOwner(h, uid);
    return { status: 200, body: await work(uid, h) };
  } catch (e) {
    if (e instanceof ConsentOwnerMismatch) return { status: 403, body: { error: e.message } };
    if (e instanceof SummaryError) return { status: e.status, body: { error: e.message } };
    throw e;
  }
}
const summaryWork = (deps: SummaryDeps, r: SummaryRequest, cats: string[]) => (_uid: string, h: Headers) => runSummary(deps, r, summaryConsent(cats, h.get("x-coach-consent")));

for (const [label, r] of [["activity summary", { kind: "activity", id: 7 }], ["weekly summary", { kind: "week", weekStart: "2026-11-02" }]] as const) {
  test(`cross-tab switch (${label}): B's token with A's consent is rejected with 403 before any read, quota or AI call`, async () => {
    // Tab 1 loaded A's consent (wellness on). Tab 2 signed in as B, so the shared session now holds B's token.
    const { deps, n } = summaryDeps("B");
    const res = await serverHandle({ Authorization: "Bearer token-B", [CONSENT_USER_HEADER]: A, "X-Coach-Consent": "yes" }, { categories: WELLNESS_CATS }, summaryWork(deps, r, WELLNESS_CATS));
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: ACCOUNT_MISMATCH_MESSAGE });
    assert.deepEqual(n, { reads: 0, wellness: 0, quota: 0, ai: 0 }, "B's data never read, no quota used, Gemini never called");
    // The client refuses before sending at all.
    assert.throws(() => consentRequestHeaders(WELLNESS_CATS, A, B), ConsentOwnerMismatch);
  });

  test(`cross-tab switch (${label}): a request without the consent owner is rejected the same way`, async () => {
    const { deps, n } = summaryDeps("B");
    const res = await serverHandle({ Authorization: "Bearer token-B", "X-Coach-Consent": "yes" }, { categories: WELLNESS_CATS }, summaryWork(deps, r, WELLNESS_CATS));
    assert.equal(res.status, 403); assert.deepEqual(n, { reads: 0, wellness: 0, quota: 0, ai: 0 });
  });

  test(`${label}: matching account and consent works as before (the owner id is not consent)`, async () => {
    const ok = summaryDeps("A");
    const res = await serverHandle({ Authorization: "Bearer token-A", ...consentRequestHeaders(WELLNESS_CATS, A, A) }, { categories: WELLNESS_CATS }, summaryWork(ok.deps, r, WELLNESS_CATS));
    assert.equal(res.status, 200); assert.equal(ok.n.ai, 1); assert.ok(ok.n.wellness > 0);
    // A correct owner id grants nothing by itself: without the consent header/categories the summary is refused (403, no AI).
    const none = summaryDeps("A");
    const refused = await serverHandle({ Authorization: "Bearer token-A", [CONSENT_USER_HEADER]: A }, { categories: [] }, summaryWork(none.deps, r, []));
    assert.equal(refused.status, 403); assert.equal(none.n.ai, 0); assert.equal(none.n.wellness, 0);
  });
}

test("cross-tab switch (Coach): B's token with A's consent never reaches the Coach engine", async () => {
  let engineCalls = 0;
  const coach = async () => { engineCalls++; return { kind: "daily" }; };
  const res = await serverHandle({ Authorization: "Bearer token-B", [CONSENT_USER_HEADER]: A, "X-Coach-Consent": "yes" }, { categories: WELLNESS_CATS }, coach);
  assert.equal(res.status, 403); assert.equal(engineCalls, 0);
  const ok = await serverHandle({ Authorization: "Bearer token-B", ...consentRequestHeaders(WELLNESS_CATS, B, B) }, { categories: WELLNESS_CATS }, coach);
  assert.equal(ok.status, 200); assert.equal(engineCalls, 1, "B with B's own consent still works");
  assert.equal((await serverHandle({ [CONSENT_USER_HEADER]: A }, { categories: [] }, coach)).status, 401, "no token: still 401, not 403");
});

// ------------------------------------------------------------------ wiring: both routes check first; every caller sends the owner
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("wiring: /api/coach and /api/summarize check the consent owner right after verifying the session", () => {
  for (const f of ["app/api/coach/route.ts", "app/api/summarize/route.ts"]) {
    const src = read(f);
    assert.match(src, /const \{ sb, uid \} = await authUser\(req\);\s*\n\s*assertConsentOwner\(req\.headers, uid\);/, `${f}: the check is the first thing after authUser`);
    assert.ok(src.indexOf("assertConsentOwner(req.headers, uid)") < src.indexOf("req.json()"), `${f}: before the body is read`);
    assert.match(src, /if \(e instanceof ConsentOwnerMismatch\) return Response\.json\(\{ error: e\.message \}, \{ status: 403 \}\);/);
  }
});

test("wiring: every consent-bearing request names its account", () => {
  const api = read("lib/api.ts");
  assert.equal((api.match(/consentRequestHeaders\(categories, consentUser, data\.session\?\.user\?\.id\)/g) ?? []).length, 2, "summarize and coachRequest");
  assert.ok(!/categories\.length \? \{ "X-Coach-Consent": "yes" \}/.test(api), "no request path without the owner");
  const calls: Array<[string, RegExp, number]> = [
    ["app/(app)/activities/page.tsx", /summarize\(\{ kind: "(activity|week)"[^)]*\}, authorizedOf\(consent\), consentUser\)/g, 2],
    ["app/(app)/coach/page.tsx", /coachRequest\(\{ intent: "daily" \}, authorized, consentUser\)/g, 1],
    ["app/(app)/coach/page.tsx", /consentUser=\{consentUser\}/g, 3],
    ["components/coach/ChatPanel.tsx", /coachRequest\([^;]*, authorized, consentUser\)/g, 1],
    ["components/coach/SessionEvaluator.tsx", /coachRequest\(body, authorized, consentUser\)/g, 1],
    ["components/today/CoachInsight.tsx", /coachRequest\(\{ intent: "daily" \}, authorized, consentUser\)/g, 1],
    ["components/strength/AskApex.tsx", /coachRequest\([^;]*, cats, consentOwner\)/g, 1],   // the owner the consent was loaded for, not the current session
    ["app/(app)/strength/history/[id]/page.tsx", /\["strength"\], askC\.owner\)/g, 1],   // the consent owner (Ask APEX store), not the current session
  ];
  for (const [f, re, count] of calls) assert.equal((read(f).match(re) ?? []).length, count, f);
  assert.match(read("components/coach/consent.tsx"), /return \[consent, save, ready, ready \? uid : null\];/, "the owner is only known once consent is loaded");
});
