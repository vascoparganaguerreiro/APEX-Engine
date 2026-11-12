# Migration preflight: 09, 10, 11, 12 (STAGING ONLY)

Status: preparation only. Nothing in this document has been executed. Every query below was checked against the SQL files
`09_biomarker_rate_limit.sql`, `10_races.sql`, `11_profile.sql` and `12_coach.sql` as they are in the repository, but none has been
run against a database.

- Target: the **staging** Supabase project `ncbceqrulodrdkptnfot` only.
- Never run any of this against production (`kklspdchkaunzxnfdmjr`).
- The migration files themselves must not be edited; they are pasted as they are.
- Queries marked READ-ONLY change nothing. Anything that writes is labelled as such and is optional.

---

## 1. Summary

| | Creates / changes | Touches existing data? | Safe to re-run? | Locks on existing tables |
|---|---|---|---|---|
| 09 | new table `biomarker_extract_requests`, function `consume_extraction_quota` | no | yes | brief `SHARE ROW EXCLUSIVE` on `auth.users` (foreign key) |
| 10 | 6 columns + 5 checks on `races`, fills in `sport` | adds values to new columns only | yes, with the caveats in 2.2 | `ACCESS EXCLUSIVE` on `races` for the whole script |
| 11 | 11 columns + 11 checks on `profiles` | no (new columns start empty) | yes, with the caveats in 2.3 | `ACCESS EXCLUSIVE` on `profiles` for the whole script |
| 12 | 4 new `coach_*` tables, function `consume_coach_quota` | no | yes, with the caveats in 2.4 | brief `SHARE ROW EXCLUSIVE` on `auth.users` (foreign keys) |

**Recommended order:** 09 → 10 → 11 → 12. Apply one at a time, and verify each before starting the next.

None of the four depends on another in SQL, so **11 is not required before 12**. The order follows the file headers, and only 10 and 11
alter existing tables.

---

## 2. Migration-by-migration assessment

### 2.1 Migration 09: biomarker extraction rate limit

**Objects**
- Table `public.biomarker_extract_requests`, with columns `id` (uuid, primary key, default `gen_random_uuid()`), `user_id` (uuid, not null,
  foreign key to `auth.users` with on-delete cascade) and `requested_at` (timestamptz, not null, default `now()`).
- Index `biomarker_extract_requests_user_time_idx` on `(user_id, requested_at)`.
- RLS enabled and forced on the table, with no policies.
  - `revoke all … from public, anon, authenticated`.
  - `grant select, insert, delete … to service_role`.
- Function `public.consume_extraction_quota(uuid, integer, integer)`:
  - returns `(allowed, remaining, retry_after_seconds)`; `security invoker`, `search_path = public`;
  - takes a per-user lock with `pg_advisory_xact_lock(hashtextextended('biomarker_extract:'||uid, 0))`;
  - reads the clock with `clock_timestamp()` after the lock is held;
  - deletes that user's rows outside the window, then counts, then inserts.
- Function access:
  - `revoke all on function … from public, anon, authenticated`;
  - `grant execute … to service_role`.

**Dependencies**
- In SQL:
  - `auth.users`;
  - the roles `anon`, `authenticated` and `service_role` (the `revoke`/`grant` statements fail if a role is missing);
  - `gen_random_uuid()` (built into Postgres 13 and later);
  - `hashtextextended` and `pg_advisory_xact_lock` (both built in).
- Not dependent on 08 in SQL. The header comment "Run after 08" describes the feature: reading a report is only useful once 08's biomarker
  tables exist to save the results.

**Re-run and data**
- Fully guarded: `if not exists`, `create or replace`, and repeatable `revoke`/`grant`.
- Nothing existing is changed.
- During normal use the function deletes that user's expired rate-limit rows. That is intended, and the rows hold no health data.

### 2.2 Migration 10: Race Hub columns on `races`

**Objects**
- Columns:
  - `sport` text;
  - `location` text;
  - `distance` numeric;
  - `distance_unit` text;
  - `target_time_s` integer;
  - `status` text, not null, default `'planned'`.
- Fill-in: `update races set sport = <mapping of race_type> where sport is null`. Unknown `race_type` values become `other`.
- `sport` gets default `'other'` and becomes not null.
- Checks. Each is preceded by `drop constraint if exists` with the same name:
  - `races_sport_check`
  - `races_status_check`
  - `races_distance_check`
  - `races_target_time_check`
  - `races_location_len`
- RLS, policies and grants on `races` are not touched.

**Dependencies**
- In SQL: the existing `public.races` table, including a `race_type` column (used by the fill-in).
- The `races` table is not created by any migration file in this repository, so its existence must be checked (P10-1).

**Re-run safety**
- Every added constraint is guarded by `drop constraint if exists`.
- Columns use `add column if not exists`, and the fill-in only touches rows where `sport is null`.
- Re-running is therefore safe, with these caveats, all detected by the pre-checks:
  - **A same-named constraint is replaced silently.** `drop constraint if exists` removes an existing constraint of the same name even if its
    definition is different (P10-4).
  - **A pre-existing column is kept as it is.** If one of the six columns already exists, `add column if not exists` skips it.
    - A pre-existing nullable `status` would stay nullable, without the `'planned'` default (P10-2).
    - A pre-existing column with a different type, or with values outside the new checks, makes the migration fail and roll back
      (P10-2, P10-3).
- Each re-run re-takes the `ACCESS EXCLUSIVE` lock and re-validates all five checks.

**Data**
- No existing value is overwritten or deleted.
- Every existing race gets `status = 'planned'`. Past races still show under "Past", because "upcoming" requires a date on or after today.

**Locks and cost**
- `ACCESS EXCLUSIVE` on `races` from the first `alter table` until commit.
- During that time the script runs the fill-in, the not-null scan and five validations. That is proportional to the number of races,
  which is small.

### 2.3 Migration 11: profile columns on `profiles`

