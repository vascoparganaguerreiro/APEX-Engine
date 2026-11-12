# APEX Engine: read-only reliability audit (Task 7A)

Date: 12 November 2026. Scope: the whole web app on branch `staging`, including uncommitted work. No source code, configuration,
migration or database was changed. No SQL was run. Only this report was written.

**Severity scale:**
- **P0:** data loss, a security breach or cross-user exposure, verified.
- **P1:** a working feature is broken, wrong data is shown, or a risk blocks safe use.
- **P2:** degraded or misleading behaviour, or a risk under realistic conditions.
- **P3:** hygiene, maintainability or an edge case.

**Evidence labels:**
- **Verified:** read in code or reproduced.
- **Unverified:** depends on database or service state that could not be inspected safely.

---

## 1. Current state (checked)

| Item | Result |
|---|---|
| Branch | `staging` (`.git/HEAD` → `refs/heads/staging`). Git is installed at `C:\Program Files\Git\cmd\git.exe` but is not on PATH. |
| Remote | `staging` is level with `origin/staging` (nothing committed ahead). |
| Working tree | **27 modified and 14 untracked paths**, never committed: Universal Connect, the Today redesign, migration 14, the Strength readiness fixes and their tests. See F4. |
| Runtime and tools | Node 26.13.1, npm 11.20.0, Node test runner, TypeScript, Next.js 16 build. The built-in browser pane exists (see section 4). |
| Tests and types | **309/309 tests pass. `tsc --noEmit` is clean** (re-run in this audit). The production build passed at the end of the previous task and was not re-run here (nothing changed since). |
| Supabase target | `.env.local` targets project ref **`ncbceqrulodrdkptnfot`**. Nothing in the repository says whether that is staging or production. **Unverified.** See F1. |
| Server variables (names only) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `INTERVALS_ENCRYPTION_KEY` are set. `WHOOP_*` and `INTERVALS_CLIENT_*` are absent, so WHOOP and Intervals.icu OAuth cannot be connected. |
| Applied migrations | **Not verifiable without SQL.** I did not probe the API either, because the project may be production. Per your notes, 09–14 are unapplied and 05–08 are applied. The app's behaviour below assumes that. |

---

## 2. Findings (ordered by real risk)

No P0 was verified. I found no path where one user can read or change another user's data, and no secret reaches the browser.

### P1

**F1. The local environment may point at production. Unverified.**
- **Where:** `.env.local` (project ref `ncbceqrulodrdkptnfot`).
- **Evidence:** Nothing in the repo or docs identifies the staging ref. The local server and `npm run dev` QA would run against this project.
  - These normal actions write data: "Sync now" (activities, daily_metrics), Quick log, Strength uploads and Coach requests.
- **Impact:** Following the QA plans in `docs/strength-hub.md` and `docs/universal-connect.md` could write test data into real Garmin/Intervals history if this ref is production.
- **Fix:** Confirm the ref in the Supabase dashboard. Keep a staging-only env file, and record the staging ref (not keys) in the docs.
- **Safe in staging:** Yes. This is configuration only.

**F2. Self-registration may be open. Unverified.**
- **Where:** `app/login/page.tsx` (lines 31–36).
- **Evidence:**
  - The page offers "Create account" and calls `sb.auth.signUp`.
  - The text says registration is by invitation, but nothing in the code enforces it. It depends entirely on Supabase Auth settings (sign-ups disabled or an allow-list), which are not in the repo.
- **Impact:** If sign-ups are open, anyone with the URL can register, store health data and use the server's Gemini key. Limits are per user only (Coach 30/h and 150/day, summaries 30/day, report reading 10/h), so many accounts multiply cost.
- **Fix:** Check Supabase Auth: disable sign-ups and invite users, or use an allow-list. Then hide the "Create account" tab or make it say invite-only.
- **Safe in staging:** Yes.

**F3. Regression: Today's race card and races in the five-day view fail before migration 10. Verified.**
- **Where:**
  - `lib/today/load.ts` `loadRaces()` → `listRaces()` (`lib/races.ts` line 152)
  - `app/(app)/today/page.tsx`
- **Evidence:**
  - The old Today page used `nextUpcomingRace()`, which falls back to the original columns when migration 10 is missing (`lib/races.ts` 181–186).
  - The redesign calls `listRaces()`, which selects `sport, location, distance, status…` with no fallback.
