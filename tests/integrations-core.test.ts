import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS, cardState, originFromIntervalsSource, providerInfo, type UserIntegrationState } from "../lib/integrations/providers.ts";
import { METRICS, dailyFromObservations, freshness, localDayFromOffset, localToUtc, makeObservation, mergeProviderDaily, type Observation } from "../lib/integrations/normalize.ts";
import { authorizeUrl, checkState, parseTokenResponse, randomState, readCookie, sha256, stateCookie, needsRefresh, OAuthError, type StoredState } from "../lib/integrations/oauth.ts";
import { whoopConfig, WHOOP_SCOPES } from "../lib/integrations/whoop.ts";
import { configuredNames, intervalsOAuthConfig } from "../lib/integrations/configs.ts";
import { parseCompanionUpload } from "../lib/integrations/companion.ts";
import { mergeSync } from "../lib/provenance.ts";

const st = (o: Partial<UserIntegrationState> = {}): UserIntegrationState => ({ intervalsConnected: false, direct: {}, seenOrigins: new Set(), configured: new Set(), ...o });

// ------------------------------------------------------------------ provider catalogue and truthful status
test("every required provider has a card, and nothing claims a category it cannot receive", () => {
  const ids = PROVIDERS.map((p) => p.id);
  for (const id of ["garmin", "coros", "whoop", "amazfit", "polar", "suunto", "oura", "apple_health", "samsung_health", "strava", "intervals"]) assert.ok(ids.includes(id as never), id);
  for (const p of PROVIDERS) {
    if (p.routes.every((r) => r.kind !== "direct")) assert.deepEqual(p.direct, [], `${p.id} has no direct route, so no direct categories`);
    if (!p.routes.some((r) => r.kind === "intervals")) assert.deepEqual(p.viaIntervals, [], `${p.id} cannot arrive through Intervals`);
  }
  assert.deepEqual(providerInfo("strava").viaIntervals, [], "Intervals.icu does not pass Strava data through its API");
  for (const id of ["garmin", "coros", "polar", "suunto", "amazfit"] as const) assert.ok(!providerInfo(id).viaIntervals.includes("hrv"), `${id} wellness is not brand-labelled by Intervals`);
});

test("Intervals.icu source enum maps to the brand that recorded the activity; transport-only sources stay unknown", () => {
  assert.equal(originFromIntervalsSource("GARMIN_CONNECT"), "garmin");
  assert.equal(originFromIntervalsSource("COROS"), "coros");
  assert.equal(originFromIntervalsSource("ZEPP"), "amazfit");
  assert.equal(originFromIntervalsSource("polar"), "polar");
  for (const s of ["UPLOAD", "MANUAL", "OAUTH_CLIENT", "DROPBOX", "", null, 7]) assert.equal(originFromIntervalsSource(s), "unknown");
});

test("card status is truthful for every situation", () => {
  assert.equal(cardState(providerInfo("garmin"), st()).status, "available");
  assert.equal(cardState(providerInfo("garmin"), st()).canConnect, false, "Garmin is never 'connectable' directly");
  const g = cardState(providerInfo("garmin"), st({ intervalsConnected: true, seenOrigins: new Set(["GARMIN_CONNECT"]) }));
  assert.equal(g.status, "via_intervals"); assert.equal(g.seenInData, true); assert.equal(g.directLabel, "Through Intervals.icu");
  const w0 = cardState(providerInfo("whoop"), st());
  assert.equal(w0.status, "available"); assert.equal(w0.canConnect, false); assert.deepEqual(w0.setupMissing, ["WHOOP_CLIENT_ID", "WHOOP_CLIENT_SECRET", "WHOOP_REDIRECT_URI"]);
  const w1 = cardState(providerInfo("whoop"), st({ configured: new Set(["WHOOP_CLIENT_ID", "WHOOP_CLIENT_SECRET", "WHOOP_REDIRECT_URI"]) }));
  assert.equal(w1.canConnect, true);
  assert.equal(cardState(providerInfo("whoop"), st({ direct: { whoop: "connected" } })).status, "connected");
  const re = cardState(providerInfo("whoop"), st({ direct: { whoop: "reauth_required" } }));
  assert.equal(re.status, "connected"); assert.equal(re.canConnect, true); assert.match(re.note ?? "", /Connect again/);
  assert.equal(cardState(providerInfo("whoop"), st({ direct: { whoop: "disconnected" } })).status, "available");
  assert.equal(cardState(providerInfo("apple_health"), st({ intervalsConnected: true })).status, "requires_native_app");
  assert.equal(cardState(providerInfo("samsung_health"), st()).status, "requires_native_app");
  assert.equal(cardState(providerInfo("strava"), st({ intervalsConnected: true })).status, "not_supported");
  assert.equal(cardState(providerInfo("oura"), st()).status, "not_supported");
  assert.equal(cardState(providerInfo("suunto"), st({ intervalsConnected: true })).status, "via_intervals");
  assert.equal(cardState(providerInfo("intervals"), st({ intervalsConnected: true })).status, "connected");
});