**Objects**
- Columns:
  - `birth_date` date;
  - `body_fat_pct` numeric(4,1);
  - `preferred_sports` text[], not null, default `'{}'`;
  - `primary_goal` text;
  - `goal_notes` text;
  - `resting_hr` integer;
  - `vo2max` numeric(4,1);
  - `lthr` integer;
  - `threshold_pace_s_per_km` integer;
  - `experience_level` text;
  - `field_sources` jsonb, not null, default `'{}'`.
- 11 checks. Each is preceded by `drop constraint if exists` with the same name:
  - `profiles_birth_date_check`
  - `profiles_body_fat_check`
  - `profiles_preferred_sports_check`
  - `profiles_primary_goal_check`
  - `profiles_goal_notes_len`
  - `profiles_resting_hr_check`
  - `profiles_vo2max_check`
  - `profiles_lthr_check`
  - `profiles_threshold_pace_check`
  - `profiles_experience_check`
  - `profiles_field_sources_check`
- RLS (`own_profile`) and grants are not touched.

**Dependencies:** in SQL, only the existing `public.profiles` table.

**Re-run safety**
- Same pattern as 10: guarded, and safe to re-run.
- Caveats:
  - **A same-named constraint is replaced silently** (P11-4).
  - **A pre-existing column is kept as it is.** A pre-existing nullable `preferred_sports` or `field_sources` would stay nullable (P11-2).
  - **The birth-date check uses `current_date`.** Postgres accepts this. The check only becomes more permissive over time, so restoring or
    re-validating later cannot fail because of it.

**Data:** none changed. The new columns start empty, and `field_sources` starts as `{}`.

**Locks:** `ACCESS EXCLUSIVE` on `profiles` until commit, covering 11 validations of a small table.

### 2.4 Migration 12: Coach

**Objects**
- Tables. All have `user_id` referencing `auth.users` with on-delete cascade.
  - `coach_conversations`
  - `coach_chat_messages` (also references `coach_conversations`, with on-delete cascade)
  - `coach_assessments`
  - `coach_usage`, with columns:
    - `kind` checked to be `chat`, `plan`, `session` or `daily`;
    - `requested_at`, `tokens_in`, `tokens_out`, `model`;
    - `outcome` checked to be `ok` or `error`.
- Indexes:
  - `coach_conversations_user_idx`
  - `coach_chat_messages_conv_idx`
  - `coach_assessments_user_idx`
  - `coach_usage_user_time_idx`
- RLS:
  - enabled on all four tables;
  - additionally forced on `coach_usage`;
  - the six policies below are each preceded by `drop policy if exists`;
  - `coach_usage` deliberately has no policy.

| Policy | Table | Command |
|---|---|---|
| own conversations read | `coach_conversations` | SELECT |
| own conversations delete | `coach_conversations` | DELETE |
| own messages read | `coach_chat_messages` | SELECT |
| own messages delete | `coach_chat_messages` | DELETE |
| own assessments read | `coach_assessments` | SELECT |
| own assessments delete | `coach_assessments` | DELETE |

- Table grants:
  - `revoke all` on the four tables `from public, anon, authenticated`;
  - `grant select, delete` on the three non-usage tables `to authenticated`;
  - `grant select, insert, update, delete` on all four `to service_role`.
- The old `public.coach_messages` table is not touched.
- Function `public.consume_coach_quota(p_user uuid, p_kind text, p_hour_limit integer default 30, p_day_limit integer default 150)`:
  - returns `(allowed, remaining_hour, retry_after_seconds, usage_id)`; `security invoker`, `search_path = public`.

**Function permissions** (verified against the actual statements)
- Statements in the file:
  - `revoke all on function public.consume_coach_quota(uuid, text, integer, integer) from public, anon, authenticated;`
  - `grant execute on function public.consume_coach_quota(uuid, text, integer, integer) to service_role;`
- Expected result:
  - PUBLIC: no EXECUTE;
  - anon: no EXECUTE;
  - authenticated: no EXECUTE;
  - service_role: EXECUTE;
  - the owner (the role running the script, normally `postgres`): EXECUTE.
- The explicit revoke from `public` matters for two reasons:
  - Postgres grants EXECUTE to PUBLIC by default;
  - Supabase's default privileges also grant EXECUTE to `anon`/`authenticated`.
- Re-run: `create or replace` keeps the existing permissions, and the revoke/grant run again.
- Post-check Q12-4 also covers an empty permission list, which would mean the default (PUBLIC can execute).

**Locking and atomicity**
- Order inside the function:
  1. `pg_advisory_xact_lock(hashtextextended('coach:'||uid, 0))`;
  2. `clock_timestamp()`, read after the lock is held;
  3. delete that user's rows older than 35 days;
  4. count the last hour and the last 24 hours;
  5. if under both limits, insert one row and return its id.
- The lock lasts until the transaction ends, so a second call for the same user waits. When it continues it counts with a fresh snapshot
  (READ COMMITTED), so it sees the committed row.
- Two different users can occasionally get the same lock key. That only makes them wait; counts stay correct.
- The key namespace is separate from 09's (`biomarker_extract:`), so the two limiters never block each other.

**Pooling**
- The app calls the function through PostgREST (`supabase-js rpc`), which runs each call in a single transaction.
- The lock is transaction-scoped, not session-scoped, so it is released at commit. It is safe with Supavisor transaction pooling too.

**Permissions at run time**
- The function runs as its caller. The app calls it with the service-role client.
- `service_role` has BYPASSRLS in Supabase, so forced RLS without policies does not block it (checked in P-ENV-1).

**Rate-limit configuration**
- The limits are passed by the server, not the browser:
  - `COACH_HOURLY_LIMIT`, default 30, allowed 1–500;
  - `COACH_DAILY_LIMIT`, default 150, allowed 1–5000.
- Both `/api/coach` and `/api/summarize` raise the daily limit to at least the hourly one.
- The function raises `invalid arguments` for:
  - a null user;
  - an unknown kind;
  - an hourly limit below 1;
  - a daily limit below the hourly limit.
  The app turns that into a 503: no AI call is made.

**Cleanup**
- Each call deletes only the calling user's rows older than 35 days.
- An inactive user's rows stay until their next call. That is bounded by the daily limit × 35.

