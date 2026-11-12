# Migration preflight: 15 Training Calendar (STAGING ONLY)

Status: preparation only. Nothing here has been executed; no SQL was run against any database.

- Target: the **staging** Supabase project `ncbceqrulodrdkptnfot` only. Never production (`kklspdchkaunzxnfdmjr`).
- The migration file `15_training_calendar.sql` is pasted as it is. Wrap it: `begin;  <file>  commit;`.
- Queries marked READ-ONLY change nothing.

## 1. What it does

Creates one table, `public.planned_workouts`, one trigger function `planned_workouts_touch()`, 6 indexes (3 unique, partial), RLS with one
owner-only policy, and grants for `authenticated`. **No existing table, column, row or policy is altered.** Idempotent (`if not exists`,
`drop ... if exists`), so re-running is safe.

| Rule | Enforced by |
|---|---|
| A user only sees/writes their own plans | RLS `own planned workouts` (`user_id = auth.uid()`), `user_id` defaults to `auth.uid()` |
| A plan can only point at the user's own routine / activity / strength session | `with check` sub-selects in the policy |
| One completed activity or strength session links to at most one plan | unique partial indexes `planned_workouts_activity_uq`, `planned_workouts_strength_uq` |
| A plan has at most one completion source; kind must match (endurance -> activity, strength -> strength session); links only on `completed` plans | check constraints |
| Rest days / milestones are never "fulfilled" by a recorded session | `planned_workouts_link_kind` |
| Future imports are idempotent and reversible | unique `(user_id, source, source_ref)`; `import_batch_id` |

The existing `training_session_links` table is deliberately not reused (it merges two real sessions and requires a `training_sessions`
parent; its check allows only activity or strength as sources).

## 2. Preflight (READ-ONLY, run on staging first)

```sql
-- a) required tables exist (expect 3 rows: activities, strength_routines, strength_sessions)
select table_name from information_schema.tables
 where table_schema = 'public' and table_name in ('activities','strength_routines','strength_sessions');

-- b) activities.id is bigint and has user_id; strength_sessions.id is uuid (expect bigint / uuid)
select table_name, column_name, data_type from information_schema.columns
 where table_schema = 'public'
   and ((table_name = 'activities' and column_name in ('id','user_id')) or (table_name = 'strength_sessions' and column_name in ('id','user_id')));

-- c) nothing named planned_workouts exists yet (expect 0 rows; if 1 row, STOP and inspect before running)
select table_name from information_schema.tables where table_schema = 'public' and table_name = 'planned_workouts';

-- d) gen_random_uuid() is available (expect a uuid)
select gen_random_uuid();
```

If (a) does not return all three tables, apply 13 first. Take a Supabase backup/snapshot point before applying (the change is additive, but
this is the project rule for staging migrations).

## 3. Apply

SQL Editor on **staging**: `begin;` + contents of `15_training_calendar.sql` + `commit;`. Locks: a brief `SHARE ROW EXCLUSIVE` on
`auth.users`, `activities`, `strength_routines` and `strength_sessions` while foreign keys are added to the new (empty) table.

## 4. Verify (READ-ONLY)

```sql
select policyname, cmd from pg_policies where tablename = 'planned_workouts';            -- one policy, cmd = ALL
select indexname from pg_indexes where tablename = 'planned_workouts' order by 1;        -- 6 indexes + the primary key
select grantee, privilege_type from information_schema.role_table_grants
 where table_name = 'planned_workouts' and grantee in ('anon','authenticated','public'); -- authenticated only (4 privileges)
```

Then, signed in as a staging test user in the app: open `/training`, add a plan, edit it, mark it done, skip another, link a completed
session and delete a plan. With a second test user, confirm the first user's plans are not visible.

## 5. Rollback

The table is new and nothing else references it, so rollback loses only calendar data entered since:

```sql
begin;
drop table if exists public.planned_workouts;          -- drops its trigger, indexes and policy
drop function if exists public.planned_workouts_touch();
commit;
```

Before dropping, optionally keep the data: `create table public.planned_workouts_backup as select * from public.planned_workouts;`.
After rollback the app returns to its "not set up" state for the calendar; every other module is unaffected.

## 6. Application behaviour without 15

`/training` shows the standard "not set up" notice (decided only from Postgres/PostgREST codes `42P01`, `PGRST202`, `PGRST205`), still
lists races, and offers no create/edit actions. Today's five-day strip omits planned sessions and is otherwise unchanged.
