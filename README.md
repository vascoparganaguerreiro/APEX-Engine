# APEX Engine (web)

Next.js + TypeScript on Vercel, with Supabase for login and data (same database as the Streamlit app).

## Deploy (no local install needed)
1. Create a GitHub repository (e.g. `apex-web`) and upload everything in this folder.
2. In Vercel: **Add New > Project**, import the repository. Framework: Next.js (detected automatically).
3. Before deploying, add two **Environment Variables**:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the publishable key)
4. (For the AI summaries) also add this **server-only** variable, with no `NEXT_PUBLIC_` prefix:
   - `GEMINI_API_KEY` = your Google AI Studio key
   - `SUPABASE_SERVICE_ROLE_KEY` = the Supabase service_role key (the daily AI limits are recorded server-side with it; without it the AI features return an error instead of running unlimited)
   Optional: `GEMINI_MODEL` (force a model), `SUMMARY_DAILY_LIMIT` (summaries per user per day, default 30) and `REPORT_DAILY_LIMIT` (lab report readings per user per day, default 10). Limits reset at 00:00 UTC; an invalid value uses the default and 0 turns the feature off.
5. Deploy. Open the address Vercel gives you and sign in with your existing APEX account.

## Run locally (optional, needs Node.js 20.9+)
```
npm install
cp .env.example .env.local   # then fill in the two values
npm run dev
npm test                     # engine tests (Node 22+)
```

## Database
The SQL files live in the repository root and are run by hand in the Supabase SQL Editor, in number order.

**Existing production database** (shared with the Streamlit app): its base tables already exist. Do **not** run `00_base_schema.sql` there. Run `05_intervals.sql`, `06_metric_provenance.sql` and `07_intervals_key_security.sql`, in that order, before deploying the Intervals.icu code. Add the server-only variables INTERVALS_ENCRYPTION_KEY and SUPABASE_SERVICE_ROLE_KEY (see .env.example).

**AI usage limits** (all databases): run `09_ai_usage.sql` after `07_intervals_key_security.sql` and before deploying the code that uses it. It creates the server-only `ai_usage_events` table and the `consume_ai_usage` function that enforce the per-user daily limits for AI summaries and lab report reading.

**New or staging database**: run `00_base_schema.sql` first, then `05_intervals.sql`, `06_metric_provenance.sql`, `07_intervals_key_security.sql` (and optionally `08_supplements_biomarkers.sql`).
Caveat: migrations 01–04 (which created the base tables, including activity notes, AI summaries and weekly summaries) were never committed here. `00_base_schema.sql` is a **reconstruction** from how this code uses the database, not a copy of production: types and defaults marked `GUESS` may differ. It refuses to run if its tables already exist. Whoever has production access should replace it with a real dump, e.g. `supabase db dump --db-url "$PROD_DB_URL" --schema public` or `pg_dump --schema-only --schema=public "$PROD_DB_URL"`.

Optional modules: run `08_supplements_biomarkers.sql` (supplements, blood biomarkers, private `lab-reports` storage) in staging first. Automatic reading of lab reports reuses the server-side `GEMINI_API_KEY`; without it, results can still be entered manually.
