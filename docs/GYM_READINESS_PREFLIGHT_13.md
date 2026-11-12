# Gym readiness preflight: migration 13 (Strength Hub), STAGING ONLY

Status: preparation only. Nothing here has been executed. Every statement below was checked against `13_strength.sql` (and, for
dependencies, the application code) as it is in the repository. No database was contacted, so **the current state of staging is unknown**.

- Target: the **staging** Supabase project `ncbceqrulodrdkptnfot` only. Never production (`kklspdchkaunzxnfdmjr`).
- Do not edit the migration file; paste it unchanged.
- Companion document: `docs/MIGRATION_PREFLIGHT_09_12.md` (execution method, backup and the checks for migrations 09–12).
- Queries are READ-ONLY unless explicitly marked as writing.

---

## 1. Two corrections to the first assessment

### 1.1 `activities.id`: the exact expected type
- The only references in migration 13 are:
  - `training_session_links.activity_id bigint references public.activities(id) on delete cascade` (line 202);
  - `a.id = (src->>'id')::bigint` in `merge_training_sources` (line 510);
  - `a.id = activity_id` in the `training_session_links` policy (line 322).
- `public.activities` is **not created by any migration file in the repository**. It is part of the base schema, so its `id` type
  can only be read from the staging database. The earlier audit's description (integer) and my earlier "must be int8" were both
  statements about an unseen table.
- What PostgreSQL requires:
  - A foreign key needs an equality operator between the referencing and the referenced column types in the same btree operator family.
  - `int2`, `int4` and `int8` share one, so **a `bigint` column may reference an `integer` (int4) or `bigint` (int8) key.** Both work,
    and the equality comparisons in the function and the policy work with either.
  - `uuid`, `text` and every other type fail with *"foreign key constraint cannot be implemented"*, and the whole migration rolls back.
- Corrected expectation: **`activities.id` must be an integer type: `int4` (integer) or `int8` (bigint). `int8` is not required.**
  - **Stop if** `udt_name` is anything else, or the column does not exist or is not the primary key.
- Application assumptions: activity ids are treated as numbers throughout (`Number(r.id)`, numeric ids in the Activity type).
  - Merge requests send the id as a string, and the function casts it with `::bigint`.
  - Both int4 and int8 satisfy this.
  - Values above 2^53 would not survive JavaScript, which is not realistic here.
- The file's own comment, "activity_id is bigint", is about the new column and is correct. The earlier audit's "integer" is also compatible.

### 1.2 Function execute permissions
The earlier report said both "migration 13 revokes EXECUTE from PUBLIC and anon" and "anon can still execute through Supabase default
permissions". **The second statement was wrong.** The actual statements (lines 552–561), for each of the five functions, are:

```sql
revoke all on function <fn> from public, anon;
grant execute on function <fn> to authenticated;
```

- Supabase's default privileges on schema `public` give new functions explicit EXECUTE to `anon`, `authenticated` and `service_role`
  (and the owner, normally `postgres`), as well as the built-in PUBLIC default.
- The migration's `revoke … from public, anon` runs **after** each function is created, in the same script. It removes both the PUBLIC
  default and anon's explicit grant. **Result for each of the five functions:**

| Role | EXECUTE | Why |
|---|---|---|
| PUBLIC | **no** | explicit `revoke … from public` |
| anon | **no** | explicit `revoke … from anon` (this is a separate entry from PUBLIC, which is why anon is named too) |
| authenticated | **yes** | explicit `grant execute … to authenticated` |
| service_role | **yes**, by environment | Supabase's default privileges; the file does **not** revoke it, and does not grant it either. The post-check shows the actual value |
| owner (`postgres`) | yes | owner privilege |

- All five functions are **SECURITY INVOKER** with `set search_path = public`. They run with the caller's rights, so row-level security
  applies to every statement inside them.
- Every function begins with `if auth.uid() is null then raise exception 'not authenticated'`. Even if some role could call them without
  a login, nothing would be written.
- Difference from 09 and 12: those revoke from `authenticated` too and grant only to `service_role`, because they are server-only
  rate limiters. 13's functions are called by the signed-in browser, so `authenticated` keeps EXECUTE.