- **Repro:** With 10 unapplied (the current state), open Today. The race card says "Races need a database update (migration 10)", even though races exist. The five-day view shows no race.
- **Impact:** A feature that worked before the redesign is now broken on the main screen.
- **Fix:** In `loadRaces`, fall back to the base columns as `nextUpcomingRace` does, or apply migration 10.
- **Safe in staging:** Yes. It is a small code change.

**F4. Weeks of work are uncommitted, in a OneDrive-synced repository. Verified.**
- **Where:** working tree (41 paths). The repo lives under `OneDrive\Documentos\…`.
- **Impact:** None of Tasks 5–7 has a commit or a remote copy. A bad OneDrive sync, or a corrupted `.git` (OneDrive is known to cause this), would lose it. It also cannot be reviewed as a diff or pull request.
- **Fix:** Commit and push to `staging` (your action). Consider moving the repo out of OneDrive.
- **Safe in staging:** Yes.

### P2

**F5. The AI summary rate limit can be bypassed and is racy. Verified.**
- **Where:** `app/api/summarize/route.ts` `enforceLimit` (93–103).
- **Evidence:**
  - The limit counts `activities.ai_summary_at` and `weekly_summaries.created_at` for today. Both are written by the user's own client (RLS owner rights), so a user can clear them and reset the count.
  - Failed or unsaved AI calls are never counted.
  - Concurrent requests all pass the check before any of them saves.
  - The Coach and report reading use a durable server-side limiter that fails closed; summaries do not.
- **Impact:** Gemini cost and quota abuse, in practice only by a signed-in user.
- **Fix:** Route summaries through the same server-only quota function as the Coach (`consume_coach_quota` with its own kind, or a sibling).
- **Safe in staging:** Yes, but it needs a new migration.

**F6. AI summaries send notes and wellness data to Gemini without the Coach's consent model. Verified.**
- **Where:**
  - `app/api/summarize/route.ts` (`brief()` includes `note`; `dailyAvg`; the morning HRV, RHR and sleep)
  - `components/ActivityCard.tsx`, `WeekCard.tsx`
- **Evidence:**
  - The Coach requires per-category consent, re-checked on the server.
  - The "Summarize" buttons send free-text activity notes, HRV, resting HR and sleep to Google. The only label is "AI summary of your data, not medical advice" (shown after the fact).
- **Impact:** An inconsistent privacy promise: a user who declined "Daily wellness" in the Coach still sends it through summaries.
- **Fix:** Add a one-time disclosure and consent check (reuse the Coach consent), or exclude notes and wellness unless consented.
- **Safe in staging:** Yes.

**F7. No HTTP security headers. Verified.**
- **Where:** `next.config.mjs` (empty). There is no middleware or proxy.
- **Evidence:** No CSP, `frame-ancestors` or `X-Frame-Options`, `Referrer-Policy` or `Permissions-Policy`. The Supabase session lives in `localStorage`, which is the supabase-js default.
- **Impact:** The app can be framed (clickjacking). Any future XSS bug would directly expose the session token, with health data behind it. I found no `dangerouslySetInnerHTML` or `eval` today.
- **Fix:** Add a `headers()` block: CSP with `frame-ancestors 'none'`, plus `Referrer-Policy: strict-origin-when-cross-origin` and `Permissions-Policy` (microphone for voice only).
- **Safe in staging:** Yes.

**F8. Activities shows older weeks as empty. Verified.**
- **Where:** `app/(app)/activities/page.tsx` (34–36).
- **Evidence:** It loads the last 200 days only (`limit(800)`), and nothing is re-fetched when you step back a week.
- **Repro:** Press "previous week" past about 29 weeks. The page shows "No sessions recorded this week" with zero totals, although Garmin history exists.
- **Impact:** Wrong statements about past training, and a weekly AI summary can't be requested for those weeks.
- **Fix:** Fetch the selected week's range when it falls outside the loaded window, or say "older than 200 days: not loaded".
- **Safe in staging:** Yes.

**F9. Some older activities may have start times shifted by the UTC offset. Extent unverified.**
- **Where:**
  - Old `lib/intervals.ts` `mapActivity` (`start_date_local + "Z"`)
  - The fix is in `lib/integrations/intervalsGateway.ts`
