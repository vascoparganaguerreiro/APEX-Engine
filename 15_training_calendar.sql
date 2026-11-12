-- 15: APEX Training Calendar (Phase 1): planned workouts, with optional links to the completed record that fulfilled them.
-- STAGING FIRST. Apply after 13 (planned order 13 -> 15; 14 is independent).
--
-- Dependencies:
--   * Base schema: auth.users, public.activities (id bigint, user_id).
--   * 13_strength.sql: public.strength_routines and public.strength_sessions (foreign keys).
--   * It does NOT touch, alter or read any other object. Races are NOT copied here: the calendar reads public.races directly.
-- Additive and idempotent: one new table, one trigger function, indexes, RLS. No existing row, column or policy is changed.
-- The app works without this file: /training shows a "not set up" notice and Today's five-day strip behaves exactly as before.
--
-- Design notes (see docs/MIGRATION_PREFLIGHT_15.md):
--   * Planned data is its own table. It never feeds activities, daily_metrics or any CTL/ATL/TSB input.
--   * A plan is linked to what was actually done with two nullable foreign keys. Each completed record can be linked to AT MOST ONE plan
--     (partial unique indexes), a plan has at most one completion source, and the source kind must match the plan kind. The existing
--     training_session_links table is deliberately NOT reused: it merges two real sessions and needs a training_sessions parent.
--   * "structure" holds future structured workouts (warm-up, intervals, recovery, cool-down) as a JSON array of steps. The MVP form
--     does not write it; imports and a later editor can, without a schema change. Step shape (validated by the app):
--       {"type":"warmup|work|recovery|cooldown|steady","duration_s":int?,"distance_m":num?,"repeat":int?,"target":"text"?,"notes":"text"?}
--   * source / source_ref / import_batch_id let future imports be idempotent and reversible (delete by batch) without a redesign.
--
-- Wrap in a transaction when pasting into the SQL Editor:  begin;  <this file>  commit;

create or replace function public.planned_workouts_touch() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;

create table if not exists public.planned_workouts (
  id                            uuid primary key default gen_random_uuid(),
  user_id                       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  planned_date                  date not null,
  kind                          text not null check (kind in ('endurance','strength','rest','milestone')),
  sport                         text check (sport is null or char_length(sport) between 1 and 20),
  title                         text not null check (char_length(btrim(title)) between 1 and 120),
  duration_min                  integer check (duration_min is null or duration_min between 1 and 1440),
  distance_m                    numeric check (distance_m is null or (distance_m > 0 and distance_m <= 1000000)),
  intensity                     text check (intensity is null or char_length(intensity) <= 200),      -- free text target, e.g. "easy, Z2" or "RPE 7"
  routine_id                    uuid references public.strength_routines(id) on delete set null,       -- optional template for strength plans
  structure                     jsonb check (structure is null or (jsonb_typeof(structure) = 'array' and jsonb_array_length(structure) <= 100)),
  notes                         text check (notes is null or char_length(notes) <= 2000),
  status                        text not null default 'planned' check (status in ('planned','completed','skipped')),
  completed_at                  timestamptz,
  completed_activity_id         bigint references public.activities(id) on delete set null,
  completed_strength_session_id uuid references public.strength_sessions(id) on delete set null,
  link_origin                   text check (link_origin is null or link_origin in ('manual','confirmed_match')),   -- informational: how the link was made
  source                        text not null default 'manual' check (source in ('manual','import','intervals','ics')),
  source_ref                    text check (source_ref is null or char_length(source_ref) <= 200),
  import_batch_id               uuid,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  -- a rest day or milestone is never "fulfilled by" a recorded session
  constraint planned_workouts_link_kind check (
    (completed_activity_id is null or kind = 'endurance') and (completed_strength_session_id is null or kind = 'strength')),
  -- at most one completion source per plan
  constraint planned_workouts_one_source check (completed_activity_id is null or completed_strength_session_id is null),
  -- a link only exists on a completed plan (a plan marked done by hand simply has no link)
  constraint planned_workouts_link_status check ((completed_activity_id is null and completed_strength_session_id is null) or status = 'completed')
  -- RULE: no check constraint may require a completed_* column to be NON-null (or tie another column to it). Both are "on delete set null":
  -- when the linked activity / strength session is deleted (admin cleanup, auth.users cascade), Postgres runs an UPDATE that nulls the
  -- id, and every check is evaluated on that row. A rule such as "link_origin is set => an id is set" would then fail and BLOCK the
  -- delete of the activity or session. The constraints above only ever pass when the ids are null, so they are safe. link_origin is
  -- informational; the app keeps it consistent.
);

drop trigger if exists planned_workouts_touch on public.planned_workouts;
create trigger planned_workouts_touch before update on public.planned_workouts for each row execute function public.planned_workouts_touch();

-- A completed record can be linked to at most ONE plan: no double counting, no duplicate association.
create unique index if not exists planned_workouts_activity_uq on public.planned_workouts (completed_activity_id) where completed_activity_id is not null;
create unique index if not exists planned_workouts_strength_uq on public.planned_workouts (completed_strength_session_id) where completed_strength_session_id is not null;
-- Imports are idempotent: the same external item cannot be stored twice for a user.
create unique index if not exists planned_workouts_source_uq on public.planned_workouts (user_id, source, source_ref) where source_ref is not null;
create index if not exists planned_workouts_user_date_idx on public.planned_workouts (user_id, planned_date);
create index if not exists planned_workouts_routine_idx on public.planned_workouts (routine_id) where routine_id is not null;
create index if not exists planned_workouts_batch_idx on public.planned_workouts (import_batch_id) where import_batch_id is not null;

alter table public.planned_workouts enable row level security;

drop policy if exists "own planned workouts" on public.planned_workouts;
create policy "own planned workouts" on public.planned_workouts for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
    and (routine_id is null or exists (select 1 from public.strength_routines r where r.id = routine_id and r.user_id = (select auth.uid())))
    and (completed_activity_id is null or exists (select 1 from public.activities a where a.id = completed_activity_id and a.user_id = (select auth.uid())))
    and (completed_strength_session_id is null or exists (select 1 from public.strength_sessions s where s.id = completed_strength_session_id and s.user_id = (select auth.uid()))));

revoke all on public.planned_workouts from public, anon, authenticated;
grant select, insert, update, delete on public.planned_workouts to authenticated;
