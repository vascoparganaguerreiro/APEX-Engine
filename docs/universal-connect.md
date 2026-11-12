# APEX Universal Connect: provider audit and architecture

Research date: 12 November 2026. Every claim is tagged with how it was checked:

- **[V]**: verified against the provider's official documentation during this audit.
- **[O]**: stated on an official page, but the detailed specification is gated (behind partner login), so the fields could not be checked.
- **[U]**: unverified. It comes from third-party material and must be confirmed before anything is built on it.

APEX does not claim support for any field marked [O] or [U].

## 1. What exists today (audit)

| Area | Finding |
|---|---|
| Intervals.icu connector | API key (Basic auth, user `API_KEY`), validated against `/athlete/{id}`. Key is AES-256-GCM encrypted in the server-only `intervals_credentials` (07); the browser reads only `intervals_connections(athlete_id,last_sync_at)`. |
| Sync | `POST /api/intervals/sync` with `days` (client always sent 120). One request per endpoint for the whole range, with no retry. Activities upsert on `(user_id, source, external_id)` with `source = 'intervals'`; wellness goes through `apply_synced_metrics` (06), which never overwrites `manual`/`legacy_unknown`. |
| Provenance | `daily_metrics` has per-field sources (`manual`, `intervals`, `legacy_unknown`). `activities.origin` / `origin_device` (13, pending) store the Intervals `source` / `device_name`. |
| Defects found | (1) When Intervals gave only `start_date_local`, the code appended `Z`, so the local wall-clock time was stored as UTC. This shifted activities by the UTC offset; it now uses the activity's IANA `timezone`. (2) No incremental sync: every press re-downloaded 120 days. (3) No retry or `Retry-After` handling. (4) No record of the last error or the last *successful* sync. (5) Only 4 of 40+ wellness fields were kept, and the vendor of those fields was never known. Intervals' wellness record has no source field, so labelling it "Garmin" would be a guess. (6) Strava stubs: Intervals does not return Strava data over the API [V], yet empty stub rows were imported. |
| Profile | Integrations card shows Intervals, "Garmin history" (rows with `daily_metrics.source='garmin'` from the legacy importer), labs and manual entry. |

## 2. Provider compatibility matrix

Legend for the connection route: **D** = direct API from APEX's server, **I** = through the user's Intervals.icu account, **N** = needs a native mobile app, **M** = manual export or third-party bridge, **A** = needs commercial or partner approval.