- **Evidence:**
  - Before Task 5, an activity that had only a local start time was stored as if that time were UTC.
  - The fix applies to new syncs, and re-sync overwrites at most 180 days.
- **Impact:** Affected activities can sit on the wrong calendar day, and so in the wrong week and the wrong load day, by the UTC offset. With Intervals.icu, `start_date` (UTC) is usually present, so the count may be zero.
- **Fix:** Measure first: for activities older than 180 days, compare `started_at` with Intervals' `start_date`. Then run a one-off re-sync of the affected ranges.
- **Safe in staging:** Yes. Measure, then re-sync.

**F10. Strava placeholder rows imported earlier still count as sessions. Extent unverified.**
- **Where:**
  - `activities` rows with `source='intervals'` that came from Intervals' Strava stubs
  - `lib/today/model.ts` and `lib/activities.ts` session counts
- **Evidence:**
  - New syncs skip these empty stubs.
  - Rows imported earlier remain. They have no duration, distance or load, but each counts as a session in the Activities weekly totals and the Today 7-day sessions.
  - When the same workout also came from Garmin, the session count doubles.
- **Fix:** List them (origin STRAVA or null with all measurements null), then let the user hide or merge them through the Duplicates flow. Do not hard-delete.
- **Safe in staging:** Yes.

**F11. The activities upsert relies on a unique key that no repo migration creates. Unverified.**
- **Where:**
  - `lib/integrations/intervalsSync.ts`, `whoopSync.ts` (`onConflict: "user_id,source,external_id"`)
  - `05_intervals.sql` creates `(user_id, external_id)`
- **Evidence:** A test comment says production has `(user_id, source, external_id)`. If staging was built only from the repo migrations, that key does not exist.
- **Impact:** Every Intervals sync would fail with "no unique or exclusion constraint matching the ON CONFLICT", and the error would surface as "Could not save activities".
- **Fix:** Check `pg_indexes` on staging. If the key is missing, add an additive migration. Production's key is assumed present.
- **Safe in staging:** Yes.

**F12. Different modules use different time zones. Verified.**
- **Where:**

  | Module | Time zone used |
  |---|---|
  | Today | profile time zone |
  | Activities (`todayIso()` and `localDay()` without zone) | device |
  | Supplements page | device |
  | Timeline | device |
  | `summarize` route | profile time zone, defaulting to **UTC** when missing |

- **Repro:** Profile set to Europe/Lisbon, device in America/New_York (travel), or no profile zone. A 23:30 session, or a dose logged late in the day, can land on different days on Today, Activities and in the AI weekly summary.
- **Impact:** Contradictory day and week totals across screens.
- **Fix:** One shared "user zone" helper (`lib/today/model.ts` `userZone`) used by every page and route.
- **Safe in staging:** Yes.

**F13. Migration ordering and validation hazards (not destructive). Verified.**
- **Where:** `10_races.sql`, `11_profile.sql`, `14_universal_connect.sql`, `06_metric_provenance.sql`.
- **Evidence:**
  - 10 and 11 add CHECK constraints that validate existing rows, and 10 also backfills `sport` and sets it NOT NULL. Unexpected existing values (for example an existing `sport` or `status` column) abort the migration. That is safe if it is wrapped in `begin/commit` as documented.
  - 14 drops and re-adds `daily_metrics_source_values` with `'whoop'` added. Re-running 06 later would put back the narrower version and fail once any `whoop` value exists.
- **Fix:** Run each migration in a transaction (already documented). Add a note in 06 that it must not be re-run after 14.
- **Safe in staging:** Yes.

**F14. Disconnecting Intervals.icu OAuth leaves a stale "Connected" state. Verified; latent, because Intervals OAuth is not configured.**
- **Where:**
  - `app/api/integrations/[provider]/callback/route.ts` creates an `intervals_connections` row
  - `app/api/integrations/[provider]/route.ts` DELETE does not remove that row
- **Impact:** After an OAuth disconnect, Intervals still shows "Connected" while sync fails with "not connected".
- **Fix:** On Intervals OAuth disconnect, delete the `intervals_connections` row when no API key is stored.
- **Safe in staging:** Yes.

### P3