**Dependencies**
- In SQL:
  - `auth.users`;
  - `auth.uid()` (used in the policies);
  - the roles `anon`, `authenticated` and `service_role`;
  - `gen_random_uuid()`, `hashtextextended` and `pg_advisory_xact_lock`.
- It does not depend on 09, 10 or 11.

**Re-run safety**
- Everything is guarded. Caveats:
  - `create table if not exists` skips an existing table of the same name **even if its shape is different**. The function could then fail
    when used (P12-2).
  - `create index if not exists` skips if an index with the same **name** exists on any table in `public` (P12-3).
  - `create or replace function` fails, and the script rolls back, if a function with this signature already exists with a different
    return type (P12-4).

**Data:** new tables only. Nothing existing is changed.

**Minor:** `coach_chat_messages.user_id` has no index starting with `user_id`, so deleting a user scans that table. Not urgent.

---

## 3. Dependencies

### 3.1 Genuine SQL dependencies (the script fails without them)
| Migration | Needs |
|---|---|
| 09 | `auth.users`; roles `anon`, `authenticated`, `service_role` |
| 10 | `public.races` with a `race_type` column |
| 11 | `public.profiles` |
| 12 | `auth.users`, `auth.uid()`; roles `anon`, `authenticated`, `service_role` |

None of 09–12 needs 06, 07 or 08, or each other, in SQL.

### 3.2 Application feature dependencies (the app degrades without them)
| Feature | Needs | Behaviour when missing |
|---|---|---|
| Today | base tables; 06 (data sources); 08, 12, 14 per section | Each section shows its own plain "isn't set up on your account yet" message (no migration numbers are shown to people). Races load through the original-columns fallback. |
| Races page (list, create, edit) | **10** for location, distance, target time, status and swimming/football | Without 10 the page still lists, creates, edits and deletes races with the original fields (name, date, sport as far as the format shows it, format, priority, goal, notes). A banner says the extra details are not set up, and the form does not offer them, so nothing typed is lost. A save that would lose a detail is refused. Today, the Coach and summaries find the next race through the same fallback. |
| Profile | 11 for extended fields | Base fields work; extended fields are marked as pending a database update. |
| Supplements | 08 | Unavailable. |
| Biomarkers | 08 (manual entry), **09** (reading a report) | Report reading returns 503 ("enter the results manually"); manual entry works. |
| Strength Hub | 13; Ask APEX and workout evaluation also need **12** | AI answers return 503; logging works. |
| Coach (daily, chat, plan, session) | **12** | 503 (no limiter, so no AI call). Consent (400) and account checks (403) run first. |
| Activity and weekly AI summaries | **12**, plus server env `SUPABASE_SERVICE_ROLE_KEY` and `GEMINI_API_KEY` | 503 (fails closed). The account check (403) and the "activities not shared" check (403) run first. |
| Universal Connect | 14 (needs 06 in SQL); Intervals needs 05–07 | "Not set up". |

Re-running 06 after 14 would put back 06's narrower `daily_metrics_source_values` check, which does not allow `whoop`. Never re-run 06 once 14
is applied.

---

## 4. Execution method (Supabase SQL Editor)

**Files contain no transaction statements.** None of the four files has `BEGIN`, `COMMIT`, `ROLLBACK`, `lock_timeout` or
`statement_timeout`.

**How the SQL Editor runs them**
- The SQL Editor sends the editor contents as one multi-statement query.
- Postgres runs a multi-statement query as **one implicit transaction**, unless the text contains its own transaction commands.
- So a file pasted as it is applies completely or not at all: an error rolls back every statement of that run.

**Do not add `BEGIN; … COMMIT;` in the SQL Editor**
- With an explicit `BEGIN`, an error leaves that connection in an aborted transaction until a `ROLLBACK`. Nothing is committed, but the
  following runs fail confusingly.
- `SET LOCAL` outside an explicit `BEGIN` has no effect.
- (This corrects the earlier recommendation.)

**Recommended run, per migration**
1. **Confirm the SQL Editor runs one transaction per run** (READ-ONLY probe, run once):
   ```sql
   select pg_sleep(1.2);
   select (statement_timestamp() - now()) > interval '1 second' as editor_runs_one_transaction;   -- expect true
   ```
   - `now()` is fixed at the start of the transaction, while `statement_timestamp()` advances with each statement.
   - `true` means both statements shared one transaction.
   - If this returns `false`, **stop** and use psql instead (step 3).
2. **Paste the migration with a lock timeout:** in one editor tab, put the line below, then the unchanged contents of the migration file,
   then `reset lock_timeout;`, and run it once.
   ```sql
   set lock_timeout = '5s';
   -- <paste the unchanged contents of NN_xxx.sql here>
   reset lock_timeout;
   ```
   If anything fails, or a lock cannot be taken within 5 s, the whole run is rolled back.
3. **Alternative: psql**, run by you with the staging connection string. Never paste the connection string or password into notes or logs.
   ```bash
   psql "$STAGING_DB_URL" --single-transaction -v ON_ERROR_STOP=1 -c "set lock_timeout = '5s'" -f 10_races.sql
   ```
4. **Run the post-checks** in a separate run.

---

## 5. Pre-checks (all READ-ONLY)

Run these immediately before each migration.

### 5.0 Applied-migration inventory
These migrations are applied by hand in the SQL Editor, so Supabase's migration history usually does not list them. The catalog is
the source of truth.