- **Schema USAGE is a different permission.** `anon` having USAGE on schema `public` (normal in Supabase) only lets it see names in the
  schema. Whether a role can run a function is decided by that function's EXECUTE privilege alone.
  - Without EXECUTE, PostgREST does not expose the function to that role at all, so a REST/RPC call as `anon` is refused.
  - The post-check below tests EXECUTE directly, and lists the actual permission list, so it cannot be confused with schema access.
- Also checked: `public.strength_touch_updated_at()` is a trigger function with no revoke. It keeps the default EXECUTE, but it returns
  `trigger`, so it cannot be called as a normal function or RPC. That is expected. It is not part of the five.

---

## 2. What migration 13 creates or changes

**Tables (11), all with RLS enabled and one owner-only `for all` policy each**

| Group | Tables |
|---|---|
| Logged workouts | `strength_sessions`, `strength_session_exercises`, `strength_sets` |
| Routines and custom exercises | `strength_routines`, `strength_routine_exercises`, `strength_routine_sets`, `strength_custom_exercises` |
| Duplicate handling | `training_sessions`, `training_session_links`, `training_merge_decisions` |
| Device settings | `wearable_devices` |

- **Logged workouts.** Each row has a client-chosen uuid and a `rev` number.
  - A write is applied only if its `rev` is newer than the stored one, so a request replayed after a lost connection is harmless.
  - Deletions are tombstones (`deleted_at`), not removed rows.
  - A set is tied to an exercise of the **same** session by a composite foreign key.
- **Duplicate handling.** The unique indexes `training_session_links_activity_uq` and `training_session_links_strength_uq` mean one source
  can belong to at most one canonical session, so it cannot be counted twice. Merges never modify or delete the source records.
- **Policies.** Child policies also require that the parent is owned by the same user. The `training_session_links` policy checks that the
  linked activity belongs to the user.
- **Table grants:** revoke all from `public`, `anon` and `authenticated`, then `select, insert, update, delete` to `authenticated`.
  `anon` gets nothing.

**Existing table changed:** `public.activities` gets five nullable columns: `origin`, `origin_device`, `elapsed_s`, `max_hr`, `calories`,
each with a range check. Existing rows are not modified.
- If a column of that name already exists, `add column if not exists` skips it, including its check (P13-3 catches this).

**Functions (5 + 1 trigger function), all SECURITY INVOKER**
- `apply_strength_ops(jsonb)`: saves workouts, exercises and sets in batches. It limits a batch to 200 operations. Each operation runs in
  its own sub-transaction, so one bad operation is reported as `rejected` and does not block the rest.
- `save_strength_routine(jsonb)`, `import_strength_sessions(text, jsonb)` (Hevy only), `merge_training_sources(jsonb, integer, text)`,
  `unmerge_training_session(uuid)`.
- `strength_touch_updated_at()`: trigger function that sets `updated_at`.
- Six touch triggers: custom exercises, routines, sessions, session exercises, sets and wearable devices.

**Extension:** `create extension if not exists pgcrypto` (needs the extension to be creatable in the project).

**Re-running:** safe. Tables and indexes use `if not exists`. Triggers and policies are dropped and re-created by name. Functions use
`create or replace`. Existing data is not changed. The caveat is a same-named table or function that exists with a different shape (P13-4).

**Locks:** an `ACCESS EXCLUSIVE` lock on `activities` while the five nullable columns are added (a small table; the run is one transaction).
Foreign keys to `auth.users` briefly lock it against writes, as with 09 and 12. Use `lock_timeout` as described in the 09–12 document.

---

## 3. Dependencies

### 3.1 Genuine SQL dependencies (the script fails without them)
- `auth.users` and `auth.uid()`;
- `public.activities` with an integer-type `id` (see 1.1) and a `user_id` column;
- the roles `anon` and `authenticated` (and `service_role` exists in every Supabase project);
- the pgcrypto extension (created if missing).

**It references nothing created by 06, 07, 08, 09, 10, 11, 12 or 14.** Migrations 06–12 do **not** need to be applied first, and 13 can be
applied before, after or without any of them, and 12 is not a prerequisite of 13 or the other way round.