| ID | Finding | Where / evidence | Fix |
|---|---|---|---|
| F15 | Sync messages report activities *fetched*, not *new*. An incremental sync re-reads a 3-day overlap, so "Synced: 4 activities" can appear when nothing changed. | `components/IntervalsCard.tsx`, `components/today/QuickLog.tsx` | Report inserted vs updated counts, or word it as "checked". |
| F16 | The Coach's 64 KB body limit only checks `Content-Length`; a chunked body is parsed in full. | `app/api/coach/route.ts` (28) | Read the body as text with a byte cap. |
| F17 | Deleting a panel removes the database row, then the file; a failed second step leaves an orphan file. Deleting the account leaves storage objects. There is no data export or account deletion feature. | `app/(app)/biomarkers/panels/[id]/page.tsx` (176–178) | Clean up on the server; add export and delete before a public release. |
| F18 | Dead and duplicate code. | `components/TodayView.tsx` and `ReadinessRing.tsx` (unused after the redesign); `NextRaceCard` (unused); `lib/intervals.ts` `fetchActivities`, `fetchActivitiesDetailed`, `fetchWellness` (no callers); `engine.readiness()` (tests only, for parity with the Python app); `env.example` duplicates `.env.example`; `README.md` is UTF-16 with NUL bytes. | Remove or mark. Convert the README to UTF-8. |
| F19 | Two "baseline" definitions: the Today estimate uses the previous 28 days (at least 5); the Coach `dailyFacts` compares the last 7 days against the 21 days before. Today and the Coach can describe the same HRV differently. | `lib/today/model.ts`, `lib/coach/context.ts` | Document the difference, or share one baseline helper. |
| F20 | Timeline fails as a whole if any health query fails (`Promise.all` over panels, results and supplements). | `app/(app)/timeline/page.tsx` (36) | Load each part independently, as Today now does. |
| F21 | A daily value written by WHOOP (after 14) shows as "source unknown" in Profile suggestions. | `lib/profile.ts` `measuredSource` | Add `whoop`. |
| F22 | Connections shows Intervals "Connected" whenever the non-secret row exists, even if the stored key can no longer be decrypted (rotated key). Without migration 14 there is no "last error" to explain it. | `lib/integrations/status.ts`, `providers.ts` | Surface the last sync error from `intervals_connections` or the sync response. |

---

## 3. Area summaries

### A. Data integrity
- **Count once:** Today, Activities totals, the weekly AI summary and the Coach all remove copies merged in Duplicates (`loadExcludedActivityIds`). Verified.
- **Merging is reversible:** merges and imports never modify or delete source rows (13 functions are additive, and unmerge deletes only canonical rows). Verified.
- **Duplicates before 13:** until migration 13, Garmin and Strava copies of one workout are not linked. Copies with load are rare, because Strava data is not passed through the API, so session counts are what doubles (F10).
- **Manual values:** never overwritten. 06's atomic functions are mirrored and tested in TypeScript (Verified in code and tests, not against a database). WHOOP fills only empty fields (14).
- **Remaining issues:** time zones across modules (F12), stale history (F8), legacy rows (F9, F10).

### B. Integrations
- **Intervals.icu:**
  - Verified: reads in windows, retries, incremental sync, Strava stubs skipped, origin and device kept, local→UTC with the activity's own zone.
  - Still open: the unique-key dependency (F11).
- **WHOOP:** complete in code (OAuth state bound to the browser, encrypted tokens with per-user and per-provider binding, refresh rotation with race recovery, a lease so only one sync runs, 429 back-off, revoke). **Never run against the real WHOOP API**, because no credentials are configured.
- **Universal Connect provenance:** wellness from Intervals is labelled origin "unknown". Vendor scores are kept under their own names.
- **Apple and Samsung:** described accurately as "Requires a native companion app". No false claims.

### C. Security and privacy
- **Good, verified in code and SQL:**
  - Every API route takes the user id from the verified token.
  - The service role is used only server-side.
  - Credential tables are server-only (RLS on, no policies, privileges revoked).
  - AES-256-GCM with owner binding (AAD).
  - Coach and report-reading limiters fail closed.
  - Uploads: consent first, then the limiter, then type check by magic bytes, 10 MB cap and hash dedupe.
  - Private `lab-reports` bucket with per-user folder policies.
  - No secret uses a `NEXT_PUBLIC_` name.
