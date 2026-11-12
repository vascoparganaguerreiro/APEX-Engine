// Service tests with an in-memory database and mocked provider HTTP responses (no network, no real credentials).
import test from "node:test";
import assert from "node:assert/strict";
import { FakeDb, json, noSleep, ops, scriptedFetch } from "./integrations-fakes.ts";
import { ReauthRequired, aad, loadTokens, saveTokens, validAccessToken } from "../lib/integrations/tokenStore.ts";
import { OAuthError, type TokenSet } from "../lib/integrations/oauth.ts";
import { collect, mapWhoop, refreshTokens, whoopConfig, whoopRange, WhoopError } from "../lib/integrations/whoop.ts";
import { runWhoopSync } from "../lib/integrations/whoopSync.ts";
import { acquireLease, finishError, markConnected, SyncBusy, SyncDeferred, backoffUntil, readConn } from "../lib/integrations/syncState.ts";
import { dateWindows, getList, isStravaStub, mapActivityTz, readRange, syncRange, wellnessObservations } from "../lib/integrations/intervalsGateway.ts";
import { runIntervalsSync } from "../lib/integrations/intervalsSync.ts";
import { disconnectProvider } from "../lib/integrations/disconnect.ts";
import { mergeSync, type MetricRow } from "../lib/provenance.ts";
import { mergeProviderDaily } from "../lib/integrations/normalize.ts";
import type { Db } from "../lib/connectionStore.ts";

const NOW = new Date("2026-11-12T10:00:00Z");
const tokens = (o: Partial<TokenSet> = {}): TokenSet => ({ accessToken: "AT-1", refreshToken: "RT-1", expiresAt: "2026-11-12T11:00:00.000Z", scopes: ["read:recovery", "offline"], externalUserId: null, ...o });
const CFG = whoopConfig({ WHOOP_CLIENT_ID: "cid", WHOOP_CLIENT_SECRET: "csecret", WHOOP_REDIRECT_URI: "https://staging.example.test/api/integrations/whoop/callback" })!;
const asDb = (d: FakeDb) => d as unknown as Db;

// ------------------------------------------------------------------ token encryption, isolation, refresh rotation
test("tokens are encrypted at rest and bound to user and provider (cross-user isolation)", async () => {
  const db = new FakeDb();
  await saveTokens(asDb(db), ops, "user-a", "whoop", tokens({ accessToken: "ACCESS-SECRET", refreshToken: "REFRESH-SECRET" }), NOW);
  const row = db.rows("provider_credentials")[0];
  assert.ok(!JSON.stringify(row).includes("ACCESS-SECRET") && !JSON.stringify(row).includes("REFRESH-SECRET"), "no plaintext stored");
  assert.equal((await loadTokens(asDb(db), ops, "user-a", "whoop"))!.accessToken, "ACCESS-SECRET");
  assert.equal(await loadTokens(asDb(db), ops, "user-b", "whoop"), null, "another user sees nothing");
  db.rows("provider_credentials").push({ ...row, user_id: "user-b" });                          // a row copied to another user...
  await assert.rejects(loadTokens(asDb(db), ops, "user-b", "whoop"), ReauthRequired, "...fails authentication (AAD)");
  db.rows("provider_credentials").push({ ...row, provider: "intervals" });                       // ...or to another provider
  await assert.rejects(loadTokens(asDb(db), ops, "user-a", "intervals"), ReauthRequired);
  db.rows("provider_credentials")[0].access_token_enc = row.refresh_token_enc;                  // refresh blob in the access slot
  await assert.rejects(loadTokens(asDb(db), ops, "user-a", "whoop"), ReauthRequired);
  assert.equal(aad("u", "whoop", "access"), "u|whoop|access");
});

test("refresh: an expiring token is refreshed once, the rotated pair replaces the old one, rev increases", async () => {
  const db = new FakeDb();
  await saveTokens(asDb(db), ops, "u", "whoop", tokens({ expiresAt: "2026-11-12T10:00:30.000Z" }), NOW);
  let calls = 0;
  const t = await validAccessToken(asDb(db), ops, "u", "whoop", async (rt) => { calls++; assert.equal(rt, "RT-1"); return tokens({ accessToken: "AT-2", refreshToken: "RT-2" }); }, NOW);
  assert.equal(t, "AT-2"); assert.equal(calls, 1);
  const s = (await loadTokens(asDb(db), ops, "u", "whoop"))!;
  assert.equal(s.refreshToken, "RT-2"); assert.equal(s.rev, 2);
  assert.equal(await validAccessToken(asDb(db), ops, "u", "whoop", async () => { throw new Error("must not refresh"); }, NOW), "AT-2");
});