### 3.2 Application dependencies
| Strength Hub part | Needs 13? | Behaviour without it |
|---|---|---|
| Live workout (exercises, sets, rest timer) | No | Works from the bundled exercise catalog. The workout is kept **on this device only**. |
| Saving to the server, other devices | **Yes** | The app shows "Saved on this device… not set up (migration 13), so nothing is uploaded". |
| Offline queue and retry | **Yes** (its upload target) | The queue holds changes on the device and cannot deliver them. |
| History list, "last time" values | **Yes** | Empty, or an old cached list. |
| Volume, personal records, analytics | **Yes** | Computed from server history, so empty. |
| Today's strength section | **Yes** | "needs a database update (migration 13)". |
| Hevy import, routines, custom exercises, merging | **Yes** | Not-set-up notice. |
| Workout summary page for a workout not yet uploaded | No (partly) | Opens from the device copy. |
| Intervals activity sync | No | The sync drops the provenance fields until 13 exists, so it keeps working. |

### 3.3 AI features
- **Ask APEX during a workout, and "Evaluate with Ask APEX" on the summary page:**
  - require migration **12**, the server environment variables `SUPABASE_SERVICE_ROLE_KEY` and `GEMINI_API_KEY`, and "Share workout"
    turned on;
  - do not require 13 for the current workout (it is sent in the request); without 13 the strength-history part of the context is
    empty (the Coach treats a missing history as none);
  - return 503 without 12, while logging keeps working.
- **Activity and weekly AI summaries** need 12. They need 13 only to exclude merged duplicates.

### 3.4 Local storage versus server persistence
| | Local (on this browser) | Server (Supabase) |
|---|---|---|
| What | The active workout and the **upload queue** in IndexedDB (localStorage if IndexedDB is unavailable; memory only as a last resort). Also a cached history, routines and custom exercises for offline use. | The `strength_*` tables written by `apply_strength_ops`. |
| When it exists | Immediately, while you log, even offline and **without 13**. | Only after 13 is applied **and** the queue is uploaded. |
| Survives clearing site data | **No** | Yes |
| Seen on another device | No | Yes |
| Counts toward history, volume, PRs, Today | No (the cache only shows "last time" values) | **Yes** |

- If 13 is missing or the upload is failing, everything you log exists only in that browser. Do not clear site data or switch browser
  until the sync indicator shows nothing pending.

---

## 4. Minimum sequence for the gym session

1. **Check the project:** the dashboard URL and project name must be the staging project `ncbceqrulodrdkptnfot`.
2. **Run the pre-checks** (section 5). Save the output.
3. **Apply 13 only**, using the method in `docs/MIGRATION_PREFLIGHT_09_12.md` section 4:
   - run the transaction probe first;
   - paste the unchanged file between `set lock_timeout = '5s';` and `reset lock_timeout;` and run it once.
4. **Run the post-checks** (section 6).
5. **Run the smoke test** (section 8) with a test account and synthetic data.
6. **Only if you want the AI tomorrow**, apply 12 afterwards (pre-checks 5.5 and post-checks 6.4 of the 09–12 document), confirm on staging that
   `SUPABASE_SERVICE_ROLE_KEY` and `GEMINI_API_KEY` are set (names only; never print values), and repeat smoke-test steps 9–10.
   09, 10 and 11 are not needed for gym logging or the AI evaluation.
7. **Session day:** reload, confirm no "not set up" notice, keep the page open and online, check the sync indicator at the end.

If 13 cannot be applied, logging still works but only on that device: do not rely on it for anything you need to keep.

---

## 5. Pre-checks (all READ-ONLY)