// ------------------------------------------------------------------ normalisation and provenance
test("observations keep provider and transport apart and reject invented or out-of-range values", () => {
  const o = makeObservation({ provider: "garmin", transport: "intervals", source_record_id: "a1", metric: "resting_hr_bpm", value: 48, measured_at: "2026-11-10T06:00:00Z", local_day: "2026-11-10" })!;
  assert.equal(o.provider, "garmin"); assert.equal(o.transport, "intervals"); assert.equal(o.unit, "bpm"); assert.equal(o.quality, "ok");
  assert.equal(makeObservation({ provider: "unknown", transport: "intervals", source_record_id: "w", metric: "hrv_rmssd_ms", value: 50, measured_at: "2026-11-10T06:00:00Z" })!.quality, "origin_unknown");
  for (const bad of [NaN, Infinity, -1, 999, "60", null, undefined]) assert.equal(makeObservation({ provider: "whoop", transport: "direct", source_record_id: "x", metric: "resting_hr_bpm", value: bad, measured_at: "2026-11-10T06:00:00Z" }), null, String(bad));
  assert.equal(makeObservation({ provider: "whoop", transport: "direct", source_record_id: "x", metric: "resting_hr_bpm", value: 50, measured_at: "yesterday" }), null);
  assert.equal(makeObservation({ provider: "whoop", transport: "direct", source_record_id: "", metric: "resting_hr_bpm", value: 50, measured_at: "2026-11-10T06:00:00Z" }), null);
});

test("vendor scores are namespaced and never share a metric with another vendor or with a measurement", () => {
  const scores = Object.entries(METRICS).filter(([, d]) => d.kind === "vendor_score").map(([k]) => k);
  assert.ok(scores.length >= 5);
  for (const k of scores) assert.match(k, /^(whoop|intervals)\./, `${k} is namespaced by vendor`);
  for (const [k, d] of Object.entries(METRICS)) if (d.kind === "measurement") assert.ok(!k.includes("."), k);
  assert.ok(!("readiness" in METRICS) && !("recovery_score" in METRICS), "no shared, vendor-neutral readiness metric exists");
  assert.notEqual("hrv_sdnn_ms", "hrv_rmssd_ms");
});

test("time zones: local day from offsets and DST-correct local -> UTC", () => {
  assert.equal(localDayFromOffset("2026-11-10T02:00:00.000Z", "-05:00"), "2026-11-09");
  assert.equal(localDayFromOffset("2026-11-10T23:30:00.000Z", "+01:00"), "2026-11-11");
  assert.equal(localDayFromOffset("2026-11-10T12:00:00.000Z", "Z"), "2026-11-10");
  assert.equal(localDayFromOffset("2026-11-10T12:00:00.000Z", "Europe/Lisbon"), null, "an IANA name is not an offset");
  assert.equal(localToUtc("2026-07-01T08:00:00", "Europe/Lisbon"), "2026-07-01T07:00:00.000Z", "summer time UTC+1");
  assert.equal(localToUtc("2026-01-15T08:00:00", "Europe/Lisbon"), "2026-01-15T08:00:00.000Z", "winter time UTC+0");
  assert.equal(localToUtc("2026-11-10T06:00:00", "America/New_York"), "2026-11-10T11:00:00.000Z");
  assert.equal(localToUtc("2026-11-10T06:00:00", "Not/AZone"), null);
  assert.equal(localToUtc("2026-11-10T06:00:00", undefined), null);
});