```sql
-- INV-1: which objects of 06–14 exist right now
select m, what, present from (values
 ('06','daily_metrics.hrv_source',        exists(select 1 from information_schema.columns where table_schema='public' and table_name='daily_metrics' and column_name='hrv_source')),
 ('06','fn apply_synced_metrics',         exists(select 1 from pg_proc where proname='apply_synced_metrics' and pronamespace='public'::regnamespace)),
 ('07','intervals_credentials',           to_regclass('public.intervals_credentials') is not null),
 ('08','supplements',                     to_regclass('public.supplements') is not null),
 ('08','blood_panels',                    to_regclass('public.blood_panels') is not null),
 ('08','fn save_blood_panel',             exists(select 1 from pg_proc where proname='save_blood_panel' and pronamespace='public'::regnamespace)),
 ('09','biomarker_extract_requests',      to_regclass('public.biomarker_extract_requests') is not null),
 ('09','fn consume_extraction_quota',     to_regprocedure('public.consume_extraction_quota(uuid,integer,integer)') is not null),
 ('10','races.status',                    exists(select 1 from information_schema.columns where table_schema='public' and table_name='races' and column_name='status')),
 ('10','races.sport',                     exists(select 1 from information_schema.columns where table_schema='public' and table_name='races' and column_name='sport')),
 ('10','races_status_check',              exists(select 1 from pg_constraint where conname='races_status_check' and conrelid=to_regclass('public.races'))),
 ('11','profiles.field_sources',          exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='field_sources')),
 ('11','profiles_field_sources_check',    exists(select 1 from pg_constraint where conname='profiles_field_sources_check' and conrelid=to_regclass('public.profiles'))),
 ('12','coach_conversations',             to_regclass('public.coach_conversations') is not null),
 ('12','coach_chat_messages',             to_regclass('public.coach_chat_messages') is not null),
 ('12','coach_assessments',               to_regclass('public.coach_assessments') is not null),
 ('12','coach_usage',                     to_regclass('public.coach_usage') is not null),
 ('12','fn consume_coach_quota',          to_regprocedure('public.consume_coach_quota(uuid,text,integer,integer)') is not null),
 ('13','strength_sessions',               to_regclass('public.strength_sessions') is not null),
 ('14','provider_connections',            to_regclass('public.provider_connections') is not null),
 ('14','metric_observations',             to_regclass('public.metric_observations') is not null)
) t(m, what, present) order by m, what;

-- INV-2: is the CLI migration history table there at all? Only if this is not null, run INV-3.
select to_regclass('supabase_migrations.schema_migrations') as cli_history_table;
-- INV-3
select version, name from supabase_migrations.schema_migrations order by version;
```
Save the INV-1 output before you start, and compare it again at the end.

### 5.1 Environment (before the first migration)
```sql
-- P-ENV-1: roles exist; service_role bypasses RLS (needed for coach_usage / biomarker_extract_requests)
select rolname, rolbypassrls from pg_roles where rolname in ('anon','authenticated','service_role') order by 1;
-- expect 3 rows; service_role = true
-- P-ENV-2: Postgres version (gen_random_uuid built in from 13)
show server_version;                                  -- expect 15.x or later
```
**Stop if:** any of the three roles is missing, or `service_role` does not bypass RLS.

### 5.2 Before 09
```sql
-- P09-1: existing objects with the same names (expect 0 rows on a first run)
select 'table' kind, c.relname name from pg_class c where c.relnamespace='public'::regnamespace and c.relname='biomarker_extract_requests'
union all select 'index', indexname from pg_indexes where schemaname='public' and indexname='biomarker_extract_requests_user_time_idx'
union all select 'function', p.oid::regprocedure::text || ' -> ' || pg_get_function_result(p.oid) from pg_proc p
  where p.pronamespace='public'::regnamespace and p.proname='consume_extraction_quota';
-- P09-2: if the table exists, its shape (expect exactly id uuid, user_id uuid, requested_at timestamptz)
select column_name, udt_name, is_nullable from information_schema.columns
where table_schema='public' and table_name='biomarker_extract_requests' order by ordinal_position;
```
**Stop if:**
- the table exists with other columns;
- the index name exists on a different table;
- the function exists with a different signature or return type.

  The correct return type is `TABLE(allowed boolean, remaining integer, retry_after_seconds integer)`.

### 5.3 Before 10
```sql
-- P10-1: the base table and the column the fill-in needs
select to_regclass('public.races') as races_table,
       exists(select 1 from information_schema.columns where table_schema='public' and table_name='races' and column_name='race_type') as has_race_type,
       (select relrowsecurity from pg_class where oid = to_regclass('public.races')) as rls_on,
       (select count(*) from public.races) as row_count;      -- run only if races_table is not null
-- expect: public.races, true, true, <n>  (write <n> down)

-- P10-2: any of the six columns that ALREADY exists, with its type, nullability and default
select e.col, e.expected_udt, c.udt_name as actual_udt, c.is_nullable, c.column_default
from (values ('sport','text'),('location','text'),('distance','numeric'),('distance_unit','text'),('target_time_s','int4'),('status','text')) e(col, expected_udt)
left join information_schema.columns c on c.table_schema='public' and c.table_name='races' and c.column_name=e.col
order by 1;
-- first run: actual_udt is null on all six rows

-- P10-3: existing values that would violate the new checks (works whether or not the columns exist; all zeros = OK)
select
  count(*) filter (where j->>'sport' is not null and j->>'sport' not in ('running','cycling','triathlon','swimming','football','other'))      as bad_sport,
  count(*) filter (where j ? 'status' and (j->>'status' is null or j->>'status' not in ('planned','registered','completed','dnf','dns','cancelled'))) as bad_or_null_status,
  count(*) filter (where (j->>'distance' is null) <> (j->>'distance_unit' is null)
                      or (j->>'distance' is not null and ((j->>'distance')::numeric <= 0 or j->>'distance_unit' not in ('km','mi','m')))) as bad_distance,
  count(*) filter (where j->>'target_time_s' is not null and ((j->>'target_time_s')::numeric <= 0 or (j->>'target_time_s')::numeric > 604800)) as bad_target_time,
  count(*) filter (where j->>'location' is not null and char_length(j->>'location') > 120)                                                     as bad_location
from (select to_jsonb(r) as j from public.races r) x;

-- P10-3b: how the fill-in will map race_type (informational; unknown values become 'other')
select race_type, count(*) from public.races group by 1 order by 1;

-- P10-4: constraints with the names the migration drops and recreates (first run: 0 rows)
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = to_regclass('public.races')
  and conname in ('races_sport_check','races_status_check','races_distance_check','races_target_time_check','races_location_len');

-- P10-5: current policies (to compare afterwards; expect only the owner policy, e.g. own_rows)
select policyname, cmd, roles from pg_policies where schemaname='public' and tablename='races' order by 1;
```
-- P10-6: everything else attached to races (informational, but read it): constraints, triggers, dependent views
select 'constraint' as kind, conname as name, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = to_regclass('public.races')
union all
select 'trigger', tgname, pg_get_triggerdef(oid) from pg_trigger where tgrelid = to_regclass('public.races') and not tgisinternal
union all
select 'dependent view', c.relname, null from pg_depend d join pg_rewrite r on r.oid = d.objid join pg_class c on c.oid = r.ev_class
where d.refobjid = to_regclass('public.races') and c.oid <> d.refobjid and c.relkind in ('v','m')
order by 1, 2;