```sql
-- P13-1: environment (no SQL: confirm in the dashboard URL that this is ncbceqrulodrdkptnfot, never kklspdchkaunzxnfdmjr)

-- P13-2: roles
select rolname from pg_roles where rolname in ('anon','authenticated','service_role') order by 1;      -- expect 3 rows

-- P13-3 (corrected): activities key and the five new columns
select column_name, udt_name, is_nullable, column_default from information_schema.columns
where table_schema='public' and table_name='activities'
  and column_name in ('id','user_id','origin','origin_device','elapsed_s','max_hr','calories') order by 1;
-- expect: id = int4 OR int8 (either works), user_id = uuid; the five new columns ABSENT on a first run
select a.attname, format_type(a.atttypid, a.atttypmod) as type, i.indisprimary
from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
where i.indrelid = 'public.activities'::regclass and i.indisprimary;
-- expect: the primary key is the single column id (an FK needs a primary key or unique index on the referenced column)

-- P13-4: objects that may already exist (first run: 0 rows each)
select c.relname, c.relkind from pg_class c where c.relnamespace='public'::regnamespace
  and (c.relname like 'strength\_%' or c.relname like 'training\_%' or c.relname = 'wearable_devices') order by 1;
select p.oid::regprocedure from pg_proc p where p.pronamespace='public'::regnamespace
  and p.proname in ('strength_touch_updated_at','save_strength_routine','apply_strength_ops','import_strength_sessions','merge_training_sources','unmerge_training_session');

-- P13-5: baseline to compare afterwards
select count(*) as activities_rows from public.activities;
```

**Stop if:**
- the project is not staging;
- any of the three roles is missing;
- `activities.id` is not `int4` or `int8`, or is not the primary key, or `user_id` is not `uuid`;
- any of the five new columns already exists with a different type (in particular a pre-existing `max_hr` or `elapsed_s`: note its type
  and decide before continuing, and never drop such a column in a rollback);
- any strength, training or wearable table, or any of the six functions, already exists. Compare it with the file before going on.

---

## 6. Post-checks (all READ-ONLY)

```sql
-- Q13-1: 11 new tables, RLS on
select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r'
  and (relname like 'strength\_%' or relname like 'training\_%' or relname='wearable_devices') order by 1;
-- expect 11 rows, all true

-- Q13-2: policies (one owner-only "for all" policy per table)
select tablename, policyname, cmd from pg_policies where schemaname='public'
  and (tablename like 'strength\_%' or tablename like 'training\_%' or tablename='wearable_devices') order by 1;
-- expect 11 rows, cmd = ALL

-- Q13-3: table privileges
select has_table_privilege('anon','public.strength_sets','SELECT') as anon_select,               -- false
       has_table_privilege('anon','public.strength_sets','INSERT') as anon_insert,               -- false
       has_table_privilege('authenticated','public.strength_sets','SELECT') as auth_select,      -- true
       has_table_privilege('authenticated','public.strength_sets','INSERT') as auth_insert;      -- true
select table_name, grantee, privilege_type from information_schema.role_table_grants
where table_schema='public' and grantee in ('PUBLIC','anon')
  and (table_name like 'strength\_%' or table_name like 'training\_%' or table_name='wearable_devices');            -- expect 0 rows

-- Q13-4 (corrected): function EXECUTE for PUBLIC, anon, authenticated, service_role (EXECUTE only, not schema USAGE)
select f.sig,
       has_function_privilege('public',        f.sig, 'EXECUTE') as public_exec,        -- false
       has_function_privilege('anon',          f.sig, 'EXECUTE') as anon_exec,          -- false
       has_function_privilege('authenticated', f.sig, 'EXECUTE') as auth_exec,          -- true
       has_function_privilege('service_role',  f.sig, 'EXECUTE') as service_role_exec   -- expected true (Supabase default privileges; informational)
from (values ('public.save_strength_routine(jsonb)'), ('public.apply_strength_ops(jsonb)'), ('public.import_strength_sessions(text,jsonb)'),
             ('public.merge_training_sources(jsonb,integer,text)'), ('public.unmerge_training_session(uuid)')) f(sig);

-- Q13-4b: the actual permission list, owner, SECURITY INVOKER / DEFINER and search_path
select p.oid::regprocedure as fn, pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer, p.proconfig,
       coalesce((select string_agg(coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type, ', ' order by coalesce(r.rolname, 'PUBLIC'))
                 from aclexplode(p.proacl) a left join pg_roles r on r.oid = a.grantee), '(default: PUBLIC can execute)') as acl
from pg_proc p where p.pronamespace='public'::regnamespace
  and p.proname in ('save_strength_routine','apply_strength_ops','import_strength_sessions','merge_training_sources','unmerge_training_session') order by 1;
-- expect for each of the 5: security_definer = false, proconfig = {search_path=public},
--   acl has authenticated:EXECUTE and the owner (e.g. postgres:EXECUTE), plus service_role:EXECUTE if Supabase's defaults apply;
--   NO anon entry and NO PUBLIC entry. "(default: PUBLIC can execute)" would mean the revoke did not run: STOP.

-- Q13-5: indexes that enforce no double counting, and triggers
select indexname from pg_indexes where schemaname='public' and indexname in
 ('training_session_links_activity_uq','training_session_links_strength_uq','training_session_links_one_primary','strength_sessions_source_uq') order by 1;   -- 4 rows
select count(*) as touch_triggers from pg_trigger t where not t.tgisinternal and t.tgname in
 ('strength_custom_exercises_touch','strength_routines_touch','strength_sessions_touch','strength_session_exercises_touch','strength_sets_touch','wearable_devices_touch');   -- 6

-- Q13-6: activities untouched
select count(*) as activities_rows, count(*) filter (where origin is not null) as with_origin from public.activities;    -- same count as P13-5; with_origin = 0
select column_name, udt_name from information_schema.columns where table_schema='public' and table_name='activities'
  and column_name in ('origin','origin_device','elapsed_s','max_hr','calories') order by 1;                               -- 5 rows
```