test("freshness: missing, fresh and stale", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  assert.equal(freshness(null, now), "missing");
  assert.equal(freshness("2026-11-12", now), "fresh");
  assert.equal(freshness("2026-11-10", now), "stale");
  assert.equal(freshness("2026-11-12T08:00:00Z", now), "fresh");
});

test("manual data protection: a provider only fills empty fields or its own; manual, legacy and other sources are kept", () => {
  const existing = { hrv_ms: 70, rhr_bpm: 50, sleep_minutes: 400, hrv_source: "manual", rhr_source: "intervals", sleep_source: "legacy_unknown" };
  const out = mergeProviderDaily(existing, "whoop", { hrv_ms: 40, rhr_bpm: 60, sleep_minutes: 300 });
  assert.deepEqual(out, existing, "nothing replaced");
  const empty = mergeProviderDaily(null, "whoop", { hrv_ms: 40, rhr_bpm: null, sleep_minutes: 300 });
  assert.equal(empty.hrv_ms, 40); assert.equal(empty.hrv_source, "whoop"); assert.equal(empty.rhr_bpm, null); assert.equal(empty.rhr_source, null);
  const again = mergeProviderDaily(empty, "whoop", { hrv_ms: 42, rhr_bpm: null, sleep_minutes: null });
  assert.equal(again.hrv_ms, 42, "a provider may refresh its own value"); assert.equal(again.sleep_minutes, 300, "null never erases");
  // and the existing Intervals rule (06) never overwrites a WHOOP-filled value
  const fromSync = mergeSync({ ...again, sleep_score: null, sleep_score_source: null }, { hrv_ms: 99, rhr_bpm: 55, sleep_minutes: 10, sleep_score: 80 });
  assert.equal(fromSync.hrv_ms, 42); assert.equal(fromSync.hrv_source, "whoop"); assert.equal(fromSync.rhr_bpm, 55, "empty field may be filled by Intervals");
});

test("daily values from observations: rMSSD only, skip pending / approximate days, never the vendor sleep score", () => {
  const mk = (metric: string, value: number, q: Observation["quality"] = "ok", day = "2026-11-10") => makeObservation({ provider: "whoop", transport: "direct", source_record_id: `r-${metric}-${q}`, metric: metric as never, value, measured_at: `${day}T06:00:00Z`, local_day: day, quality: q })!;
  const rows = dailyFromObservations([mk("hrv_rmssd_ms", 55.55), mk("hrv_sdnn_ms", 80), mk("resting_hr_bpm", 49.6), mk("whoop.sleep_performance_pct", 90), mk("sleep_minutes", 420, "pending", "2026-11-11"), mk("resting_hr_bpm", 70, "approximate_day", "2026-11-12")]);
  assert.deepEqual(rows, [{ day: "2026-11-10", hrv_ms: 55.6, rhr_bpm: 50, sleep_minutes: null }]);
});