-- P10-7: who may write races, and at what level (the new columns are only writable if the table-level grant exists)
select grantee, privilege_type from information_schema.table_privileges
where table_schema='public' and table_name='races' and grantee in ('anon','authenticated') order by 1, 2;
select grantee, column_name, privilege_type from information_schema.column_privileges
where table_schema='public' and table_name='races' and grantee in ('anon','authenticated') and column_name in ('race_type','notes') order by 1, 2, 3;

-- P10-8: every race has an owner (the row-level policy is what separates accounts)
select count(*) as rows_without_owner from public.races where user_id is null;     -- expect 0
```
**Stop if:**
- `races_table` is null, or `has_race_type` is false;
- P10-6 shows a CHECK on `race_type` or `priority` that rejects a value the app writes (`race_type`: `10k`, `half_marathon`, `marathon`, `trail`,
  `cycling`, `triathlon_sprint`, `triathlon_olympic`, `half_ironman`, `ironman`, `other`; `priority`: `A`, `B`, `C`), a trigger that reads or writes the
  columns being added, or a view you do not recognise (a view built on `races` does not see new columns, which is safe, but find out what it is);
- P10-7 shows `authenticated` with column-level privileges only (no table-level INSERT and UPDATE), or any privilege for `anon`;
- P10-8 is above 0;
- any P10-2 row has an `actual_udt` that differs from `expected_udt`;
- `status` already exists and `is_nullable = 'YES'`;
- any P10-3 counter is above 0, or P10-3 itself fails with a cast error (a non-numeric value in an existing `distance` or
  `target_time_s` column);
- P10-4 returns a constraint whose definition differs from the one in `10_races.sql`.

### 5.4 Before 11
```sql
-- P11-1
select to_regclass('public.profiles') as profiles_table,
       (select relrowsecurity from pg_class where oid = to_regclass('public.profiles')) as rls_on,
       (select count(*) from public.profiles) as row_count;   -- run only if profiles_table is not null; write <n> down

-- P11-2: any of the eleven columns that ALREADY exists
select e.col, e.expected_udt, c.udt_name as actual_udt, c.is_nullable, c.column_default
from (values ('birth_date','date'),('body_fat_pct','numeric'),('preferred_sports','_text'),('primary_goal','text'),('goal_notes','text'),
             ('resting_hr','int4'),('vo2max','numeric'),('lthr','int4'),('threshold_pace_s_per_km','int4'),('experience_level','text'),('field_sources','jsonb')) e(col, expected_udt)
left join information_schema.columns c on c.table_schema='public' and c.table_name='profiles' and c.column_name=e.col
order by 1;
-- first run: actual_udt is null on all eleven rows

-- P11-3: existing values that would violate the new checks (all zeros = OK)
select
  count(*) filter (where j->>'birth_date' is not null and ((j->>'birth_date')::date < date '1900-01-01' or (j->>'birth_date')::date > current_date + 1)) as bad_birth_date,
  count(*) filter (where j->>'body_fat_pct' is not null and (j->>'body_fat_pct')::numeric not between 2 and 60)            as bad_body_fat,
  count(*) filter (where jsonb_typeof(j->'preferred_sports') = 'array' and (jsonb_array_length(j->'preferred_sports') > 7
                      or exists (select 1 from jsonb_array_elements_text(j->'preferred_sports') s(v)
                                 where s.v not in ('running','cycling','triathlon','swimming','strength','football','other'))))     as bad_preferred_sports,
  count(*) filter (where j->>'primary_goal' is not null and j->>'primary_goal' not in ('general_fitness','weight_management','endurance','speed','race_performance','health','return_from_injury')) as bad_primary_goal,
  count(*) filter (where j->>'goal_notes' is not null and char_length(j->>'goal_notes') > 500)                             as bad_goal_notes,
  count(*) filter (where j->>'resting_hr' is not null and (j->>'resting_hr')::numeric not between 25 and 120)              as bad_resting_hr,
  count(*) filter (where j->>'vo2max' is not null and (j->>'vo2max')::numeric not between 10 and 95)                       as bad_vo2max,
  count(*) filter (where j->>'lthr' is not null and (j->>'lthr')::numeric not between 60 and 230)                          as bad_lthr,
  count(*) filter (where j->>'threshold_pace_s_per_km' is not null and (j->>'threshold_pace_s_per_km')::numeric not between 90 and 1200) as bad_threshold_pace,
  count(*) filter (where j->>'experience_level' is not null and j->>'experience_level' not in ('beginner','intermediate','advanced','elite')) as bad_experience,
  count(*) filter (where j ? 'field_sources' and jsonb_typeof(j->'field_sources') not in ('object','null'))                as bad_field_sources
from (select to_jsonb(p) as j from public.profiles p) x;

-- P11-4: constraints with the names the migration drops and recreates (first run: 0 rows)
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = to_regclass('public.profiles')
  and conname in ('profiles_birth_date_check','profiles_body_fat_check','profiles_preferred_sports_check','profiles_primary_goal_check',
                  'profiles_goal_notes_len','profiles_resting_hr_check','profiles_vo2max_check','profiles_lthr_check',
                  'profiles_threshold_pace_check','profiles_experience_check','profiles_field_sources_check');