**Stop if:**
- Q13-1 or Q13-2 does not return 11 rows;
- `anon` or PUBLIC can execute any of the five functions, or `anon` has any table privilege (Q13-3 and Q13-4);
- `authenticated` cannot execute a function or cannot read or write `strength_sets`;
- any function is SECURITY DEFINER or has no `search_path` setting;
- the activities row count changed, or any `origin` is not null.

---

## 7. Stop conditions and recovery

**Stop conditions overall**
- the SQL Editor is not on the staging project;
- the transaction probe from the 09–12 document returns `false`;
- any pre-check or post-check stop condition above;
- the migration run reports any error, including a lock timeout. The whole run is rolled back, so investigate before retrying.

**Recovery**
- Since the migration runs as one transaction, a failed run leaves nothing behind.
- A migration that applied but should be withdrawn can be rolled back as below. Run it in a single SQL Editor execution.
- **IRREVERSIBLE:** dropping the tables permanently deletes everything stored in them: every workout, set, routine, custom exercise,
  import and merge decision. Only a backup can restore it. Take one first if the tables hold anything you want to keep: the Table Editor
  CSV export per table, or a dump run by you:
  ```bash
  pg_dump "$STAGING_DB_URL" --data-only --table='public.strength_*' --table='public.training_*' --table=public.wearable_devices > pre_rollback_strength_data.sql
  ```
  Store the file privately and delete it afterwards.
- Anything you logged only on the device (not yet uploaded) is not in the database, so it is not affected by dropping tables.

```sql
-- R13 rollback draft. Do not run unless 13 must be withdrawn.
drop function if exists public.save_strength_routine(jsonb);
drop function if exists public.apply_strength_ops(jsonb);
drop function if exists public.import_strength_sessions(text, jsonb);
drop function if exists public.merge_training_sources(jsonb, integer, text);
drop function if exists public.unmerge_training_session(uuid);
drop table if exists public.training_merge_decisions, public.training_session_links, public.training_sessions,
  public.strength_sets, public.strength_session_exercises, public.strength_sessions,
  public.strength_routine_sets, public.strength_routine_exercises, public.strength_routines,
  public.strength_custom_exercises, public.wearable_devices;
drop function if exists public.strength_touch_updated_at();
-- Only if P13-3 showed that ALL FIVE columns were absent before the migration (otherwise drop only the ones 13 created):
alter table public.activities drop column if exists origin, drop column if exists origin_device, drop column if exists elapsed_s,
  drop column if exists max_hr, drop column if exists calories;
```
- After a rollback, the app goes back to "device only" storage with the not-set-up notice. Workouts already uploaded are gone.
- Dropping the `activities` columns deletes any provenance data written since the migration.

---

## 8. Smoke test (synthetic data, test account on staging)

Use a dedicated test account, never your real training account. Everything below is synthetic.