test("refresh races and failures: loser uses the winner's token; a rejected refresh requires reconnecting", async () => {
  const db = new FakeDb();
  await saveTokens(asDb(db), ops, "u", "whoop", tokens({ expiresAt: "2026-11-12T09:00:00.000Z" }), NOW);
  // Another request refreshes while ours is in flight; WHOOP then rejects our (now invalid) refresh token.
  const t = await validAccessToken(asDb(db), ops, "u", "whoop", async () => {
    await saveTokens(asDb(db), ops, "u", "whoop", tokens({ accessToken: "AT-WINNER", refreshToken: "RT-W" }), NOW);
    throw new OAuthError(401, "invalid_grant", "rejected");
  }, NOW);
  assert.equal(t, "AT-WINNER");
  // Refresh rejected and nobody else refreshed -> reauth.
  const db2 = new FakeDb();
  await saveTokens(asDb(db2), ops, "u", "whoop", tokens({ expiresAt: "2026-11-12T09:00:00.000Z" }), NOW);
  await assert.rejects(validAccessToken(asDb(db2), ops, "u", "whoop", async () => { throw new OAuthError(401, "invalid_grant", "x"); }, NOW), ReauthRequired);
  // Expired and no refresh token -> reauth. Not connected at all -> reauth.
  const db3 = new FakeDb();
  await saveTokens(asDb(db3), ops, "u", "whoop", tokens({ expiresAt: "2026-11-12T09:00:00.000Z", refreshToken: null }), NOW);
  await assert.rejects(validAccessToken(asDb(db3), ops, "u", "whoop", async () => tokens(), NOW), ReauthRequired);
  await assert.rejects(validAccessToken(asDb(new FakeDb()), ops, "u", "whoop", async () => tokens(), NOW), ReauthRequired);
});

test("refresh request is a form POST to WHOOP's token URL with the offline scope; the secret is never in the URL", async () => {
  const { fetch, log } = scriptedFetch([{ when: (u) => u === "https://api.prod.whoop.com/oauth/oauth2/token", reply: (_u, init) => {
    const f = new URLSearchParams(String(init?.body));
    assert.equal(f.get("grant_type"), "refresh_token"); assert.equal(f.get("scope"), "offline"); assert.equal(f.get("client_secret"), "csecret");
    return json({ access_token: "N", refresh_token: "NR", expires_in: 3600, scope: "offline" });
  } }]);
  const t = await refreshTokens(CFG, "RT", fetch, NOW);
  assert.equal(t.accessToken, "N"); assert.ok(!log[0].url.includes("csecret"));
  const bad = scriptedFetch([{ when: () => true, reply: () => json({ error: "invalid_grant", error_description: "token RT-SECRET is bad" }, 400) }]);
  await assert.rejects(refreshTokens(CFG, "RT-SECRET", bad.fetch, NOW), (e: OAuthError) => e.status === 401 && !e.message.includes("RT-SECRET"));
});

// ------------------------------------------------------------------ WHOOP client
const page = (records: unknown[], next?: string) => json({ records, ...(next ? { next_token: next } : {}) });

test("WHOOP pagination follows next_token with limit 25 and the requested window", async () => {
  const { fetch, log } = scriptedFetch([
    { when: (u) => u.includes("/v2/cycle") && !u.includes("nextToken"), reply: () => page([{ id: 1 }, { id: 2 }], "p2") },
    { when: (u) => u.includes("nextToken=p2"), reply: () => page([{ id: 3 }], "p3") },
    { when: (u) => u.includes("nextToken=p3"), reply: () => page([{ id: 4 }]) },
  ]);
  const out = await collect("/v2/cycle", "TOKEN", "2026-11-01T00:00:00.000Z", "2026-11-12T00:00:00.000Z", { fetchImpl: fetch, sleep: noSleep });
  assert.deepEqual(out.map((r) => r.id), [1, 2, 3, 4]);
  assert.equal(log.length, 3);
  const q = new URL(log[0].url).searchParams;
  assert.equal(q.get("limit"), "25"); assert.equal(q.get("start"), "2026-11-01T00:00:00.000Z");
  assert.equal(log[0].auth, "Bearer TOKEN");
});