| Provider | Official method | Route for APEX now | Auth | Activities | HRV | Resting HR | Sleep | VO2 max | Recovery / readiness | Training load | History | Restrictions / sync limits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Intervals.icu** | REST API [V] | **D** (connected) | API key (Basic) [V]; OAuth 2.0 needs an approved app, tokens do not expire, no refresh tokens, `DELETE /api/v1/disconnect-app` revokes [V] | Yes, with `source` enum `STRAVA, UPLOAD, MANUAL, GARMIN_CONNECT, OAUTH_CLIENT, DROPBOX, POLAR, SUUNTO, COROS, WAHOO, ZWIFT, ZEPP, CONCEPT2, HUAWEI` and `device_name` [V] | `hrv` (rMSSD) and `hrvSDNN` [V] | `restingHR` [V] | `sleepSecs`, `sleepScore`, `sleepQuality`, `avgSleepingHR` [V] | `vo2max` [V] | `readiness` [V]. The vendor that produced it is **not** reported. | `icu_training_load` per activity; `ctl`/`atl` daily [V] | Any date range (`oldest`/`newest`) [V] | API key: 5,000/day and 2,500 per 15 min; OAuth: 100/user/day (min 5,000); 10 req/s per IP; 429 carries `Retry-After` [V]. **Strava-sourced activities are not available via the API** [V]. No "updated since" filter, so APEX re-reads an overlap window. |
| **Garmin** | Connect Developer Program: Health/Activity APIs (business, approval) [O]; personal API key for one's own account (Oct 2026) [O] | **I** (working, via Intervals `GARMIN_CONNECT`); direct = **A** | OAuth 2.0 PKCE for business [O]; personal key → access token [U] | Through Intervals [V]; direct: JSON summaries and FIT [O] | Through Intervals wellness (origin unreported) | Same | Same | Garmin strips VO2 max from API-delivered files [O] | Training Readiness not exposed by Intervals as Garmin-labelled; unknown direct [U] | Through Intervals `icu_training_load` | Personal API is pull-only [O] | The endpoint spec sits behind the developer portal, so APEX does **not** implement direct calls. Training/Courses API (workout push) is business-only [O]. |
| **COROS** | Partner API (application to COROS) [O]; self-service MCP/OAuth for AI tools [U] | **I** (`COROS` source) [V]; direct = **A** | OAuth 2.0 after approval [O] | Through Intervals [V] | Not confirmed | Not confirmed | Not confirmed ("daily health data") [O] | Not confirmed | COROS training scores not exposed | Through Intervals | Unknown | Documentation is private until approved [O]. |
| **WHOOP** | Developer API v2, OAuth 2.0 [V] | **D** (implemented; needs app registration) | Authorization Code; the `offline` scope gives a refresh token; refresh rotates both tokens; access token 3,600 s; state must be 8 chars if self-generated [V] | Workouts: `sport_name`, `strain`, avg/max HR, kJ, `distance_meter`, zones [V] | Recovery `hrv_rmssd_milli` [V] | Recovery `resting_heart_rate` [V] | Sleep stages, performance, efficiency, consistency, respiratory rate [V] | No | Recovery score (0–100), separate from strain [V] | Strain (WHOOP scale, **not** TSS) [V] | Any range via `start`/`end`, `limit` ≤ 25, `nextToken` [V] | 100 req/min, 10,000/day; 429 + `X-RateLimit-Reset` [V]. Sandbox: max 10 members until WHOOP approves the app [V]. `DELETE /v2/user/access` revokes [V]. |
| **Amazfit / Zepp** | No public health-data API found | **I** (`ZEPP` source, activities only) [V] | n/a | Through Intervals [V] | No route | No route | No route | No route | No | Through Intervals | n/a | Wellness is not available through any official route APEX can use. |
| **Polar** | AccessLink API v3 [V] | **I** (`POLAR` source) [V]; direct possible later (**D**, registration only) | OAuth 2.0; tokens don't expire unless revoked; user must be registered `POST /v3/users` [V] | Exercises with FIT/TCX/GPX [V] | Nightly Recharge `heart_rate_variability_avg` [V] | Physical info `resting_heart_rate`; Nightly Recharge `heart_rate_avg` [V] | `sleep_score`, stages, `sleep_charge` [V] | `vo2_max` in physical info [V] | Nightly Recharge `ans_charge` / status [V] (Polar-specific) | Cardio load [V] | Exercises: last 30 days and only after registration; nightly recharge / sleep lists: last 28 days [V] | 15 min: 500 + 20×users; 24 h: 5,000 + 100×users [V]. Not built in this task (architecture ready). |
| **Suunto** | Suunto Cloud API, partner programme [V] | **I** (`SUUNTO` source) [V]; direct = **A** | OAuth after partner acceptance [V] | Workouts as FIT [V] | Not confirmed [U] | Not confirmed | Sleep, recovery [U] | Not confirmed | Not confirmed | Through Intervals | Unknown | "We currently don't offer the API access for personal use" [V]. |
| **Oura** | API v2, OAuth 2.0 only (personal access tokens retired Dec 2025) [U: official page could not be loaded during this audit] | **D** later (registration; ≤10 users before approval [U]) | OAuth 2.0 | Workouts [U] | Sleep `average_hrv` [U] | Sleep `lowest_heart_rate` [U] | Sleep and daily sleep score [U] | `vO2_max` [U] | Readiness score (Oura-specific) [U] | No | Date ranges, `next_token` [U] | Membership may be required for Gen3+ [U]. Not built until the official specification is re-checked. |
| **Apple Health** | HealthKit, native apps only; no web or iCloud API [V for HealthKit identifiers, platform statement from Apple docs] | **N** | On-device permission per data type | `HKWorkout` | `heartRateVariabilitySDNN` (**SDNN**, not rMSSD) | `restingHeartRate` | `sleepAnalysis` | `vo2Max` | None from Apple | None | On-device | A web app cannot read Health data. Bridge apps that upload Apple Watch workouts to Intervals.icu exist [U]. |
| **Samsung Health** | Samsung Health Data SDK (Android, partnership needed to distribute) [V]; Health Connect (Android, on-device) [V] | **N** (+ **A** for Samsung SDK distribution) | Android permissions; Health Connect reads beyond 30 days need `READ_HEALTH_DATA_HISTORY` [V] | `ExerciseSessionRecord` [V] | `HeartRateVariabilityRmssdRecord` [V] | `RestingHeartRateRecord` [V] | `SleepSessionRecord` [V] | `Vo2MaxRecord` [V] | Samsung-specific scores are not in Health Connect | None | 30 days by default [V] | The old Samsung Health SDK for Android is deprecated (31 Jul 2025) [V]. A web app cannot read either store. |
| **Strava** | Strava API v3 | **I** for presence only: Intervals does **not** pass Strava data through its API [V] | OAuth 2.0 | Direct only | No | No | No | No | No | Suffer score (Strava-specific) | n/a | Strava's API agreement restricts AI/ML use and display to others [U: the terms page could not be loaded during this audit]. **Not implemented**; legal review needed first. |