// ------------------------------------------------------------------ OAuth security
test("OAuth state: 8 characters for WHOOP, unbiased alphabet, and the authorize URL carries exactly the needed parameters", () => {
  for (let i = 0; i < 50; i++) assert.match(randomState(8), /^[A-Za-z0-9]{8}$/);
  const cfg = whoopConfig({ WHOOP_CLIENT_ID: "cid", WHOOP_CLIENT_SECRET: "sec", WHOOP_REDIRECT_URI: "https://staging.example.test/api/integrations/whoop/callback" })!;
  const u = new URL(authorizeUrl(cfg, "AbCd1234"));
  assert.equal(u.origin + u.pathname, "https://api.prod.whoop.com/oauth/oauth2/auth");
  assert.equal(u.searchParams.get("state"), "AbCd1234");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("scope"), WHOOP_SCOPES.join(" "));
  assert.ok(!u.searchParams.get("scope")!.includes("read:profile"), "only necessary scopes");
  assert.ok(u.searchParams.get("scope")!.includes("offline"), "offline is required for a refresh token");
  assert.equal(u.searchParams.get("client_secret"), null, "the secret never goes to the browser");
  assert.equal(whoopConfig({ WHOOP_CLIENT_ID: "cid" }), null, "never configured from partial or fabricated credentials");
  assert.equal(intervalsOAuthConfig({ INTERVALS_CLIENT_ID: "x", INTERVALS_CLIENT_SECRET: "y", INTERVALS_REDIRECT_URI: "https://h/cb" })!.scopes.join(","), "ACTIVITY:READ,WELLNESS:READ");
  assert.deepEqual(configuredNames({ WHOOP_CLIENT_ID: "a", WHOOP_CLIENT_SECRET: " ", SECRET: "x" }), ["WHOOP_CLIENT_ID"]);
});

test("OAuth callback validation: missing, expired, wrong provider, wrong browser, valid", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  const row: StoredState = { state_hash: sha256("AbCd1234"), user_id: "u1", provider: "whoop", nonce_hash: sha256("nonce-xyz"), expires_at: "2026-11-12T10:05:00Z" };
  assert.deepEqual(checkState(null, "whoop", "nonce-xyz", now), { ok: false, reason: "missing" });
  assert.deepEqual(checkState({ ...row, expires_at: "2026-11-12T09:59:59Z" }, "whoop", "nonce-xyz", now), { ok: false, reason: "expired" });
  assert.deepEqual(checkState(row, "intervals", "nonce-xyz", now), { ok: false, reason: "provider" });
  assert.deepEqual(checkState(row, "whoop", null, now), { ok: false, reason: "browser" });
  assert.deepEqual(checkState(row, "whoop", "nonce-other", now), { ok: false, reason: "browser" });
  assert.deepEqual(checkState(row, "whoop", "nonce-xyz", now), { ok: true, userId: "u1" });
  const c = stateCookie("whoop", "n", true);
  for (const f of ["HttpOnly", "SameSite=Lax", "Secure", "Path=/api/integrations", "Max-Age=600"]) assert.ok(c.includes(f), f);
  assert.equal(readCookie("a=1; apex_oauth_whoop=abc; b=2", "apex_oauth_whoop"), "abc");
  assert.equal(readCookie(null, "apex_oauth_whoop"), null);
});

test("token responses: parsed without leaking values into errors; expiry and refresh margin", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  const t = parseTokenResponse({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "read:recovery offline" }, now, " ");
  assert.equal(t.expiresAt, "2026-11-12T11:00:00.000Z"); assert.deepEqual(t.scopes, ["read:recovery", "offline"]);
  const i = parseTokenResponse({ access_token: "AT", scope: "ACTIVITY:READ,WELLNESS:READ", athlete: { id: "i42" } }, now, ",");
  assert.equal(i.expiresAt, null, "Intervals tokens do not expire"); assert.equal(i.externalUserId, "i42");
  assert.throws(() => parseTokenResponse({ refresh_token: "SECRET-RT" }, now, " "), (e: OAuthError) => !e.message.includes("SECRET"));
  assert.equal(needsRefresh("2026-11-12T10:00:30Z", now), true);
  assert.equal(needsRefresh("2026-11-12T10:30:00Z", now), false);
  assert.equal(needsRefresh(null, now), false);
});