test("WHOOP rate limits: a short reset is waited out once; a long one stops with a retry time; 401 asks to reconnect", async () => {
  let n = 0; const slept: number[] = [];
  const short = scriptedFetch([{ when: () => true, reply: () => (n++ === 0 ? json({}, 429, { "x-ratelimit-reset": "2" }) : page([{ id: 1 }])) }]);
  assert.equal((await collect("/v2/cycle", "T", "a", "b", { fetchImpl: short.fetch, sleep: async (ms) => { slept.push(ms); } })).length, 1);
  assert.deepEqual(slept, [2000]);
  const long = scriptedFetch([{ when: () => true, reply: () => json({}, 429, { "x-ratelimit-reset": "120" }) }]);
  await assert.rejects(collect("/v2/cycle", "T", "a", "b", { fetchImpl: long.fetch, sleep: noSleep, now: () => NOW }), (e: WhoopError) => e.status === 429 && e.retryAt === "2026-11-12T10:02:00.000Z");
  const unauth = scriptedFetch([{ when: () => true, reply: () => json({}, 401) }]);
  await assert.rejects(collect("/v2/cycle", "T", "a", "b", { fetchImpl: unauth.fetch, sleep: noSleep }), (e: WhoopError) => e.reauth);
  let m = 0;
  const flaky = scriptedFetch([{ when: () => true, reply: () => (m++ === 0 ? json({}, 503) : page([])) }]);
  assert.deepEqual(await collect("/v2/cycle", "T", "a", "b", { fetchImpl: flaky.fetch, sleep: noSleep }), [], "one retry after a 5xx");
});

const RAW = () => ({
  cycles: [
    { id: 93845, start: "2026-11-09T04:00:00.000Z", end: "2026-11-10T04:30:00.000Z", timezone_offset: "-05:00", score_state: "SCORED", score: { strain: 12.4, kilojoule: 9000, average_heart_rate: 70, max_heart_rate: 160 } },
    { id: 93846, start: "2026-11-10T04:30:00.000Z", timezone_offset: "-05:00", score_state: "PENDING_SCORE" },
  ],
  recoveries: [
    { cycle_id: 93845, sleep_id: "s-1", score_state: "SCORED", score: { user_calibrating: false, recovery_score: 44, resting_heart_rate: 64, hrv_rmssd_milli: 31.81, spo2_percentage: 95.6, skin_temp_celsius: 33.7 } },
    { cycle_id: 93846, sleep_id: "s-2", score_state: "PENDING_SCORE" },
  ],
  sleeps: [
    { id: "s-1", start: "2026-11-10T03:00:00.000Z", end: "2026-11-10T11:00:00.000Z", timezone_offset: "-05:00", nap: false, score_state: "SCORED",
      score: { stage_summary: { total_light_sleep_time_milli: 14_400_000, total_slow_wave_sleep_time_milli: 5_400_000, total_rem_sleep_time_milli: 6_000_000 }, respiratory_rate: 16.1, sleep_performance_percentage: 98, sleep_efficiency_percentage: 91, sleep_consistency_percentage: 90 } },
    { id: "nap-1", start: "2026-11-10T18:00:00.000Z", end: "2026-11-10T18:30:00.000Z", timezone_offset: "-05:00", nap: true, score_state: "SCORED", score: { stage_summary: {} } },
  ],
  workouts: [
    { id: "w-1", start: "2026-11-10T22:00:00.000Z", end: "2026-11-10T23:00:00.000Z", timezone_offset: "-05:00", sport_name: "running", score_state: "SCORED",
      score: { strain: 8.25, average_heart_rate: 140.4, max_heart_rate: 171, kilojoule: 2500, distance_meter: 10000 } },
  ],
  body: { height_meter: 1.8288, weight_kilogram: 90.7, max_heart_rate: 200 },
});

test("WHOOP mapping: scored records only, recovery dated by its sleep's local morning, vendor scores kept apart, naps ignored", () => {
  const b = mapWhoop(RAW(), NOW);
  const get = (metric: string, rec?: string) => b.observations.find((o) => o.metric === metric && (!rec || o.source_record_id === rec));
  assert.equal(b.pending, 2, "pending cycle + pending recovery are counted, never guessed");
  const rec = get("whoop.recovery_score")!;
  assert.equal(rec.value, 44); assert.equal(rec.local_day, "2026-11-10"); assert.equal(rec.provider, "whoop"); assert.equal(rec.transport, "direct");
  assert.equal(get("hrv_rmssd_ms")!.value, 31.81); assert.equal(get("resting_hr_bpm")!.value, 64);
  assert.equal(get("sleep_minutes")!.value, 430, "light + deep + REM, awake time excluded");
  assert.equal(get("sleep_minutes")!.local_day, "2026-11-10");
  assert.ok(!b.observations.some((o) => o.source_record_id === "sleep:nap-1"));
  assert.equal(get("whoop.day_strain")!.local_day, "2026-11-08", "cycle start 23:00 local on the 8th");
  assert.equal(get("whoop.workout_strain")!.value, 8.25);
  assert.equal(get("height_cm")!.value, 182.9);
  assert.ok(!b.observations.some((o) => o.metric === ("load" as never)));
  const w = b.workouts[0];
  assert.deepEqual({ sport: w.sport, dur: w.duration_s, avg: w.avg_hr, kcal: w.calories }, { sport: "run", dur: 3600, avg: 140, kcal: 598 });
  assert.ok(!("load" in w), "strain is never offered as training load");
  const cal = RAW(); (cal.recoveries[0].score as Record<string, unknown>).user_calibrating = true;
  assert.equal(mapWhoop(cal, NOW).observations.find((o) => o.metric === "hrv_rmssd_ms")!.quality, "approximate_day", "calibrating values never fill daily data");
});