### Classification

1. **Direct API integrations (built):** Intervals.icu (API key; OAuth ready behind configuration) and WHOOP (OAuth 2.0, needs registration).
2. **Through Intervals.icu:** Garmin, COROS, Polar, Suunto, Amazfit/Zepp, Wahoo and Huawei *activities*, with the brand taken from Intervals' `source` field. Wellness values arrive with **origin unknown**.
3. **Native mobile app needed:** Apple Health (HealthKit) and Samsung Health / Health Connect.
4. **Manual export or third-party bridge:** Hevy CSV (built in the Strength Hub), FIT files, and Apple Watch → bridge app → Intervals [U].
5. **Commercial or partner approval needed:** Garmin direct (business tier; the personal API is gated documentation), COROS, Suunto, Samsung SDK distribution, WHOOP beyond 10 members, and Intervals OAuth (app approval).

## 3. Architecture

```
provider (where the measurement was made: garmin, whoop, coros, unknown...)
   ×
transport (how it reached APEX: direct, intervals, manual, companion_app, file)
```

These are two different columns. A Garmin activity delivered by Intervals is `provider = garmin, transport = intervals`. A wellness value from Intervals is `provider = unknown, transport = intervals`, because Intervals does not say where it came from.

| Piece | File | Notes |
|---|---|---|
| Provider catalogue | `lib/integrations/providers.ts` | The matrix above as data: what each provider offers, its route, the verification level, the categories and the connection status rules. |
| Normalisation | `lib/integrations/normalize.ts` | `Observation` (user, provider, transport, source record id, metric, value, unit, measured_at, local_day, imported_at, quality). Physiological metrics share names (`hrv_rmssd_ms`); **vendor scores are namespaced** (`whoop.recovery_score`, `intervals.readiness`), so they can never be compared or merged. HRV SDNN ≠ rMSSD. |
| OAuth | `lib/integrations/oauth.ts` | State (8 chars for WHOOP) bound to a 256-bit http-only cookie nonce; one-time and 10-minute expiry, stored server-side; exact redirect URI; PKCE helpers. |
| Tokens | `lib/integrations/tokenStore.ts` | AES-256-GCM (existing `lib/crypto.ts`). AAD = `user|provider|kind`, so a token copied to another user or provider fails. Refresh-token rotation with a lost-race recovery; `reauth_required` status. |
| Sync state | `lib/integrations/syncState.ts` | Lease (no two syncs at once, which matters because a WHOOP refresh invalidates the old token), last success, last error, failures, exponential back-off, cursor. |
| Intervals gateway | `lib/integrations/intervalsGateway.ts` | Date windows of 31 days, retry with `Retry-After`, incremental window (last success − 3 days), correct local→UTC, origin mapping, full wellness → observations. |
| WHOOP | `lib/integrations/whoop.ts` | v2 client, `nextToken` paging, 429 handling, mappers. |
| Native contract | `lib/integrations/companion.ts` | Typed upload contract and validator for a future iOS (HealthKit) and Android (Health Connect) companion. No endpoint is exposed yet. |
| Database | `14_universal_connect.sql` | `provider_connections`, `provider_credentials` (server only), `oauth_states` (server only), `metric_observations`, `apply_provider_daily_metrics`. |
| UI | `app/(app)/integrations/page.tsx` | Connectivity Centre. |

