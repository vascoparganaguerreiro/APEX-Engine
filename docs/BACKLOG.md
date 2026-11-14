# Backlog

The single queue for unattended work. Rules for taking, recording and merging items are in `CLAUDE.md`.
Each item: id, what, evidence, how to verify, merge class (`self-merge` or `needs owner`).

## Needs the owner (sessions cannot do these)
- **O-01 Run `sql/09_ai_usage.sql` on production and set `SUPABASE_SERVICE_ROLE_KEY` in Vercel.** Until then AI summaries and report reading return an error (they fail closed by design, D-002). Then run the verification queries at the end of that file.
- **O-02 Verify PR #1 on a real deployment:** an 8 MB lab report, a duplicate report, hitting both daily limits, another user's report path returning 404, the Today page with a stale entry.
- **O-03 Replace `sql/00_base_schema.sql` with a real dump** (`supabase db dump --schema public`), see D-005.
- **O-04 Decide whether to drop the old `(user_id, external_id)` index** after checking the Streamlit app, see D-004.
- **O-05 Confirm sign-up is restricted to invited emails in Supabase Auth settings.** The login page says so, but nothing in this repository enforces it.
- **O-06 Decide whether report-reading timeouts should be refunded,** see D-003.

## Ready (take the first whose blockers are met)
- **B-01 Move page data loading out of effects.** Evidence: `npm run lint` reports 8 `react-hooks/set-state-in-effect` warnings (`app/(app)/today`, `activities`, `supplements`, `biomarkers/panels/[id]`, `components/IntervalsCard.tsx`, `lib/useAuth.ts`). Verify: warnings gone, rule back to error (D-006), and each page exercised in the pre-installed Chromium with Supabase requests mocked. Class: needs owner (changes every page's loading behaviour).
- **B-02 Route handler tests.** Evidence: no test imports any file under `app/api/`; the test runner cannot resolve `@/` imports. Make the handlers testable (inject the Supabase client and `fetch`, or resolve the alias in tests) and cover auth failure, bad input, limit reached, and success for each route. Class: self-merge if behaviour is unchanged.
- **B-03 Split `app/(app)/biomarkers/panels/[id]/page.tsx`.** Evidence: over 300 lines, many lines above 200 characters, upload, extraction, review and editing in one component. Extract a hook for the upload/cleanup state and components for the new-panel and existing-panel views. Blocked by: B-02 style browser check available (mock Supabase in Chromium). Class: needs owner unless a browser run shows the flows unchanged.
- **B-04 Security headers.** Evidence: `next.config.mjs` is empty; no Content-Security-Policy, `X-Frame-Options`, `Referrer-Policy` or `Permissions-Policy`. Class: needs owner (a wrong CSP breaks Supabase or storage requests in production).
- **B-05 Row cap on activity queries.** Evidence: `app/(app)/today/page.tsx` asks for `.limit(5000)` and `app/api/summarize/route.ts` sets no limit, while PostgREST returns at most 1000 rows by default; `fetchAll` in `lib/health/core.ts` already solves this for biomarkers. Class: self-merge with tests.
- **B-06 Today page uses the device time zone, summaries use the profile time zone.** Evidence: `dailyLoads(acts)` in `app/(app)/today/page.tsx` versus `localDay(..., tz)` in `app/api/summarize/route.ts`. Class: needs owner (changes numbers users see).
- **B-07 `due.sort(...)` mutates a memoised array** in `app/(app)/supplements/page.tsx`. Class: self-merge.
- **B-08 Orphaned report files** when the tab is closed after upload and before save. Evidence: noted in PR #1. Needs a server-side sweep, which means a scheduled job and a decision on retention. Class: needs owner.
- **B-09 Formatter.** Adopt Prettier in one PR that only reformats. Class: self-merge, but only when no other PR is open.
- **B-10 Development dependency audit.** Evidence: `npm audit` reports 8 moderate findings, all under the ESLint packages; `npm audit --omit=dev` reports 0. Re-check monthly; act only if a fix exists without a major version change. Class: self-merge.

## Done
- 2026-11-14 PR #1: AI usage ledger, report-reading limit, direct-to-storage uploads, database setup files, race countdown, stale readiness, deduplication, ESLint and CI.