test("WHOOP incremental range: first sync 90 days, then last success minus 3 days", () => {
  assert.equal(whoopRange(NOW, null).start, "2026-08-14T10:00:00.000Z");
  assert.equal(whoopRange(NOW, "2026-11-11T08:00:00.000Z").start, "2026-11-08T08:00:00.000Z");
});

// ------------------------------------------------------------------ WHOOP sync end to end
function whoopApi(raw = RAW()) {
  return scriptedFetch([
    { when: (u) => u.includes("/v2/cycle"), reply: () => page(raw.cycles) },
    { when: (u) => u.includes("/v2/recovery"), reply: () => page(raw.recoveries) },
    { when: (u) => u.includes("/v2/activity/sleep"), reply: () => page(raw.sleeps) },
    { when: (u) => u.includes("/v2/activity/workout"), reply: () => page(raw.workouts) },
    { when: (u) => u.includes("/v2/user/measurement/body"), reply: () => json(raw.body) },
  ]);
}
async function connectedWhoop(settings: Record<string, boolean> = {}) {
  const admin = new FakeDb(), user = new FakeDb();
  await saveTokens(asDb(admin), ops, "u1", "whoop", tokens(), NOW);
  await markConnected(asDb(admin), "u1", "whoop", "direct", { externalUserId: null, scopes: ["offline"] }, NOW);
  admin.rows("provider_connections")[0].settings = settings;
  const daily: Record<string, unknown>[] = [];
  user.rpcs.set("apply_provider_daily_metrics", (args) => { const rows = args.p_rows as Record<string, unknown>[]; daily.push(...rows); return { data: rows.length, error: null }; });
  return { admin, user, daily };
}

test("WHOOP sync: saves observations as the user, records success, and leaves daily data and activities alone by default", async () => {
  const { admin, user, daily } = await connectedWhoop();
  const api = whoopApi();
  const r = await runWhoopSync({ admin: asDb(admin), user: user as never, ops, cfg: CFG, uid: "u1", deps: { fetchImpl: api.fetch, sleep: noSleep }, now: NOW });
  assert.ok(r.observations > 10);
  assert.ok(user.rows("metric_observations").every((o) => o.user_id === "u1"));
  assert.equal(daily.length, 0, "fill_daily is off by default");
  assert.equal(user.rows("activities").length, 0, "workout import is off by default");
  const c = admin.rows("provider_connections")[0];
  assert.equal(c.status, "connected"); assert.equal(c.last_success_at, NOW.toISOString()); assert.equal(c.lease_until, null); assert.equal(c.failures, 0);
  assert.ok(api.log.every((l) => l.auth === "Bearer AT-1"));
  // idempotent: a second sync updates the same rows, it does not duplicate them
  const before = user.rows("metric_observations").length;
  await runWhoopSync({ admin: asDb(admin), user: user as never, ops, cfg: CFG, uid: "u1", deps: { fetchImpl: whoopApi().fetch, sleep: noSleep }, now: new Date("2026-11-12T10:30:00Z") });
  assert.equal(user.rows("metric_observations").length, before);
  assert.equal(user.rows("metric_observations")[0].imported_at, "first", "the first import time is kept");
});

test("WHOOP sync with the user's choices: fills only daily rMSSD/RHR/sleep for exact days, imports workouts without load", async () => {
  const { admin, user, daily } = await connectedWhoop({ fill_daily: true, import_workouts: true });
  await runWhoopSync({ admin: asDb(admin), user: user as never, ops, cfg: CFG, uid: "u1", deps: { fetchImpl: whoopApi().fetch, sleep: noSleep }, now: NOW });
  assert.deepEqual(daily, [{ day: "2026-11-10", hrv_ms: 31.8, rhr_bpm: 64, sleep_minutes: 430 }]);
  const a = user.rows("activities")[0];
  assert.equal(a.source, "whoop"); assert.equal(a.load, null); assert.equal(a.origin, "WHOOP"); assert.equal(a.external_id, "w-1"); assert.equal(a.user_id, "u1");
});

