# Decision log

One entry per decision. Newest last. Each entry: context, options, choice, evidence, how to reverse.

## D-001: Unattended sessions may advance the project (2026-11-14)
- **Context:** the owner asked for the project to continue without them, with every decision backed by proper setup and information.
- **Options:** (a) sessions merge everything that passes CI; (b) sessions only open PRs; (c) sessions merge a narrow safe class and leave the rest for the owner.
- **Choice:** (c). Rules are in `CLAUDE.md`.
- **Evidence:** merging to `main` deploys to production; CI checks lint, types, unit tests and build but has no database, no browser and no Supabase project, so it cannot show that a schema, auth or UI-flow change works. `main` rules (ruleset "Protect main") already require a PR, squash merge and the check "Test, typecheck and build".
- **Reverse:** disable or delete the scheduled tasks "APEX builder" and "APEX weekly review" in Claude Code; edit the merge policy in `CLAUDE.md`.

## D-002: AI limits are counted in a server-only table (2026-11-14, PR #1)
- **Context:** the daily limit counted columns users can write and did not count regenerations.
- **Choice:** `sql/09_ai_usage.sql` plus `lib/aiUsage.ts`; routes fail closed (error, not unlimited) if the ledger is unavailable.
- **Evidence:** `tests/aiUsage.test.ts`. The SQL itself has not been run against a database.
- **Reverse:** revert the routes to call the AI without `withAiUsage`; the table can stay.

## D-003: Report-reading timeouts and unusable answers are not refunded (2026-11-14, PR #1)
- **Context:** one unit of `REPORT_DAILY_LIMIT` is charged per Gemini call.
- **Options:** refund every failure; refund only when the service did no work.
- **Choice:** refund only when the service did no work (unreachable, error status). Error messages say the attempt counted.
- **Evidence:** a timeout or unparseable answer depends on the file, so refunding it lets one bad file be re-sent without limit. That Gemini bills timed-out calls is an assumption, not verified.
- **Reverse:** `refundsReading` in `lib/health/report.ts`.

## D-004: The old unique index on activities (user_id, external_id) is neither created nor dropped (2026-11-14, PR #1)
- **Context:** the sync upserts on `(user_id, source, external_id)`.
- **Choice:** `sql/05_intervals.sql` creates the three-column key if missing and leaves the old index alone.
- **Evidence:** the old index is stricter and can make a sync fail when two sources share an id; but the Streamlit app, whose code is not in this repository, may use it as a conflict target.
- **Reverse / follow-up:** owner checks the Streamlit app, then runs the `drop index` statement in the comment in `sql/05_intervals.sql`.

## D-005: `sql/00_base_schema.sql` is a reconstruction (2026-11-14, PR #1)
- **Context:** migrations 01–04 were never committed and production is not reachable from these sessions.
- **Choice:** reconstruct the base tables from how the code uses them, for new or staging databases only; it refuses to run where the tables exist.
- **Evidence:** ran with 05–08 on a local PostgreSQL 16 with stand-ins for Supabase's `auth` and `storage`. Guessed types are marked `-- GUESS`.
- **Reverse / follow-up:** replace with a real `supabase db dump --schema public`.

## D-006: The effect-based data loading lint rule is a warning, not an error (2026-11-14, PR #1)
- **Context:** `react-hooks/set-state-in-effect` flags 8 places where pages fetch on mount.
- **Choice:** warn, and track the rewrite as backlog item B-01.
- **Evidence:** rewriting data loading in every page could not be verified in a browser at the time.
- **Reverse:** remove the override in `eslint.config.mjs` once B-01 is done.