### Rules that protect data

- A sync never overwrites a manual or `legacy_unknown` daily value (06 rules unchanged). WHOOP may fill an *empty* daily HRV, resting HR or sleep field only if the user switches that on. It never touches the sleep score, because WHOOP's sleep performance is a different score.
- Daily fields filled by WHOOP are not overwritten by the Intervals sync (06 only overwrites `intervals` values), and vice versa. The first source to fill a field keeps it until the user edits it.
- Observations are the raw record. Re-syncing the same source record updates that record only (WHOOP re-scores pending recoveries). Nothing is deleted by a sync.
- WHOOP strain is never written into `activities.load` (that column holds TSS-like load). WHOOP workouts are imported as activities only if the user turns that on, because most people also record the session on a watch. The existing duplicate system (13) links copies.
- Tokens, health values and request bodies are never logged. Errors are stored as short fixed messages.

## 4. Manual steps before going live

### WHOOP

1. Create an app at the WHOOP Developer Dashboard. Fill in the name, contact e-mail and privacy policy URL.
2. Redirect URI: `https://<staging-host>/api/integrations/whoop/callback`. For local QA, use `http://localhost:3000/api/integrations/whoop/callback`.
3. Scopes: `read:recovery read:cycles read:sleep read:workout read:body_measurement offline`. Body measurement is optional, so drop it if not wanted (and remove it from `WHOOP_SCOPES`). The 6th scope `read:profile` is **not** requested.
4. Server-only variables: `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `WHOOP_REDIRECT_URI`.
5. Sandbox allows 10 members. Apply for approval before opening it to more users.

### Intervals.icu OAuth (optional; the API key keeps working)

1. Apply at `https://intervals.icu/oauth/apply` and wait for approval.
2. Set `INTERVALS_CLIENT_ID`, `INTERVALS_CLIENT_SECRET`, `INTERVALS_REDIRECT_URI` (`…/api/integrations/intervals/callback`). Scopes requested: `ACTIVITY:READ,WELLNESS:READ`.

### Garmin direct

Not built. The personal API is for the owner's own account, and its endpoint specification is only visible after logging in to Garmin's developer portal. Once those docs are available, add an adapter that pulls only **health** summaries (activities keep coming from Intervals, so nothing is imported twice). The business Health/Activity/Training APIs need Garmin's approval. The Forerunner 965 workout `.fit` export stays experimental. The only official way to push workouts to the watch is the Training API, which is business-only.

### Apple / Samsung

They need a native companion app (HealthKit on iOS; Health Connect on Android, plus Samsung partnership to use the Samsung SDK). `lib/integrations/companion.ts` defines the upload contract, so the server side is ready when an app exists.

## 5. Applying migration 14 (staging only)