test("WHOOP sync: one at a time, revoked access needs reconnecting, rate limits pause the connection", async () => {
  const { admin, user } = await connectedWhoop();
  await acquireLease(asDb(admin), "u1", "whoop", NOW);                                         // another sync is running
  await assert.rejects(runWhoopSync({ admin: asDb(admin), user: user as never, ops, cfg: CFG, uid: "u1", deps: { fetchImpl: whoopApi().fetch }, now: NOW }), SyncBusy);

  const b = await connectedWhoop();
  const revoked = scriptedFetch([{ when: () => true, reply: () => json({}, 401) }]);
  await assert.rejects(runWhoopSync({ admin: asDb(b.admin), user: b.user as never, ops, cfg: CFG, uid: "u1", deps: { fetchImpl: revoked.fetch, sleep: noSleep }, now: NOW }), WhoopError);
  const c = b.admin.rows("provider_connections")[0];
  assert.equal(c.status, "reauth_required"); assert.equal(c.failures, 1); assert.equal(c.lease_until, null); assert.match(String(c.last_error), /Connect again/);

  const d = await connectedWhoop();
  const limited = scriptedFetch([{ when: () => true, reply: () => json({}, 429, { "x-ratelimit-reset": "300" }) }]);
  await assert.rejects(runWhoopSync({ admin: asDb(d.admin), user: d.user as never, ops, cfg: CFG, uid: "u1", deps: { fetchImpl: limited.fetch, sleep: noSleep, now: () => NOW }, now: NOW }), WhoopError);
  assert.equal(d.admin.rows("provider_connections")[0].next_retry_at, "2026-11-12T10:05:00.000Z");
  await assert.rejects(runWhoopSync({ admin: asDb(d.admin), user: d.user as never, ops, cfg: CFG, uid: "u1", deps: { fetchImpl: whoopApi().fetch }, now: NOW }), SyncDeferred);
});

test("WHOOP sync refreshes an expired token before reading data", async () => {
  const { admin, user } = await connectedWhoop();
  await saveTokens(asDb(admin), ops, "u1", "whoop", tokens({ expiresAt: "2026-11-12T09:00:00.000Z" }), NOW);
  const raw = RAW();
  const api = scriptedFetch([
    { when: (u) => u.includes("/oauth2/token"), reply: () => json({ access_token: "AT-NEW", refresh_token: "RT-NEW", expires_in: 3600 }) },
    { when: (u) => u.includes("/v2/cycle"), reply: () => page(raw.cycles) }, { when: (u) => u.includes("/v2/recovery"), reply: () => page([]) },
    { when: (u) => u.includes("/v2/activity/"), reply: () => page([]) }, { when: (u) => u.includes("/measurement/body"), reply: () => json({}, 404) },
  ]);
  await runWhoopSync({ admin: asDb(admin), user: user as never, ops, cfg: CFG, uid: "u1", deps: { fetchImpl: api.fetch, sleep: noSleep }, now: NOW });
  assert.ok(api.log.filter((l) => l.url.includes("/developer/")).every((l) => l.auth === "Bearer AT-NEW"));
  assert.equal((await loadTokens(asDb(admin), ops, "u1", "whoop"))!.refreshToken, "RT-NEW");
});

test("sync failures back off: after 3 failures the connection waits 5, 10, 20 minutes ... up to 6 hours", async () => {
  assert.equal(backoffUntil(2, NOW), null);
  assert.equal(backoffUntil(3, NOW), "2026-11-12T10:05:00.000Z");
  assert.equal(backoffUntil(4, NOW), "2026-11-12T10:10:00.000Z");
  assert.equal(backoffUntil(30, NOW), "2026-11-12T16:00:00.000Z");
  const db = new FakeDb();
  await markConnected(asDb(db), "u", "whoop", "direct", { externalUserId: null, scopes: [] }, NOW);
  await finishError(asDb(db), "u", "whoop", 2, "The WHOOP sync failed.", {}, NOW);
  assert.equal((await readConn(asDb(db), "u", "whoop"))!.next_retry_at, "2026-11-12T10:05:00.000Z");
});