-- P11-5: current policies (expect only own_profile)
select policyname, cmd, roles from pg_policies where schemaname='public' and tablename='profiles' order by 1;
```
**Stop if:**
- `profiles_table` is null;
- any P11-2 row has an `actual_udt` that differs from `expected_udt`;
- `preferred_sports` or `field_sources` already exists with `is_nullable = 'YES'`;
- any P11-3 counter is above 0, or P11-3 fails with a cast error;
- P11-4 returns a constraint whose definition differs from the one in `11_profile.sql`.

### 5.5 Before 12
```sql
-- P12-1: the old table stays untouched (informational) and nothing new exists yet
select to_regclass('public.coach_messages') as legacy_coach_messages,
       to_regclass('public.coach_conversations') as conversations, to_regclass('public.coach_chat_messages') as chat_messages,
       to_regclass('public.coach_assessments') as assessments, to_regclass('public.coach_usage') as usage;
-- first run: the last four are null

-- P12-2: if any of the four tables already exists, its columns (must match 12_coach.sql exactly)
select table_name, string_agg(column_name || ':' || udt_name, ', ' order by ordinal_position) as cols
from information_schema.columns
where table_schema='public' and table_name in ('coach_conversations','coach_chat_messages','coach_assessments','coach_usage')
group by 1 order by 1;
-- expected if present:
--   coach_usage: id:uuid, user_id:uuid, kind:text, requested_at:timestamptz, tokens_in:int4, tokens_out:int4, model:text, outcome:text

-- P12-3: index names already in use in public (if an index of that name exists on ANOTHER table, "if not exists" silently skips it)
select indexname, tablename from pg_indexes where schemaname='public'
  and indexname in ('coach_conversations_user_idx','coach_chat_messages_conv_idx','coach_assessments_user_idx','coach_usage_user_time_idx');

-- P12-4: an existing function with this name and its return type
select p.oid::regprocedure as signature, pg_get_function_result(p.oid) as returns
from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='consume_coach_quota';
-- first run: 0 rows. If present, returns must be
--   TABLE(allowed boolean, remaining_hour integer, retry_after_seconds integer, usage_id uuid)
```
**Stop if:**
- a `coach_*` table already exists with different columns;
- an index name listed in P12-3 belongs to a different table;
- `consume_coach_quota` exists with a different signature or return type.

---

## 6. Post-checks (all READ-ONLY)

### 6.1 After 09
```sql
-- Q09-1: table hardening
select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.biomarker_extract_requests'::regclass;   -- true, true
select count(*) from pg_policies where schemaname='public' and tablename='biomarker_extract_requests';               -- 0
select grantee, privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name='biomarker_extract_requests' and grantee in ('PUBLIC','anon','authenticated');  -- 0 rows
-- Q09-2: function permissions (including PUBLIC)
select has_function_privilege('public',        'public.consume_extraction_quota(uuid,integer,integer)', 'EXECUTE') as public_exec,  -- false
       has_function_privilege('anon',          'public.consume_extraction_quota(uuid,integer,integer)', 'EXECUTE') as anon_exec,    -- false
       has_function_privilege('authenticated', 'public.consume_extraction_quota(uuid,integer,integer)', 'EXECUTE') as auth_exec,    -- false
       has_function_privilege('service_role',  'public.consume_extraction_quota(uuid,integer,integer)', 'EXECUTE') as svc_exec;     -- true
select p.proacl is null as default_acl, p.prosecdef, p.proconfig
from pg_proc p where p.oid = 'public.consume_extraction_quota(uuid,integer,integer)'::regprocedure;   -- false, false, {search_path=public}
select coalesce(r.rolname, 'PUBLIC') as grantee, a.privilege_type
from pg_proc p cross join lateral aclexplode(p.proacl) a left join pg_roles r on r.oid = a.grantee
where p.oid = 'public.consume_extraction_quota(uuid,integer,integer)'::regprocedure order by 1;
-- expect EXECUTE only for the owner (e.g. postgres) and service_role
```

### 6.2 After 10
```sql
-- Q10-1: columns (sport and status NOT NULL)
select column_name, udt_name, is_nullable, column_default from information_schema.columns
where table_schema='public' and table_name='races'
  and column_name in ('sport','location','distance','distance_unit','target_time_s','status') order by 1;
-- expect 6 rows; sport: NO, default 'other'::text; status: NO, default 'planned'::text
-- Q10-2: the five checks, by exact name, all validated  (parenthesised name list: corrected from the first draft)
select conname, convalidated, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.races'::regclass
  and conname in ('races_sport_check','races_status_check','races_distance_check','races_target_time_check','races_location_len')
order by 1;
-- expect exactly 5 rows, convalidated = true
-- Q10-3: data
select count(*) as row_count, count(*) filter (where sport is null) as null_sport, count(*) filter (where status <> 'planned') as not_planned
from public.races;
-- expect row_count = P10-1 value, null_sport = 0, not_planned = 0 (first run only)
select sport, count(*) from public.races group by 1 order by 1;      -- matches the P10-3b mapping
-- Q10-4: RLS and policies unchanged
select relrowsecurity from pg_class where oid='public.races'::regclass;                              -- true
select policyname, cmd, roles from pg_policies where schemaname='public' and tablename='races' order by 1;   -- identical to P10-5
-- Q10-5: grants and ownership unchanged
select grantee, privilege_type from information_schema.table_privileges
where table_schema='public' and table_name='races' and grantee in ('anon','authenticated') order by 1, 2;      -- identical to P10-7
select count(*) as rows_without_owner from public.races where user_id is null;                                  -- 0
```
**If the Races page still says it is not set up after Q10-1 to Q10-5 pass**, the API's schema cache has not noticed the new columns. Run this
once (it changes no data; it only asks the API to re-read the table definitions), wait a few seconds, then reload the page:
```sql
notify pgrst, 'reload schema';
```

### 6.3 After 11
```sql
-- Q11-1: columns
select column_name, udt_name, is_nullable, column_default from information_schema.columns
where table_schema='public' and table_name='profiles'
  and column_name in ('birth_date','body_fat_pct','preferred_sports','primary_goal','goal_notes','resting_hr','vo2max','lthr',
                      'threshold_pace_s_per_km','experience_level','field_sources') order by 1;