1. **Create:** Strength → start an empty workout and name it `TEST - APEX smoke`.
2. **Two exercises:** add a barbell exercise (e.g. bench press) and a cable or machine exercise (e.g. seated cable row), whose weight is
   entered as a single "Weight". Avoid dumbbell exercises for this check: their weight is "Per hand" and the volume counts **both**
   implements, which would double the figures in step 4.
3. **Sets**
   - Exercise 1: one warm-up 40 kg × 10, then working sets 60 × 8, 60 × 8, 60 × 6.
   - Exercise 2: working sets 30 × 12, 30 × 12, 30 × 12.
   - Mark each set complete.
4. **Expected figures, worked out before looking at the app**
   - Working-set volume = (60×8) + (60×8) + (60×6) + 3×(30×12) = 480 + 480 + 360 + 1080 = **2400 kg**. The warm-up does not count.
   - Working sets = **6**, working reps = 8+8+6+12+12+12 = **58**.
   - Each exercise shows a first record, since there is no earlier history. The warm-up is not a PR.
5. **Live persistence:** reload mid-workout. The active workout and its sets come back (device storage).
6. **Save and refresh:** finish the workout, then reload. The summary shows the same sets, volume and duration.
   The sync indicator (since Task 8E) reads "On device · waiting to upload (N)" while changes are queued, "On device only · server not
   set up" while migration 13 is missing, "Upload failed · N changes need attention" (with a Retry button) if the server rejects
   changes, and only "Saved to server" once the server has confirmed them. It must end on "Saved to server".
7. **Server persistence:** open the same account in another browser or a private window. The workout appears in History with the same
   figures. **This is the proof that it reached the server, and not only this browser.**
8. **Today and history:** Today's strength card shows exactly one finished workout with 6 working sets; History lists it once and its
   page opens with the same numbers.
9. **Ask APEX with permission on** (needs migration 12): on the workout summary page tick "Share workout", then "Evaluate with Ask APEX".
   A short evaluation arrives, based only on the logged data.
10. **Permission off:** untick "Share workout".
    - The Evaluate button is disabled.
    - In Ask APEX the answer is general guidance only.
    - In the browser's network panel, no `/api/coach` request is sent while the button is disabled, and none contains workout data.
    - Note: ticking it again and reloading should bring back the same choice for this account only (a second account sees it unticked).
11. **No duplicates or double counting:**
    - the workout appears once in History and once in Today;
    - reloading or retrying the sync does not add a second copy (retries are idempotent);
    - the volume, set count and PR figures stay at the values from step 4 after several reloads;
    - it does not also appear in Activities unless you imported one.
12. **Cleanup** (below).

### Cleanup procedure
1. In the app: open the workout summary page → Delete → confirm both prompts. It disappears from History and Today.
2. **Soft delete.** The app marks the workout as deleted (a tombstone) rather than removing its rows. They stay in the tables on the
   server, excluded from every view. If you want them physically removed, run this **writing** statement (optional), with the **test**
   account's id:
   ```sql
   -- WRITES. First check the match, with the test user's uuid:
   select id, title, started_at, deleted_at from public.strength_sessions where user_id = '<test-user-uuid>' and title like 'TEST - APEX smoke%';
   -- then, only if exactly the expected rows appear (exercises and sets are removed by cascade):
   delete from public.strength_sessions where user_id = '<test-user-uuid>' and title like 'TEST - APEX smoke%';
   ```
3. Verify nothing is left (READ-ONLY):
   ```sql
   select count(*) from public.strength_sessions where user_id = '<test-user-uuid>' and title like 'TEST - APEX smoke%';   -- 0 after the delete
   ```
4. Wait until the sync indicator shows nothing pending, **then** (only if you want to) clear this browser's stored data for the site.
   Clearing it earlier would lose changes that are not uploaded yet.
5. The AI usage rows (`coach_usage`) from the test are rate-limit records only and expire by themselves after 35 days. They hold no workout data.

---

## 9. Remaining notes
- Staging's current state is unknown. If the strength tables already exist, run the post-checks first before relying on them.
- The browser steps of the smoke test need a signed-in staging session and have not been run.
- The AI steps share the Coach's hourly limit (30 requests per hour by default).