test("disconnect revokes with a fresh token, deletes the tokens, keeps imported data; reconnecting restores the connection", async () => {
  const { admin, user } = await connectedWhoop({ fill_daily: true });
  user.rows("metric_observations").push({ user_id: "u1", metric: "hrv_rmssd_ms", value: 40 });
  const revoked: string[] = [];
  const r = await disconnectProvider({ admin: asDb(admin), ops, uid: "u1", provider: "whoop", revoke: async (t) => { revoked.push(t); return true; }, freshToken: async () => "AT-FRESH" });
  assert.deepEqual(revoked, ["AT-FRESH"]); assert.equal(r.revoked, true);
  assert.equal(admin.rows("provider_credentials").length, 0);
  assert.equal(admin.rows("provider_connections")[0].status, "disconnected");
  assert.equal(user.rows("metric_observations").length, 1, "imported data is kept");
  await assert.rejects(acquireLease(asDb(admin), "u1", "whoop", NOW), /not connected/);
  // reconnection
  await saveTokens(asDb(admin), ops, "u1", "whoop", tokens({ accessToken: "AT-2" }), NOW);
  await markConnected(asDb(admin), "u1", "whoop", "direct", { externalUserId: null, scopes: [] }, NOW);
  const c = (await readConn(asDb(admin), "u1", "whoop"))!;
  assert.equal(c.status, "connected"); assert.equal(c.settings.fill_daily, true, "the user's choices survive a reconnect");
  // revocation failing at the provider still removes local access
  const x = await connectedWhoop();
  const r2 = await disconnectProvider({ admin: asDb(x.admin), ops, uid: "u1", provider: "whoop", revoke: async () => { throw new Error("down"); } });
  assert.equal(r2.revoked, false); assert.equal(x.admin.rows("provider_credentials").length, 0);
});

// ------------------------------------------------------------------ Intervals.icu gateway
test("Intervals ranges: first sync, incremental with overlap, explicit re-sync, and 31-day windows", () => {
  assert.deepEqual(syncRange("2026-11-13", {}), { oldest: "2026-07-16", newest: "2026-11-13", incremental: false });
  assert.deepEqual(syncRange("2026-11-13", { lastSuccessAt: "2026-11-12T08:00:00Z" }), { oldest: "2026-11-09", newest: "2026-11-13", incremental: true });
  assert.deepEqual(syncRange("2026-11-13", { lastSuccessAt: "2025-01-01T00:00:00Z" }).oldest, "2026-05-17", "never more than 180 days");
  assert.deepEqual(syncRange("2026-11-13", { requestedDays: 14, lastSuccessAt: "2026-11-12T08:00:00Z" }), { oldest: "2026-10-30", newest: "2026-11-13", incremental: false });
  const w = dateWindows("2026-07-16", "2026-11-13");
  assert.equal(w[0][0], "2026-07-16"); assert.equal(w[0][1], "2026-08-15"); assert.equal(w[1][0], "2026-08-16"); assert.equal(w.at(-1)![1], "2026-11-13");
  assert.equal(w.length, 4);
  assert.deepEqual(dateWindows("2026-11-13", "2026-11-13"), [["2026-11-13", "2026-11-13"]]);
});

test("Intervals HTTP: Retry-After is honoured once, 5xx retried once, bad credentials reported, bearer or key auth", async () => {
  let n = 0; const slept: number[] = [];
  const f = scriptedFetch([{ when: () => true, reply: () => (n++ === 0 ? json({}, 429, { "retry-after": "3" }) : json([{ id: "2026-11-10" }])) }]);
  assert.equal((await getList("/athlete/i1/wellness", { kind: "key", apiKey: "k" }, { fetchImpl: f.fetch, sleep: async (ms) => { slept.push(ms); } })).length, 1);
  assert.deepEqual(slept, [3000]);
  assert.match(f.log[0].auth ?? "", /^Basic /);
  const b = scriptedFetch([{ when: () => true, reply: () => json([]) }]);
  await getList("/x", { kind: "bearer", token: "tok" }, { fetchImpl: b.fetch }); assert.equal(b.log[0].auth, "Bearer tok");
  const long = scriptedFetch([{ when: () => true, reply: () => json({}, 429, { "retry-after": "900" }) }]);
  await assert.rejects(getList("/x", { kind: "key", apiKey: "k" }, { fetchImpl: long.fetch, sleep: noSleep }), (e: { status: number; retryAfterS: number }) => e.status === 429 && e.retryAfterS === 900);
  const bad = scriptedFetch([{ when: () => true, reply: () => json({}, 403) }]);
  await assert.rejects(getList("/x", { kind: "key", apiKey: "k" }, { fetchImpl: bad.fetch }), (e: { status: number }) => e.status === 401);
});