-- expect 11 rows; preferred_sports: _text, NO, '{}'::text[]; field_sources: jsonb, NO, '{}'::jsonb; the rest YES / no default
-- Q11-2: the eleven checks, by exact name, all validated
select conname, convalidated from pg_constraint
where conrelid = 'public.profiles'::regclass
  and conname in ('profiles_birth_date_check','profiles_body_fat_check','profiles_preferred_sports_check','profiles_primary_goal_check',
                  'profiles_goal_notes_len','profiles_resting_hr_check','profiles_vo2max_check','profiles_lthr_check',
                  'profiles_threshold_pace_check','profiles_experience_check','profiles_field_sources_check')
order by 1;
-- expect exactly 11 rows, convalidated = true
-- Q11-3: data (nothing invented)
select count(*) as row_count, count(*) filter (where field_sources <> '{}'::jsonb) as with_sources from public.profiles;
-- expect row_count = P11-1 value; with_sources = 0 immediately after the migration
-- Q11-4: RLS and policies unchanged
select relrowsecurity from pg_class where oid='public.profiles'::regclass;                              -- true
select policyname, cmd, roles from pg_policies where schemaname='public' and tablename='profiles' order by 1;   -- identical to P11-5
```

### 6.4 After 12
```sql
-- Q12-1: tables and RLS
select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c
where c.oid in ('public.coach_conversations'::regclass, 'public.coach_chat_messages'::regclass,
                'public.coach_assessments'::regclass, 'public.coach_usage'::regclass) order by 1;
-- expect 4 rows, relrowsecurity = true everywhere; relforcerowsecurity = true only for coach_usage
-- Q12-2: policies (exact names)
select tablename, policyname, cmd from pg_policies where schemaname='public'
  and tablename in ('coach_conversations','coach_chat_messages','coach_assessments','coach_usage') order by 1, 2;   -- the legacy coach_messages is excluded on purpose
-- expect exactly 6 rows (read = SELECT, delete = DELETE) on coach_assessments, coach_chat_messages, coach_conversations; none on coach_usage
-- Q12-3: table privileges for browser roles
select table_name, grantee, privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name in ('coach_conversations','coach_chat_messages','coach_assessments','coach_usage')
  and grantee in ('PUBLIC','anon','authenticated') order by 1, 2, 3;
-- expect only: authenticated DELETE + SELECT on coach_assessments, coach_chat_messages, coach_conversations (6 rows); nothing on coach_usage; nothing for anon/PUBLIC
select has_table_privilege('authenticated','public.coach_usage','SELECT') as auth_usage_select,          -- false
       has_table_privilege('authenticated','public.coach_chat_messages','INSERT') as auth_msg_insert,     -- false
       has_table_privilege('service_role','public.coach_usage','INSERT') as svc_usage_insert,            -- true
       has_table_privilege('service_role','public.coach_usage','UPDATE') as svc_usage_update;            -- true
-- Q12-4: function permissions (including PUBLIC and the default-permissions case)
select has_function_privilege('public',        'public.consume_coach_quota(uuid,text,integer,integer)', 'EXECUTE') as public_exec,  -- false
       has_function_privilege('anon',          'public.consume_coach_quota(uuid,text,integer,integer)', 'EXECUTE') as anon_exec,    -- false
       has_function_privilege('authenticated', 'public.consume_coach_quota(uuid,text,integer,integer)', 'EXECUTE') as auth_exec,    -- false
       has_function_privilege('service_role',  'public.consume_coach_quota(uuid,text,integer,integer)', 'EXECUTE') as svc_exec;     -- true
select p.proacl is null as default_acl, p.prosecdef, p.proconfig, pg_get_function_result(p.oid) as returns
from pg_proc p where p.oid = 'public.consume_coach_quota(uuid,text,integer,integer)'::regprocedure;
-- expect false, false, {search_path=public}, TABLE(allowed boolean, remaining_hour integer, retry_after_seconds integer, usage_id uuid)
select coalesce(r.rolname, 'PUBLIC') as grantee, a.privilege_type
from pg_proc p cross join lateral aclexplode(p.proacl) a left join pg_roles r on r.oid = a.grantee
where p.oid = 'public.consume_coach_quota(uuid,text,integer,integer)'::regprocedure order by 1;
-- expect EXECUTE only for the owner (e.g. postgres) and service_role
-- Q12-5: indexes
select indexname, tablename from pg_indexes where schemaname='public'
  and indexname in ('coach_conversations_user_idx','coach_chat_messages_conv_idx','coach_assessments_user_idx','coach_usage_user_time_idx') order by 1;
-- expect 4 rows, each on its own coach_* table
```

**Optional functional test of 12.** It **writes**, then always rolls back.
- Use the id of a synthetic staging test user that exists in `auth.users`.
- The deliberate error at the end rolls back everything, including the 35-day cleanup. The error message shows the three results.

```sql
do $$
declare u uuid := '<synthetic-test-user-uuid>'; r1 boolean; r2 boolean; r3 boolean;
begin
  select allowed into r1 from public.consume_coach_quota(u, 'chat', 2, 2);
  select allowed into r2 from public.consume_coach_quota(u, 'chat', 2, 2);
  select allowed into r3 from public.consume_coach_quota(u, 'chat', 2, 2);
  raise exception 'probe only, rolled back: % % % (expected t t f)', r1, r2, r3;