- **Gaps:**
  - F2 (sign-ups)
  - F5 (summary limit)
  - F6 (summary consent)
  - F7 (headers)
- **Not inspectable:** RLS on the base tables (`activities`, `daily_metrics`, `profiles`, `races`, `weekly_summaries`) is not in the repo. The code assumes owner-only policies ("own_rows" or "own_profile").

### D. Modules: does one failure break others?

| Module | Before its migration | Notes |
|---|---|---|
| Today | each card degrades on its own | F3 (races before 10) |
| Activities | works | F8, F12 |
| Strength | logging on the device only; other pages show setup notices | needs 13 |
| Supplements and Biomarkers | need 08 (applied) | report reading is 503 until 09 |
| Races | **the Races page lists nothing before 10** (it uses `listRaces` with no fallback) | expected for Race Hub |
| Profile | extra fields locked until 11 | |
| Coach | 503 until 12 | Today shows a setup notice |
| Connections | setup notice until 14 | Intervals keeps working |
| Timeline | whole page fails if a health query fails | F20 |

### E. APEX Readiness Estimate (latest fixes): verified by code reading and 28 Today tests
- **Today only:** only today's row is used, with "today" in the profile's time zone. No earlier day is ever substituted.
- **Baselines:** distinct days in today−28 … today−1, with at least 5 valid values for HRV and for resting HR. Invalid or missing values cannot inflate the count or the confidence.
- **Sleep:** compared only with a saved sleep goal; the invented 8 h default was removed.
- **Weights:** renormalised; the effective weights shown on the card equal the ones used. The score is bounded to 0–100 and deterministic.
- **Gating:** low confidence never gives a suggestion. Medium is shown as "Tentative:". "Insufficient data" carries no score, band, confidence or suggestion.
- **No AI:** the Coach and AI code never touch the estimate.
- **Limitations:**
  - Days are calendar days chosen by the source. Intervals.icu uses its own athlete time zone, which can disagree with the APEX profile near midnight.
  - The thresholds (5, 7 and 14 days) are product decisions.
  - The card has not been seen in a browser.

### F. Migrations 09–14

| # | Depends on | Destructive? | Security | Risks / rollback |
|---|---|---|---|---|
| 09 | auth.users | No | server-only table and function (EXECUTE only for service_role) | Rollback: drop the function and table. |
| 10 | races | No deletes; **updates** `sport` on existing rows (deterministic backfill); NOT NULL + CHECKs | RLS untouched | Aborts on unexpected existing values (F13). Rollback: drop the columns (loses Race Hub fields). |
| 11 | profiles | No | RLS untouched | CHECK uses `current_date` (not immutable; harmless for birth dates). Rollback: drop the columns. |
| 12 | auth.users | No | read and delete only for users; writes only by the server; usage table server-only | Leaves the old `coach_messages` table untouched. |
| 13 | auth.users, activities (`id` must be an integer) | No; adds 5 nullable columns to `activities` | all functions run as the caller with `search_path` set; owner-only RLS | Pre-check for column collisions (documented). `training_session_links.activity_id` cascades on activity delete. Rollback is complex (many tables) but leaves existing data untouched. |
| 14 | daily_metrics + 06 | No; drops and re-adds one CHECK (wider) | tokens and OAuth state server-only; observations owner-only; `imported_at` not updatable | Hazard if 06 is re-run later (F13). The base `daily_metrics.source` check is unknown (documented pre-check). |

**Order:** 09 → 10 → 11 → 12 → 13 → 14. No migration depends on another at the SQL level, except 14 on 06.

### G. Tests and maintainability
- **Volume:** 309 tests, about 1,720 assertions. About **190 are source-text or SQL-text regex checks**. These pass without exercising behaviour; examples are the RLS and grant tests and the "wiring" tests.
- **Not tested:**
  - The real SQL functions and RLS (no Postgres test harness).
  - React components and pages (no DOM or end-to-end tests).
  - The `summarize` route (rate limit, model fallback).
  - The Activities week navigation.
  - Time-zone consistency across pages.
  - The Supabase Auth configuration.
