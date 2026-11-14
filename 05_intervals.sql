-- 05: Intervals.icu import. Run once in the Supabase SQL Editor, after the base schema (00_base_schema.sql on a NEW
-- database; production already has its base). Safe to re-run, non-destructive: it only adds what is missing and
-- never changes, deletes or drops existing data, columns or indexes.

-- 1) The sync (app/api/intervals/sync/route.ts) upserts with onConflict "user_id,source,external_id".
--    Postgres needs a non-partial unique index/constraint on exactly those three columns (in any order) for that.
alter table public.activities add column if not exists source text;
alter table public.activities add column if not exists external_id text;

-- Production already has such a key (under a name this repo does not know), so look for ANY valid, non-partial,
-- non-expression unique index on exactly {user_id, source, external_id} and create one only when none exists.
-- If this fails on an existing database, duplicate (user_id, source, external_id) rows exist: resolve them by hand.
do $$
begin
  if not exists (
    select 1
    from pg_index i
    where i.indrelid = 'public.activities'::regclass
      and i.indisunique and i.indisvalid
      and i.indpred is null and i.indexprs is null
      and i.indnatts = 3 and i.indnkeyatts = 3
      and (select array_agg(a.attname::text order by a.attname::text)
           from unnest(i.indkey::int2[]) as k(attnum)
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
          = array['external_id', 'source', 'user_id']
  ) then
    create unique index activities_user_source_external_idx on public.activities (user_id, source, external_id);
  end if;
end $$;

-- About the OLD unique index activities_user_external_idx on (user_id, external_id), which earlier versions of this
-- file created: it is no longer created here, and it is deliberately NOT dropped either.
--  * Why not create it: the code never uses it as a conflict target, and it is stricter than the real key. With it in
--    place, an Intervals row whose external_id equals the external_id of another source's row for the same user
--    (e.g. an activity Intervals.icu mirrored from Strava keeps the Strava id) makes the sync's upsert fail with a
--    unique violation instead of inserting/updating.
--  * Why not drop it here: this database is shared with the older Streamlit app, which may rely on it (for example as
--    an ON CONFLICT (user_id, external_id) target, which would start failing without it). Dropping a constraint on
--    production is a decision to take deliberately, not a side effect of a re-runnable migration.
-- If it exists and you have checked the Streamlit app does not use it, drop it manually:
--   select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'activities';
--   drop index if exists public.activities_user_external_idx;

-- 2) intervals_connections holds the API key: make sure only the owner can touch it.
--    Superseded by 07_intervals_key_security.sql, which removes this policy and makes the table read-only for
--    browsers. So once 07 has run (intervals_credentials exists), re-running 05 leaves the policies alone.
alter table public.intervals_connections enable row level security;
do $$
begin
  if to_regclass('public.intervals_credentials') is null then
    drop policy if exists "own connection" on public.intervals_connections;
    create policy "own connection" on public.intervals_connections
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;