end $$;
```

**Locking test** (optional, psql only): in two sessions, run `begin; select * from public.consume_coach_quota('<uuid>','chat',30,150);` in
the first. The same call in the second session must wait until the first runs `rollback;`.

---

## 7. Backup and recovery

**Before starting**
1. Note the time of the latest automatic backup in the staging dashboard (Database → Backups). Note whether point-in-time recovery is
   available on the staging plan.
2. Make your own copies of the two tables that 10 and 11 alter. Choose one:
   - Table Editor → `races` and `profiles` → Export to CSV;
   - or a dump of only those tables, run by you:
     ```bash
     pg_dump "$STAGING_DB_URL" --schema-only --table=public.races --table=public.profiles > pre_10_11_schema.sql
     pg_dump "$STAGING_DB_URL" --data-only   --table=public.races --table=public.profiles > pre_10_11_data.sql
     ```
   - Store these files privately, and delete them once the migrations are confirmed. Even on staging they may contain personal data.
3. 09 and 12 create only new tables, so there is nothing to back up for them.

**Rollback drafts.** These are not to be run unless a migration has to be withdrawn. Every name has been checked against the SQL files.
Run each in one SQL Editor execution, so it is all-or-nothing.

```sql
-- R09 (loses only rate-limit timestamps; report reading then returns 503, manual entry keeps working)
drop function if exists public.consume_extraction_quota(uuid, integer, integer);
drop table if exists public.biomarker_extract_requests;

-- R10 (IRREVERSIBLE DATA LOSS: every sport, location, distance, distance_unit, target_time_s and status entered after the migration)
alter table public.races drop constraint if exists races_sport_check, drop constraint if exists races_status_check,
  drop constraint if exists races_distance_check, drop constraint if exists races_target_time_check, drop constraint if exists races_location_len;
alter table public.races drop column if exists sport, drop column if exists location, drop column if exists distance,
  drop column if exists distance_unit, drop column if exists target_time_s, drop column if exists status;

-- R11 (IRREVERSIBLE DATA LOSS: every value entered in the 11 new profile fields after the migration)
alter table public.profiles drop constraint if exists profiles_birth_date_check, drop constraint if exists profiles_body_fat_check,
  drop constraint if exists profiles_preferred_sports_check, drop constraint if exists profiles_primary_goal_check,
  drop constraint if exists profiles_goal_notes_len, drop constraint if exists profiles_resting_hr_check,
  drop constraint if exists profiles_vo2max_check, drop constraint if exists profiles_lthr_check,
  drop constraint if exists profiles_threshold_pace_check, drop constraint if exists profiles_experience_check,
  drop constraint if exists profiles_field_sources_check;
alter table public.profiles drop column if exists birth_date, drop column if exists body_fat_pct, drop column if exists preferred_sports,
  drop column if exists primary_goal, drop column if exists goal_notes, drop column if exists resting_hr, drop column if exists vo2max,
  drop column if exists lthr, drop column if exists threshold_pace_s_per_km, drop column if exists experience_level,
  drop column if exists field_sources;

-- R12 (IRREVERSIBLE DATA LOSS: all Coach conversations, messages, assessments and usage history; rate limits reset.
--      NEVER drop public.coach_messages: it predates migration 12)
drop function if exists public.consume_coach_quota(uuid, text, integer, integer);
drop table if exists public.coach_chat_messages, public.coach_conversations, public.coach_assessments, public.coach_usage;
```

**What cannot be undone**
- **Dropped columns and tables:** R10, R11 and R12 permanently delete whatever was stored in them. It can only be recovered from the backup
  taken in step 2, or from the project backup or point-in-time recovery.
- **The fill-in done by 10:** `sport` and `status` exist only in the new columns, so R10 removes them completely. There is no partial undo.
- **Rows deleted by the functions in normal use:** expired rate-limit rows (09) and usage rows older than 35 days (12). This is by design.
  They are not recoverable, and they are not health data.

**App behaviour after a rollback**
- **After R10:** Today, the Coach and summaries keep working through the original-columns fallback. The Races page stops working.
- **After R11:** the Profile page falls back to the base fields.
- **After R12:** the Coach, Ask APEX, workout evaluation and AI summaries return 503.

---

## 8. Stop conditions (abort and do not continue to the next migration)
- The SQL Editor URL or project name is not the staging project `ncbceqrulodrdkptnfot`.
- The transaction probe in section 4 returns `false`. Use psql with `--single-transaction` instead.
- A pre-check's "Stop if" condition is met (sections 5.1–5.5).
- The migration run reports any error, including a lock timeout. The run is rolled back, so investigate before retrying.
- A post-check result differs from its expected value, especially any of these:
  - an EXECUTE or table privilege for PUBLIC, anon or authenticated that should not be there;
  - a missing or unvalidated constraint;
  - a changed row count;
  - a changed policy list.
- Any existing row count (`races`, `profiles`) differs before and after.

## 9. Checklist before applying each migration
- [ ] Confirm the target is the staging project `ncbceqrulodrdkptnfot` (URL and project name).
- [ ] Run INV-1 and save its output. This migration is not already fully applied.
- [ ] Section 5.1 environment checks have passed (once).
- [ ] The transaction probe returned `true` (once per SQL Editor session/browser).
- [ ] Ran all pre-checks for this migration; no stop condition was met.
- [ ] For 10 and 11: CSV export or `pg_dump` taken; latest project backup time noted.
- [ ] Pasted the **unchanged** migration file between `set lock_timeout = '5s';` and `reset lock_timeout;`, and ran it once.
- [ ] Ran all post-checks for this migration; every result matched.
- [ ] Smoke-tested the affected feature in the staging app (section 10).
- [ ] Recorded the date, time and result before moving to the next migration.

## 10. What to test in the app

**Before any of these migrations:**
- Today (each section shows its own state);
- Profile with base fields;
- the next race on Today and in the Coach;
- Supplements and biomarker manual entry (if 08 is applied);
- consent and account isolation, including the 400/403 paths of `/api/coach` and `/api/summarize`;
- Universal Connect status.

**After 09:** reading a lab report (no longer 503; the limit is reported correctly).

**After 10:** the Races page (list, create, edit, status changes); Today and the Coach still show the same next race.

**After 11:** Profile extended fields save and reload. Existing values show "source not recorded".

**After 12:**
- the Coach (daily, chat, plan, session);
- Ask APEX and workout evaluation, with "Share workout" on;
- activity and weekly AI summaries;
- the hourly limit (429 with Retry-After) using a low `COACH_HOURLY_LIMIT` on staging.

  Changing that limit is an environment change on staging: decide separately.