test("Intervals mapping: time zones fixed, Strava stubs skipped, origin and device kept, wellness origin unknown", () => {
  const local = mapActivityTz({ id: "a1", start_date_local: "2026-07-01T08:00:00", timezone: "Europe/Lisbon", type: "Run", moving_time: 1800, source: "GARMIN_CONNECT", device_name: "Forerunner 965" })!;
  assert.equal(local.started_at, "2026-07-01T07:00:00.000Z", "local time converted with the activity's own zone (was stored as UTC before)");
  assert.equal(local.origin, "GARMIN_CONNECT"); assert.equal(local.origin_device, "Forerunner 965");
  assert.equal(mapActivityTz({ id: "a2", start_date_local: "2026-07-01T08:00:00", type: "Run" }), null, "no zone: skipped, not guessed");
  assert.equal(mapActivityTz({ id: "a3", start_date: "2026-07-01T07:00:00Z", start_date_local: "2026-07-01T08:00:00", type: "Ride" })!.started_at, "2026-07-01T07:00:00.000Z");
  assert.equal(isStravaStub({ id: "s", source: "STRAVA", start_date_local: "2026-07-01T08:00:00" }), true);
  assert.equal(isStravaStub({ id: "s", source: "STRAVA", moving_time: 100 }), false);
  assert.equal(isStravaStub({ id: "g", source: "GARMIN_CONNECT" }), false);
  const obs = wellnessObservations({ id: "2026-11-10", hrv: 62, hrvSDNN: 80, restingHR: 48, sleepSecs: 27000, readiness: 77, vo2max: 55, spO2: 97, weight: 70, tempWeight: true, updated: "2026-11-10T09:00:00Z" });
  const m = Object.fromEntries(obs.map((o) => [o.metric, o]));
  assert.ok(obs.every((o) => o.provider === "unknown" && o.transport === "intervals" && o.quality === "origin_unknown" && o.local_day === "2026-11-10"));
  assert.equal(m.hrv_rmssd_ms.value, 62); assert.equal(m.hrv_sdnn_ms.value, 80); assert.equal(m.sleep_minutes.value, 450);
  assert.equal(m["intervals.readiness"].value, 77, "readiness kept under Intervals, never as a vendor-neutral score");
  assert.equal(m.weight_kg, undefined, "temporary values are skipped");
});

function intervalsApi(acts: unknown[], wellness: unknown[] = []) {
  return scriptedFetch([
    { when: (u) => u.includes("/wellness"), reply: (u) => { const q = new URL(u).searchParams; return json((wellness as Array<{ id: string }>).filter((w) => w.id >= q.get("oldest")! && w.id <= q.get("newest")!)); } },
    { when: (u) => u.includes("/activities"), reply: () => json(acts) },
  ]);
}

test("readRange: an activity returned by two windows is imported once", async () => {
  const api = intervalsApi([{ id: "i9", start_date: "2026-10-01T07:00:00Z", type: "Run", moving_time: 100 }]);
  const r = await readRange("i1", { kind: "key", apiKey: "k" }, "2026-08-01", "2026-11-01", { fetchImpl: api.fetch, sleep: noSleep });
  assert.equal(r.windows, 3); assert.equal(r.activities.length, 1);
});

/** user DB whose apply_synced_metrics behaves like 06 (mirrored by lib/provenance mergeSync). */
function intervalsUser(daily: Record<string, MetricRow> = {}) {
  const user = new FakeDb();
  user.rpcs.set("apply_synced_metrics", (args) => {
    const rows = args.p_rows as Array<{ day: string; hrv_ms: number | null; rhr_bpm: number | null; sleep_minutes: number | null; sleep_score: number | null }>;
    for (const r of rows) daily[r.day] = mergeSync(daily[r.day] ?? null, r);
    return { data: rows.length, error: null };
  });
  return { user, daily };
}
const WELL = [{ id: "2026-11-10", hrv: 60, restingHR: 50, sleepSecs: 28800, sleepScore: 80, vo2max: 54 }];
const ACTS = [
  { id: "i1", start_date: "2026-11-10T07:00:00Z", type: "Run", moving_time: 3000, distance: 10000, icu_training_load: 60, source: "GARMIN_CONNECT", device_name: "Forerunner 965" },
  { id: "i2", start_date_local: "2026-11-10T18:00:00", type: "Ride", source: "STRAVA" },
];