// ------------------------------------------------------------------ native companion contract
test("companion uploads: SDNN stays SDNN, unknown types are rejected, the health store is not mistaken for the device", () => {
  const r = parseCompanionUpload({ version: 1, platform: "healthkit", samples: [
    { type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", id: "s1", value: 62, start: "2026-11-10T05:00:00Z", localDay: "2026-11-10", originApp: "com.apple.health.ABC" },
    { type: "HKQuantityTypeIdentifierRestingHeartRate", id: "s2", value: 51, start: "2026-11-10T05:00:00Z", localDay: "2026-11-10", originApp: "com.garmin.android.apps.connectmobile" },
    { type: "HKQuantityTypeIdentifierMadeUp", id: "s3", value: 1, start: "2026-11-10T05:00:00Z", localDay: "2026-11-10" },
    { type: "HKQuantityTypeIdentifierRestingHeartRate", id: "s4", value: 900, start: "2026-11-10T05:00:00Z", localDay: "2026-11-10" },
  ] });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.rejected, 2);
  assert.equal(r.observations[0].metric, "hrv_sdnn_ms"); assert.equal(r.observations[0].provider, "apple_health");
  assert.equal(r.observations[1].provider, "garmin"); assert.equal(r.observations[1].transport, "companion_app");
  const hc = parseCompanionUpload({ version: 1, platform: "health_connect", samples: [{ type: "HeartRateVariabilityRmssdRecord", id: "h", value: 44, start: "2026-11-10T05:00:00Z", localDay: "2026-11-10" }] });
  assert.ok(hc.ok && hc.observations[0].metric === "hrv_rmssd_ms" && hc.observations[0].provider === "unknown");
  assert.equal(parseCompanionUpload({ version: 2 }).ok, false);
});

// ------------------------------------------------------------------ migration 14 and code hygiene (in addition to the service tests)
const sql = readFileSync(new URL("../14_universal_connect.sql", import.meta.url), "utf8");
test("migration 14: secrets are server-only, observations are owner-only, functions are pinned, nothing destructive", () => {
  for (const t of ["provider_credentials", "oauth_states"]) {
    assert.match(sql, new RegExp(`revoke all on public\\.${t} from public, anon, authenticated`));
    assert.match(sql, new RegExp(`alter table public\\.${t} force row level security`));
    assert.ok(!new RegExp(`create policy [^;]* on public\\.${t}`).test(sql), `${t} has no policy`);
  }
  assert.match(sql, /grant select on public\.provider_connections to authenticated/);
  assert.ok(!/grant (insert|update|delete)[^;]*provider_connections/.test(sql), "browsers cannot write connection status");
  for (const p of ["read", "insert", "update", "delete"]) assert.match(sql, new RegExp(`"own observations ${p}"[^;]*user_id = \\(select auth\\.uid\\(\\)\\)`));
  assert.ok(!/grant update \([^)]*imported_at/.test(sql), "imported_at cannot be changed after the first import");
  for (const fn of sql.match(/create or replace function[\s\S]*?\$\$;/g) ?? []) assert.match(fn, /set search_path = public/);
  assert.match(sql, /if p_provider is distinct from 'whoop' then raise exception/);
  assert.match(sql, /coalesce\(sleep_score_source, 'manual'\) in \('manual','intervals','legacy_unknown'\)\)/, "vendor sleep scores cannot be written by WHOOP");
  assert.ok(!/\b(drop table|truncate|delete from)\b/i.test(sql.replace(/--.*$/gm, "")), "additive only");
  assert.match(sql, /d\.hrv_source = p_provider/, "a provider only replaces its own value");
});

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
test("no integration code logs tokens, codes or health values, and the callback never trusts the Host header", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = [...walk(join(root, "lib", "integrations")), ...walk(join(root, "app", "api", "integrations")), join(root, "app", "api", "intervals", "sync", "route.ts")];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const line of src.split("\n").filter((l) => /console\.(log|error|warn|info)/.test(l))) {
      const args = line.replace(/\/\/.*$/, "").replace(/console\.\w+\("[^"]*"/, "");
      assert.ok(!/token|code\b|secret|value|body|json|tokens/i.test(args), `${f}: ${line.trim()}`);
    }
  }
  const cb = readFileSync(join(root, "app", "api", "integrations", "[provider]", "callback", "route.ts"), "utf8");
  assert.match(cb, /new URL\(cfg\.redirectUri\)\.origin/);
  assert.ok(!/headers\.get\("host"\)/i.test(cb));
  assert.match(cb, /\.delete\(\)\.eq\("state_hash"/, "state is consumed atomically (one-time use)");
});