Order: 09 → 10 → 11 → 12 → 13 → **14**. Migration 14 needs only the base schema plus 06. Wrap it in `begin; … commit;`. Before applying it, run the `pg_constraint` query at the end of the file. If the row-level `daily_metrics.source` column has a check constraint that does not allow `'whoop'`, WHOOP daily fills will fail; the WHOOP observations are still saved.

Behaviour changes once this code is deployed (with or without 14):
- **Intervals "Sync now" is incremental.** It reads from the last successful sync minus 3 days. "Re-sync last 120 days" re-reads the whole range.
- **Times without a UTC timestamp are converted with the activity's own zone.** Previously the local time was stored as if it were UTC. Rows imported earlier keep their old value until the next re-sync of that range rewrites them.
- **Strava placeholders are skipped.** Placeholder rows already in the database are left untouched.

## 6. Browser QA (not yet run)

1. **Without 14:** open Connections. The setup notice appears; Garmin shows "Connected through Intervals.icu" if Intervals is connected; Apple and Samsung show "Requires a native companion app"; Strava shows "Not yet supported". Intervals Sync now still works.
2. **Apply 14 and refresh:** Intervals Sync now → "Last successful sync" fills in. A second press reads only about the last 3 days. `select provider, transport, metric, count(*) from metric_observations group by 1,2,3` shows `unknown / intervals`, never `garmin`, for wellness.
3. **Manual value protected:** enter HRV by hand on Today, run "Re-sync last 120 days", and check the value and `hrv_source = 'manual'` are unchanged.
4. **WHOOP without variables:** the card says "Server set-up needed" and Connect is disabled.
5. **WHOOP with sandbox credentials:**
   1. Connect → WHOOP consent → back on Connections with "Connected". Neither the URL nor the network log shows a token.
   2. Sync now → the values are saved; Today is unchanged.
   3. Turn on "Use WHOOP … for days that have no value yet" and sync again → only empty days are filled (`hrv_source = 'whoop'`).
   4. Disconnect → "access revoked"; WHOOP data stays. Connect again → the settings are kept.
6. **Security checks:**
   - Start Connect in one browser and paste the callback URL into another: it gets "could not be verified".
   - Reload a used callback URL: it gets "could not be verified".
7. **Duplicates:** with "Add WHOOP workouts to Activities" on and the same run on Garmin, Strength → Duplicates offers to merge. After merging, Today's load is unchanged (WHOOP workouts carry no load).

Sources: [WHOOP OAuth](https://developer.whoop.com/docs/developing/oauth), [WHOOP API](https://developer.whoop.com/api), [WHOOP rate limits](https://developer.whoop.com/docs/developing/rate-limiting), [WHOOP app approval](https://developer.whoop.com/docs/developing/app-approval), [WHOOP recovery](https://developer.whoop.com/docs/developing/user-data/recovery), [Intervals.icu OpenAPI](https://intervals.icu/api/v1/docs), [Intervals.icu OAuth](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759), [Intervals.icu API access](https://forum.intervals.icu/t/api-access-to-intervals-icu/609), [Intervals.icu cookbook](https://forum.intervals.icu/t/intervals-icu-api-integration-cookbook/80090), [Garmin personal API (the5krunner)](https://the5krunner.com/2026/10/22/garmin-personal-api/), [Garmin OAuth2 PKCE spec](https://developerportal.garmin.com/sites/default/files/OAuth2PKCE_1.pdf), [Polar AccessLink](https://www.polar.com/accesslink-api/), [COROS API application](https://support.coros.com/hc/en-us/articles/17085887816340-Submit-an-API-Application), [Suunto API Zone FAQ](https://apizone.suunto.com/faq), [Health Connect data types](https://developer.android.com/health-and-fitness/guides/health-connect/plan/data-types), [Samsung Health Data SDK](https://developer.samsung.com/health/data/process.html), [Oura API notes (Terra)](https://tryterra.co/blog/oura-api-ai-apps-access-permissions-commercial-restrictions).