test("Intervals sync end to end: manual values protected, activities labelled intervals with their real origin, status tracked", async () => {
  const manual: MetricRow = { hrv_ms: 75, rhr_bpm: null, sleep_minutes: null, sleep_score: null, hrv_source: "manual", rhr_source: null, sleep_source: null, sleep_score_source: null };
  const whoopFilled = mergeProviderDaily(null, "whoop", { hrv_ms: null, rhr_bpm: null, sleep_minutes: 420 });
  const { user, daily } = intervalsUser({ "2026-11-10": { ...manual, sleep_minutes: whoopFilled.sleep_minutes, sleep_source: whoopFilled.sleep_source } });
  const admin = new FakeDb();
  const r = await runIntervalsSync({ admin: asDb(admin), user: user as never, uid: "u1", athleteId: "i1", auth: { kind: "key", apiKey: "k" }, requestedDays: null, lastSyncFallback: null,
    deps: { fetchImpl: intervalsApi(ACTS, WELL).fetch, sleep: noSleep }, now: NOW });
  assert.equal(daily["2026-11-10"].hrv_ms, 75, "manual HRV kept"); assert.equal(daily["2026-11-10"].hrv_source, "manual");
  assert.equal(daily["2026-11-10"].sleep_minutes, 420, "WHOOP-filled sleep kept"); assert.equal(daily["2026-11-10"].rhr_bpm, 50, "empty field filled");
  const acts = user.rows("activities");
  assert.equal(acts.length, 1, "the Strava stub is not imported"); assert.equal(r.skipped.strava, 1);
  assert.equal(acts[0].source, "intervals", "transport label"); assert.equal(acts[0].origin, "GARMIN_CONNECT", "original source kept"); assert.equal(acts[0].external_id, "i1");
  assert.ok(user.rows("metric_observations").some((o) => o.metric === "vo2max" && o.provider === "unknown"));
  assert.equal(r.statusTracked, true); assert.equal(r.incremental, false);
  assert.equal(admin.rows("provider_connections")[0].last_success_at, NOW.toISOString());
  // the next sync is incremental from the recorded success
  const r2 = await runIntervalsSync({ admin: asDb(admin), user: user as never, uid: "u1", athleteId: "i1", auth: { kind: "key", apiKey: "k" }, requestedDays: null, lastSyncFallback: null,
    deps: { fetchImpl: intervalsApi(ACTS, WELL).fetch, sleep: noSleep }, now: new Date("2026-11-13T10:00:00Z") });
  assert.equal(r2.incremental, true); assert.equal(r2.oldest, "2026-11-09");
  assert.equal(user.rows("activities").length, 1, "re-sync does not duplicate");
});

test("Intervals sync without migration 14 (and 13) works exactly as before", async () => {
  const { user } = intervalsUser();
  const admin = new FakeDb(); admin.missing.add("provider_connections");
  user.missing.add("metric_observations");
  let first = true;
  const realFrom = user.from.bind(user);
  user.from = (t: string) => {                     // activities without the 13 provenance columns: first upsert fails like PostgREST
    const q = realFrom(t);
    if (t === "activities" && first) { first = false; return { upsert: () => Promise.resolve({ data: null, error: { message: "Could not find the 'origin' column of 'activities' in the schema cache" } }) } as never; }
    return q;
  };
  const r = await runIntervalsSync({ admin: asDb(admin), user: user as never, uid: "u1", athleteId: "i1", auth: { kind: "key", apiKey: "k" }, requestedDays: 14, lastSyncFallback: null,
    deps: { fetchImpl: intervalsApi(ACTS, WELL).fetch, sleep: noSleep }, now: NOW });
  assert.equal(r.statusTracked, false); assert.equal(r.activities, 1);
  const a = user.rows("activities")[0];
  assert.equal(a.origin, undefined, "fallback upsert without provenance columns"); assert.equal(a.source, "intervals");
  assert.match(r.notes.join(" "), /connection support set up/);
  assert.ok(!/migration|\.sql/i.test(r.notes.join(" ")), "no migration number or file name is shown");
});

test("Intervals sync failure is recorded without advancing the cursor; bad credentials need reconnecting", async () => {
  const { user } = intervalsUser();
  const admin = new FakeDb();
  const bad = scriptedFetch([{ when: () => true, reply: () => json({}, 401) }]);
  await assert.rejects(runIntervalsSync({ admin: asDb(admin), user: user as never, uid: "u1", athleteId: "i1", auth: { kind: "key", apiKey: "k" }, requestedDays: null, lastSyncFallback: null, deps: { fetchImpl: bad.fetch, sleep: noSleep }, now: NOW }));
  const c = admin.rows("provider_connections")[0];
  assert.equal(c.status, "reauth_required"); assert.equal(c.last_success_at, null); assert.equal(c.lease_until, null);
});