- **Fragile:**
  - TypeScript mirrors of the SQL rules (`lib/provenance.ts`, `normalize.mergeProviderDaily`) can drift from the SQL.
  - Tests that assert exact source strings break on harmless refactors.
- **Error handling:** generally good: fixed user messages and no health data logged. `summarize` logs raw unknown errors (`console.error(e)`) (P3).

---

## 4. Browser verification

**Not possible in this audit.**
- The built-in browser pane is available, but there is no authenticated session or test account, and I will not enter credentials.
- I did not start the app in this audit, because the local environment's project could be production (F1).
- In the previous task, `/today` redirected to `/login` without errors. Nothing behind sign-in has been seen in a browser.

---

## 5. Conclusions

### 1. Overall assessment
The application is **solid in its core rules**:
- per-user isolation
- server-only secrets
- manual-value protection
- count-once totals
- honest empty states
- a well-gated readiness estimate

and its pure logic is well tested.

Its **operational reliability is not yet proven**:
- six migrations are unapplied;
- the database target is unconfirmed;
- weeks of work are uncommitted;
- there are no database-level or browser-level tests;
- several cross-module inconsistencies (time zones, history window, summary consent) would show up quickly with real use.

### 2. The five most important verified issues
1. **F3:** Today's race card and races in the five-day view are broken until migration 10. This is a regression from the redesign.
2. **F4:** All recent work is uncommitted, inside a OneDrive folder.
3. **F5:** The AI summary rate limit can be bypassed and is racy (Gemini cost).
4. **F6:** AI summaries send notes and wellness data to Gemini without the Coach consent model.
5. **F8 and F12:** Older weeks show "no sessions", and different time zones per module give contradictory day and week totals.

The two **unverified** P1 risks (F1 environment target, F2 open sign-ups) must be confirmed before anything else.

### 3. Blockers to inviting a friend into a private beta
- Confirm F1: the app the friend uses must point at the intended project, with staging kept separate.
- Confirm or close F2: invite-only sign-up.
- F4: commit and push the current work.
- Fix F3, or apply migration 10.
- Apply 09 and 12, or accept that report reading and the Coach show "unavailable".
- Strongly recommended: F7 (headers) and F6 (summary consent), since a friend's health data would be involved.

### 4. Blockers to a future production release
- All of the above, plus:
  - F5 (durable summary limit)
  - F11 (verify the unique key)
  - F12 (one time-zone rule)
  - F8 (history window)
  - F9 and F10 (measure and clean legacy rows)
- Database-level tests for RLS and the SQL functions, and an end-to-end smoke test of the main modules.
- Account deletion and data export, a privacy policy (also required by WHOOP), and error monitoring without health data.
- WHOOP live test with real credentials; Hevy CSV checked against a real export; FIT file tested on the watch.

### 5. What remains unverified
- Whether `ncbceqrulodrdkptnfot` is staging or production.
- Which migrations are actually applied.
- Supabase Auth sign-up settings.
- RLS on the base tables.
- The `activities` unique key.
- How many rows F9 and F10 affect.
- WHOOP and Intervals OAuth against the real services.
- The Hevy CSV format; the FIT file on the Forerunner 965.
- Every UI behind sign-in, on desktop and mobile.
- The production build in this exact state (it passed in the previous task; nothing changed since).

### 6. Recommended next steps, in priority order
1. **Confirm the environment.** Check the Supabase ref (F1) and the Auth sign-up setting (F2). Your action in the dashboard; no code needed.
2. **Commit and push** the current work to `staging` (F4).
3. **Fix the race card regression** with a base-column fallback (F3). One small code change in staging.
4. **Apply migrations 09 → 14 on confirmed staging,** in transactions, with the documented pre-checks (including F11's index check). Then run the QA sequences in `docs/strength-hub.md` and `docs/universal-connect.md` with a staging test account.
5. **Privacy and cost:** summary consent (F6), a durable summary limit (F5) and security headers (F7).
6. **Data consistency:** one time-zone helper everywhere (F12), the Activities history window (F8), Timeline isolation (F20).
7. **Legacy data:** measure F9 and F10 on staging, then plan a re-sync or a merge (no hard deletes).
8. **Tests:** a Postgres-backed test for the SQL functions and RLS, and a Playwright smoke test per module once a staging test account exists.
9. **Cleanup** (F15–F22).
