-- 13: Strength Hub, canonical training sessions (Garmin / Hevy / Intervals duplicate merging) and wearable device settings.
-- NOT applied automatically: review, then run once in the Supabase SQL Editor (staging first).
--
-- ORDER AND DEPENDENCIES
--   * Needs only the base schema (auth.users, public.activities) and pgcrypto. It does NOT reference any object created by 09, 10, 11 or 12,
--     so it can be applied after 12 as planned, or before them without failing.
--   * The app's "Ask APEX" gym assistant reuses the Coach tables and limiter from 12_coach.sql at runtime. Until 12 is applied the assistant
--     answers 503 while workout logging keeps working.
--   * Additive and idempotent: no existing table, column, row, policy or grant is changed or removed. On public.activities only new,
--     nullable provenance columns are added; existing activity data is never modified.
--
-- PRIVACY: every user-owned row is protected by row level security (owner only). Child rows must point at a parent owned by the same user.
-- The global exercise catalog is bundled with the app (no table), so nothing here is shared between users.

create extension if not exists pgcrypto;

create or replace function public.strength_touch_updated_at() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;

-- ================================================================== custom exercises
create table if not exists public.strength_custom_exercises (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name              text not null check (char_length(btrim(name)) between 1 and 80),
  aliases           text[] not null default '{}' check (cardinality(aliases) <= 8),
  primary_muscles   text[] not null check (cardinality(primary_muscles) between 1 and 4 and primary_muscles <@ array['chest','upper_back','lats','shoulders','biceps','triceps','forearms','quadriceps','hamstrings','glutes','calves','abdominals','obliques','lower_back','full_body']::text[]),
  secondary_muscles text[] not null default '{}' check (cardinality(secondary_muscles) <= 6 and secondary_muscles <@ array['chest','upper_back','lats','shoulders','biceps','triceps','forearms','quadriceps','hamstrings','glutes','calves','abdominals','obliques','lower_back','full_body']::text[]),
  equipment         text not null check (equipment in ('barbell','dumbbell','cable','machine','smith_machine','kettlebell','band','bodyweight','other')),
  pattern           text not null check (pattern in ('horizontal_push','vertical_push','horizontal_pull','vertical_pull','squat','hinge','lunge','isolation_upper','isolation_lower','core','carry','conditioning','olympic')),
  category          text not null check (category in ('compound','isolation','core','cardio','plyometric','mobility','olympic')),
  measurement       text not null check (measurement in ('weight_reps','bodyweight_reps','weighted_bodyweight','assisted_bodyweight','duration','weight_duration','distance_duration','weight_distance')),
  load_mode         text not null default 'total' check (load_mode in ('total','per_hand','added','assisted','none')),
  unilateral        boolean not null default false,
  instructions      text check (char_length(instructions) <= 2000),
  notes             text check (char_length(notes) <= 500),
  archived_at       timestamptz,                         -- custom exercises with history are archived, never deleted (see "on delete restrict" below)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists strength_custom_exercises_name_uq on public.strength_custom_exercises (user_id, lower(btrim(name))) where archived_at is null;
drop trigger if exists strength_custom_exercises_touch on public.strength_custom_exercises;
create trigger strength_custom_exercises_touch before update on public.strength_custom_exercises for each row execute function public.strength_touch_updated_at();

-- ================================================================== routines (reusable templates)
create table if not exists public.strength_routines (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 1 and 80),
  notes        text check (char_length(notes) <= 2000),
  template_key text check (template_key ~ '^[a-z_]{1,40}$'),     -- which built-in template it was started from, if any
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists strength_routines_user_idx on public.strength_routines (user_id, updated_at desc);
drop trigger if exists strength_routines_touch on public.strength_routines;
create trigger strength_routines_touch before update on public.strength_routines for each row execute function public.strength_touch_updated_at();

create table if not exists public.strength_routine_exercises (
  id                 uuid primary key default gen_random_uuid(),
  routine_id         uuid not null references public.strength_routines(id) on delete cascade,
  user_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  position           smallint not null check (position between 0 and 99),
  exercise_key       text check (exercise_key ~ '^[a-z0-9_]{2,60}$'),
  custom_exercise_id uuid references public.strength_custom_exercises(id) on delete restrict,
  superset_group     smallint check (superset_group between 1 and 20),
  rest_seconds       smallint check (rest_seconds between 0 and 1800),
  load_mode          text check (load_mode in ('total','per_hand','added','assisted','none')),
  weight_unit        text not null default 'kg' check (weight_unit in ('kg','lb')),
  notes              text check (char_length(notes) <= 500),
  substitutes        text[] not null default '{}' check (cardinality(substitutes) <= 6),   -- alternative exercise keys the user prepared
  constraint strength_routine_exercises_one_ref check ((exercise_key is null) <> (custom_exercise_id is null)),
  constraint strength_routine_exercises_pos_uq unique (routine_id, position)
);
create index if not exists strength_routine_exercises_routine_idx on public.strength_routine_exercises (routine_id, position);

create table if not exists public.strength_routine_sets (
  id                  uuid primary key default gen_random_uuid(),
  routine_exercise_id uuid not null references public.strength_routine_exercises(id) on delete cascade,
  user_id             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  position            smallint not null check (position between 0 and 49),
  set_type            text not null default 'working' check (set_type in ('warmup','working','drop','failure','backoff')),
  reps_min            smallint check (reps_min between 0 and 1000),
  reps_max            smallint check (reps_max between 0 and 1000),
  target_weight       numeric(7,2) check (target_weight >= 0 and target_weight <= 2000),
  target_rpe          numeric(3,1) check (target_rpe between 1 and 10 and target_rpe * 2 = trunc(target_rpe * 2)),
  target_rir          smallint check (target_rir between 0 and 10),
  target_duration_s   integer check (target_duration_s between 1 and 86400),
  target_distance_m   numeric(9,2) check (target_distance_m > 0 and target_distance_m <= 1000000),
  constraint strength_routine_sets_reps_ok check (reps_min is null or reps_max is null or reps_min <= reps_max),
  constraint strength_routine_sets_pos_uq unique (routine_exercise_id, position)
);

-- ================================================================== logged workouts
-- Sessions, session exercises and sets are created on the device with their own UUID (the idempotency key) and a monotonically
-- increasing "rev". Writes go through apply_strength_ops(), which only accepts a row version newer than the stored one, so a request
-- replayed after a lost connection is harmless and can never create a duplicate. Deletions are tombstones (deleted_at) so that an old,
-- delayed write cannot bring a deleted set back.
create table if not exists public.strength_sessions (
  id               uuid primary key,
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  routine_id       uuid references public.strength_routines(id) on delete set null,
  title            text not null check (char_length(btrim(title)) between 1 and 120),
  status           text not null default 'active' check (status in ('active','completed')),
  started_at       timestamptz not null,
  ended_at         timestamptz,
  paused_at        timestamptz,
  paused_seconds   integer not null default 0 check (paused_seconds >= 0 and paused_seconds <= 604800),
  timezone         text check (char_length(timezone) <= 64),
  notes            text check (char_length(notes) <= 4000),
  perceived_effort smallint check (perceived_effort between 1 and 10),
  source           text not null default 'apex' check (source in ('apex','hevy_csv')),
  source_ref       text check (char_length(source_ref) <= 200),        -- stable fingerprint of the imported workout (repeated imports are no-ops)
  rev              bigint not null default 0,
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint strength_sessions_end_ok check (ended_at is null or ended_at >= started_at),
  constraint strength_sessions_completed_has_end check (status <> 'completed' or ended_at is not null),
  constraint strength_sessions_import_has_ref check (source = 'apex' or source_ref is not null)
);
create unique index if not exists strength_sessions_source_uq on public.strength_sessions (user_id, source, source_ref) where source_ref is not null;
create index if not exists strength_sessions_user_time_idx on public.strength_sessions (user_id, started_at desc) where deleted_at is null;
drop trigger if exists strength_sessions_touch on public.strength_sessions;
create trigger strength_sessions_touch before update on public.strength_sessions for each row execute function public.strength_touch_updated_at();

create table if not exists public.strength_session_exercises (
  id                 uuid primary key,
  session_id         uuid not null references public.strength_sessions(id) on delete cascade,
  user_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  position           smallint not null check (position between 0 and 199),
  exercise_key       text check (exercise_key ~ '^[a-z0-9_]{2,60}$'),
  custom_exercise_id uuid references public.strength_custom_exercises(id) on delete restrict,
  exercise_name      text not null check (char_length(btrim(exercise_name)) between 1 and 120),   -- the name at logging time (imports keep the original name)
  superset_group     smallint check (superset_group between 1 and 20),
  rest_seconds       smallint check (rest_seconds between 0 and 1800),
  load_mode          text not null default 'total' check (load_mode in ('total','per_hand','added','assisted','none')),
  weight_unit        text not null default 'kg' check (weight_unit in ('kg','lb')),
  notes              text check (char_length(notes) <= 1000),
  rev                bigint not null default 0,
  deleted_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- an unmatched imported exercise may have neither key (it is kept by name only), but never both
  constraint strength_session_exercises_ref_ok check (exercise_key is null or custom_exercise_id is null),
  constraint strength_session_exercises_id_session_uq unique (id, session_id)
);
create index if not exists strength_session_exercises_session_idx on public.strength_session_exercises (session_id, position);
create index if not exists strength_session_exercises_key_idx on public.strength_session_exercises (user_id, exercise_key) where deleted_at is null;
drop trigger if exists strength_session_exercises_touch on public.strength_session_exercises;
create trigger strength_session_exercises_touch before update on public.strength_session_exercises for each row execute function public.strength_touch_updated_at();

create table if not exists public.strength_sets (
  id                  uuid primary key,
  session_exercise_id uuid not null,
  session_id          uuid not null references public.strength_sessions(id) on delete cascade,
  user_id             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  position            smallint not null check (position between 0 and 99),
  set_type            text not null default 'working' check (set_type in ('warmup','working','drop','failure','backoff')),
  weight              numeric(7,2) check (weight >= 0 and weight <= 2000),          -- as entered, in weight_unit (never silently converted)
  weight_unit         text not null default 'kg' check (weight_unit in ('kg','lb')),
  reps                smallint check (reps between 0 and 1000),
  duration_s          integer check (duration_s between 0 and 86400),
  distance_m          numeric(9,2) check (distance_m >= 0 and distance_m <= 1000000),
  rpe                 numeric(3,1) check (rpe between 1 and 10 and rpe * 2 = trunc(rpe * 2)),
  rir                 smallint check (rir between 0 and 10),
  side                text check (side in ('left','right')),
  completed           boolean not null default false,
  completed_at        timestamptz,
  notes               text check (char_length(notes) <= 500),
  rev                 bigint not null default 0,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- a set always belongs to an exercise of the SAME session
  constraint strength_sets_exercise_fk foreign key (session_exercise_id, session_id) references public.strength_session_exercises (id, session_id) on delete cascade
);
create index if not exists strength_sets_exercise_idx on public.strength_sets (session_exercise_id, position);
create index if not exists strength_sets_session_idx on public.strength_sets (session_id);
drop trigger if exists strength_sets_touch on public.strength_sets;
create trigger strength_sets_touch before update on public.strength_sets for each row execute function public.strength_touch_updated_at();

-- ================================================================== canonical training sessions (duplicate resolution)
-- Source records (activities from Intervals.icu/Garmin/Strava, strength sessions logged in APEX or imported from Hevy) are NEVER
-- modified or deleted by a merge. A merge creates one canonical training_sessions row and links each source to it.
create table if not exists public.training_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  primary_kind text not null check (primary_kind in ('activity','strength')),
  title        text check (char_length(title) <= 120),
  sport        text check (char_length(sport) <= 20),
  started_at   timestamptz not null,
  ended_at     timestamptz,
  created_at   timestamptz not null default now(),
  constraint training_sessions_end_ok check (ended_at is null or ended_at >= started_at)
);
create index if not exists training_sessions_user_idx on public.training_sessions (user_id, started_at desc);

create table if not exists public.training_session_links (
  id                  uuid primary key default gen_random_uuid(),
  training_session_id uuid not null references public.training_sessions(id) on delete cascade,
  user_id             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  activity_id         bigint references public.activities(id) on delete cascade,
  strength_session_id uuid references public.strength_sessions(id) on delete cascade,
  role                text not null check (role in ('primary','secondary')),
  created_at          timestamptz not null default now(),
  constraint training_session_links_one_source check ((activity_id is null) <> (strength_session_id is null))
);
-- A source record can belong to at most ONE canonical session, so it can never be counted twice by mistake.
create unique index if not exists training_session_links_activity_uq on public.training_session_links (activity_id) where activity_id is not null;
create unique index if not exists training_session_links_strength_uq on public.training_session_links (strength_session_id) where strength_session_id is not null;
create unique index if not exists training_session_links_one_primary on public.training_session_links (training_session_id) where role = 'primary';
create index if not exists training_session_links_session_idx on public.training_session_links (training_session_id);

-- Every decision (merge or keep separate) is recorded and can be reverted later; reverted rows stay as history.
create table if not exists public.training_merge_decisions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  pair_key            text not null check (char_length(pair_key) between 3 and 200),
  decision            text not null check (decision in ('merged','separate')),
  training_session_id uuid references public.training_sessions(id) on delete set null,
  primary_kind        text check (primary_kind in ('activity','strength')),
  confidence          text check (confidence in ('high','medium','low')),
  created_at          timestamptz not null default now(),
  reverted_at         timestamptz
);
create unique index if not exists training_merge_decisions_open_uq on public.training_merge_decisions (user_id, pair_key) where reverted_at is null;

-- ================================================================== supporting indexes
-- Foreign keys with ON DELETE SET NULL / RESTRICT need an index on the referencing column, otherwise deleting a routine, a custom
-- exercise or a canonical session scans the whole child table. user_id indexes keep the owner-only RLS filters cheap.
create index if not exists strength_sessions_routine_idx on public.strength_sessions (routine_id) where routine_id is not null;
create index if not exists strength_routine_exercises_custom_idx on public.strength_routine_exercises (custom_exercise_id) where custom_exercise_id is not null;
create index if not exists strength_session_exercises_custom_idx on public.strength_session_exercises (custom_exercise_id) where custom_exercise_id is not null;
create index if not exists strength_routine_exercises_user_idx on public.strength_routine_exercises (user_id);
create index if not exists training_session_links_user_idx on public.training_session_links (user_id);
create index if not exists training_merge_decisions_session_idx on public.training_merge_decisions (training_session_id) where training_session_id is not null;

-- ================================================================== wearable device settings and activity provenance
create table if not exists public.wearable_devices (
  user_id          uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  model            text not null default 'forerunner_965' check (model in ('forerunner_965','other_garmin','other')),
  last_export_at   timestamptz,
  last_export_kind text check (last_export_kind in ('fit','ics','json')),
  last_export_note text check (char_length(last_export_note) <= 300),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
drop trigger if exists wearable_devices_touch on public.wearable_devices;
create trigger wearable_devices_touch before update on public.wearable_devices for each row execute function public.strength_touch_updated_at();

-- Where an imported activity originally came from (e.g. GARMIN_CONNECT or STRAVA as reported by Intervals.icu), plus measurements the
-- watch recorded. Nullable and only filled by future syncs: existing activities are not touched.
alter table public.activities
  add column if not exists origin        text check (origin is null or char_length(origin) <= 40),
  add column if not exists origin_device text check (origin_device is null or char_length(origin_device) <= 80),
  add column if not exists elapsed_s     integer check (elapsed_s is null or (elapsed_s >= 0 and elapsed_s <= 2592000)),
  add column if not exists max_hr        integer check (max_hr is null or (max_hr between 30 and 250)),
  add column if not exists calories      integer check (calories is null or (calories between 0 and 30000));

-- ================================================================== row level security
alter table public.strength_custom_exercises  enable row level security;
alter table public.strength_routines          enable row level security;
alter table public.strength_routine_exercises enable row level security;
alter table public.strength_routine_sets      enable row level security;
alter table public.strength_sessions          enable row level security;
alter table public.strength_session_exercises enable row level security;
alter table public.strength_sets              enable row level security;
alter table public.training_sessions          enable row level security;
alter table public.training_session_links     enable row level security;
alter table public.training_merge_decisions   enable row level security;
alter table public.wearable_devices           enable row level security;

drop policy if exists "own custom exercises" on public.strength_custom_exercises;
create policy "own custom exercises" on public.strength_custom_exercises for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own routines" on public.strength_routines;
create policy "own routines" on public.strength_routines for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own routine exercises" on public.strength_routine_exercises;
create policy "own routine exercises" on public.strength_routine_exercises for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
    and exists (select 1 from public.strength_routines r where r.id = routine_id and r.user_id = (select auth.uid()))
    and (custom_exercise_id is null or exists (select 1 from public.strength_custom_exercises c where c.id = custom_exercise_id and c.user_id = (select auth.uid()))));

drop policy if exists "own routine sets" on public.strength_routine_sets;
create policy "own routine sets" on public.strength_routine_sets for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
    and exists (select 1 from public.strength_routine_exercises e where e.id = routine_exercise_id and e.user_id = (select auth.uid())));

drop policy if exists "own strength sessions" on public.strength_sessions;
create policy "own strength sessions" on public.strength_sessions for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
    and (routine_id is null or exists (select 1 from public.strength_routines r where r.id = routine_id and r.user_id = (select auth.uid()))));

drop policy if exists "own session exercises" on public.strength_session_exercises;
create policy "own session exercises" on public.strength_session_exercises for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
    and exists (select 1 from public.strength_sessions s where s.id = session_id and s.user_id = (select auth.uid()))
    and (custom_exercise_id is null or exists (select 1 from public.strength_custom_exercises c where c.id = custom_exercise_id and c.user_id = (select auth.uid()))));

drop policy if exists "own sets" on public.strength_sets;
create policy "own sets" on public.strength_sets for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
    and exists (select 1 from public.strength_sessions s where s.id = session_id and s.user_id = (select auth.uid())));

drop policy if exists "own training sessions" on public.training_sessions;
create policy "own training sessions" on public.training_sessions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own training links" on public.training_session_links;
create policy "own training links" on public.training_session_links for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
    and exists (select 1 from public.training_sessions t where t.id = training_session_id and t.user_id = (select auth.uid()))
    and (activity_id is null or exists (select 1 from public.activities a where a.id = activity_id and a.user_id = (select auth.uid())))
    and (strength_session_id is null or exists (select 1 from public.strength_sessions s where s.id = strength_session_id and s.user_id = (select auth.uid()))));

drop policy if exists "own merge decisions" on public.training_merge_decisions;
create policy "own merge decisions" on public.training_merge_decisions for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
    and (training_session_id is null or exists (select 1 from public.training_sessions t where t.id = training_session_id and t.user_id = (select auth.uid()))));

drop policy if exists "own wearable" on public.wearable_devices;
create policy "own wearable" on public.wearable_devices for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.strength_custom_exercises, public.strength_routines, public.strength_routine_exercises, public.strength_routine_sets,
              public.strength_sessions, public.strength_session_exercises, public.strength_sets,
              public.training_sessions, public.training_session_links, public.training_merge_decisions, public.wearable_devices
  from public, anon, authenticated;
grant select, insert, update, delete on public.strength_custom_exercises, public.strength_routines, public.strength_routine_exercises, public.strength_routine_sets,
              public.strength_sessions, public.strength_session_exercises, public.strength_sets,
              public.training_sessions, public.training_session_links, public.training_merge_decisions, public.wearable_devices
  to authenticated;

-- ================================================================== atomic functions (SECURITY INVOKER: RLS applies to every statement)

-- Save a whole routine (header, exercises, planned sets) in one transaction. The routine id is chosen by the app.
create or replace function public.save_strength_routine(p_routine jsonb)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  rid uuid := (p_routine->>'id')::uuid;
  ex  jsonb;
  st  jsonb;
  eid uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if rid is null then raise exception 'routine id required'; end if;
  if jsonb_array_length(coalesce(p_routine->'exercises', '[]'::jsonb)) > 100 then raise exception 'too many exercises'; end if;
  insert into public.strength_routines as r (id, user_id, name, notes, template_key)
  values (rid, auth.uid(), btrim(p_routine->>'name'), nullif(btrim(coalesce(p_routine->>'notes', '')), ''), nullif(p_routine->>'template_key', ''))
  on conflict (id) do update set name = excluded.name, notes = excluded.notes, template_key = coalesce(r.template_key, excluded.template_key);
  delete from public.strength_routine_exercises where routine_id = rid;           -- planned sets go with them (cascade)
  for ex in select * from jsonb_array_elements(coalesce(p_routine->'exercises', '[]'::jsonb)) loop
    insert into public.strength_routine_exercises (routine_id, user_id, position, exercise_key, custom_exercise_id, superset_group, rest_seconds, load_mode, weight_unit, notes, substitutes)
    values (rid, auth.uid(), (ex->>'position')::smallint, nullif(ex->>'exercise_key', ''), nullif(ex->>'custom_exercise_id', '')::uuid,
            nullif(ex->>'superset_group', '')::smallint, nullif(ex->>'rest_seconds', '')::smallint, nullif(ex->>'load_mode', ''), coalesce(nullif(ex->>'weight_unit', ''), 'kg'),
            nullif(btrim(coalesce(ex->>'notes', '')), ''), coalesce(array(select jsonb_array_elements_text(coalesce(ex->'substitutes', '[]'::jsonb))), '{}'))
    returning id into eid;
    if jsonb_array_length(coalesce(ex->'sets', '[]'::jsonb)) > 50 then raise exception 'too many sets'; end if;
    for st in select * from jsonb_array_elements(coalesce(ex->'sets', '[]'::jsonb)) loop
      insert into public.strength_routine_sets (routine_exercise_id, user_id, position, set_type, reps_min, reps_max, target_weight, target_rpe, target_rir, target_duration_s, target_distance_m)
      values (eid, auth.uid(), (st->>'position')::smallint, coalesce(nullif(st->>'set_type', ''), 'working'), nullif(st->>'reps_min', '')::smallint, nullif(st->>'reps_max', '')::smallint,
              nullif(st->>'target_weight', '')::numeric, nullif(st->>'target_rpe', '')::numeric, nullif(st->>'target_rir', '')::smallint,
              nullif(st->>'target_duration_s', '')::integer, nullif(st->>'target_distance_m', '')::numeric);
    end loop;
  end loop;
  return rid;
end $$;

-- Apply a batch of offline workout operations. Each op: {op_id, kind: session|exercise|set, id, rev, deleted, data:{...}}.
-- A row is only written when op.rev is newer than the stored rev, so replays and out-of-order delivery are safe.
-- Each op runs in its own sub-transaction: one bad op is reported as "rejected" and never blocks the others.
-- Returns [{op_id, status: applied|stale|rejected, error?}].
create or replace function public.apply_strength_ops(p_ops jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  uid  uuid := auth.uid();
  op   jsonb;
  d    jsonb;
  n    integer;
  del  timestamptz;
  out  jsonb := '[]'::jsonb;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if jsonb_typeof(p_ops) is distinct from 'array' or jsonb_array_length(p_ops) > 200 then raise exception 'invalid batch'; end if;
  for op in select * from jsonb_array_elements(p_ops) loop
    begin
      d   := coalesce(op->'data', '{}'::jsonb);
      del := case when coalesce((op->>'deleted')::boolean, false) then now() end;
      if (op->>'rev') is null or (op->>'rev')::bigint <= 0 then raise exception 'rev required'; end if;
      if op->>'kind' = 'session' then
        insert into public.strength_sessions as t (id, user_id, routine_id, title, status, started_at, ended_at, paused_at, paused_seconds, timezone, notes, perceived_effort, rev, deleted_at)
        values ((op->>'id')::uuid, uid,
                (select r.id from public.strength_routines r where r.id = nullif(d->>'routine_id', '')::uuid),   -- a routine deleted meanwhile is dropped, not an error
                coalesce(nullif(btrim(d->>'title'), ''), 'Workout'), coalesce(d->>'status', 'active'), (d->>'started_at')::timestamptz, nullif(d->>'ended_at', '')::timestamptz,
                nullif(d->>'paused_at', '')::timestamptz, coalesce(nullif(d->>'paused_seconds', '')::integer, 0), nullif(d->>'timezone', ''), nullif(d->>'notes', ''),
                nullif(d->>'perceived_effort', '')::smallint, (op->>'rev')::bigint, del)
        on conflict (id) do update set routine_id = excluded.routine_id, title = excluded.title, status = excluded.status, started_at = excluded.started_at,
          ended_at = excluded.ended_at, paused_at = excluded.paused_at, paused_seconds = excluded.paused_seconds, timezone = excluded.timezone, notes = excluded.notes,
          perceived_effort = excluded.perceived_effort, rev = excluded.rev, deleted_at = excluded.deleted_at
        where t.rev < excluded.rev and t.user_id = uid;                                      -- source and source_ref are never changed by an edit
      elsif op->>'kind' = 'exercise' then
        insert into public.strength_session_exercises as t (id, session_id, user_id, position, exercise_key, custom_exercise_id, exercise_name, superset_group, rest_seconds, load_mode, weight_unit, notes, rev, deleted_at)
        values ((op->>'id')::uuid, (d->>'session_id')::uuid, uid, (d->>'position')::smallint, nullif(d->>'exercise_key', ''), nullif(d->>'custom_exercise_id', '')::uuid,
                btrim(d->>'exercise_name'), nullif(d->>'superset_group', '')::smallint, nullif(d->>'rest_seconds', '')::smallint, coalesce(nullif(d->>'load_mode', ''), 'total'),
                coalesce(nullif(d->>'weight_unit', ''), 'kg'), nullif(d->>'notes', ''), (op->>'rev')::bigint, del)
        on conflict (id) do update set position = excluded.position, exercise_key = excluded.exercise_key, custom_exercise_id = excluded.custom_exercise_id,
          exercise_name = excluded.exercise_name, superset_group = excluded.superset_group, rest_seconds = excluded.rest_seconds, load_mode = excluded.load_mode,
          weight_unit = excluded.weight_unit, notes = excluded.notes, rev = excluded.rev, deleted_at = excluded.deleted_at
        where t.rev < excluded.rev and t.user_id = uid and t.session_id = excluded.session_id;    -- an exercise never moves to another session
      elsif op->>'kind' = 'set' then
        insert into public.strength_sets as t (id, session_exercise_id, session_id, user_id, position, set_type, weight, weight_unit, reps, duration_s, distance_m, rpe, rir, side, completed, completed_at, notes, rev, deleted_at)
        values ((op->>'id')::uuid, (d->>'session_exercise_id')::uuid, (d->>'session_id')::uuid, uid, (d->>'position')::smallint, coalesce(nullif(d->>'set_type', ''), 'working'),
                nullif(d->>'weight', '')::numeric, coalesce(nullif(d->>'weight_unit', ''), 'kg'), nullif(d->>'reps', '')::smallint, nullif(d->>'duration_s', '')::integer,
                nullif(d->>'distance_m', '')::numeric, nullif(d->>'rpe', '')::numeric, nullif(d->>'rir', '')::smallint, nullif(d->>'side', ''),
                coalesce((d->>'completed')::boolean, false), nullif(d->>'completed_at', '')::timestamptz, nullif(d->>'notes', ''), (op->>'rev')::bigint, del)
        on conflict (id) do update set position = excluded.position, set_type = excluded.set_type, weight = excluded.weight, weight_unit = excluded.weight_unit,
          reps = excluded.reps, duration_s = excluded.duration_s, distance_m = excluded.distance_m, rpe = excluded.rpe, rir = excluded.rir, side = excluded.side,
          completed = excluded.completed, completed_at = excluded.completed_at, notes = excluded.notes, rev = excluded.rev, deleted_at = excluded.deleted_at
        where t.rev < excluded.rev and t.user_id = uid and t.session_exercise_id = excluded.session_exercise_id;   -- a set never moves to another exercise
      else
        raise exception 'unknown kind';
      end if;
      get diagnostics n = row_count;
      out := out || jsonb_build_array(jsonb_build_object('op_id', op->>'op_id', 'status', case when n = 1 then 'applied' else 'stale' end));
    exception when others then
      out := out || jsonb_build_array(jsonb_build_object('op_id', op->>'op_id', 'status', 'rejected', 'error', left(sqlerrm, 200)));
    end;
  end loop;
  return out;
end $$;

-- Import historical workouts (e.g. from a Hevy CSV export) after the user has reviewed and confirmed them.
-- Idempotent: a workout whose source_ref already exists is skipped, never overwritten. Each workout is its own sub-transaction.
-- p_sessions: [{source_ref, title, started_at, ended_at, notes, exercises:[{position, exercise_key, custom_exercise_id, exercise_name, superset_group, notes,
--              weight_unit, load_mode, sets:[{position, set_type, weight, weight_unit, reps, duration_s, distance_m, rpe}]}]}]
-- Returns {imported, skipped, rejected, errors[]}.
create or replace function public.import_strength_sessions(p_source text, p_sessions jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  uid uuid := auth.uid();
  s jsonb; ex jsonb; st jsonb;
  sid uuid; eid uuid;
  imported integer := 0; skipped integer := 0; rejected integer := 0;
  errs jsonb := '[]'::jsonb;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_source is distinct from 'hevy_csv' then raise exception 'unsupported source'; end if;
  if jsonb_typeof(p_sessions) is distinct from 'array' or jsonb_array_length(p_sessions) > 100 then raise exception 'invalid batch'; end if;
  for s in select * from jsonb_array_elements(p_sessions) loop
    begin
      sid := null;
      insert into public.strength_sessions (id, user_id, title, status, started_at, ended_at, notes, source, source_ref, rev)
      values (gen_random_uuid(), uid, coalesce(nullif(btrim(s->>'title'), ''), 'Imported workout'), 'completed', (s->>'started_at')::timestamptz,
              coalesce(nullif(s->>'ended_at', '')::timestamptz, (s->>'started_at')::timestamptz), nullif(s->>'notes', ''), p_source, s->>'source_ref', 1)
      on conflict (user_id, source, source_ref) where source_ref is not null do nothing
      returning id into sid;
      if sid is null then skipped := skipped + 1; continue; end if;
      if jsonb_array_length(coalesce(s->'exercises', '[]'::jsonb)) > 60 then raise exception 'too many exercises in one workout'; end if;
      for ex in select * from jsonb_array_elements(coalesce(s->'exercises', '[]'::jsonb)) loop
        if jsonb_array_length(coalesce(ex->'sets', '[]'::jsonb)) > 50 then raise exception 'too many sets in one exercise'; end if;
        eid := gen_random_uuid();
        insert into public.strength_session_exercises (id, session_id, user_id, position, exercise_key, custom_exercise_id, exercise_name, superset_group, load_mode, weight_unit, notes, rev)
        values (eid, sid, uid, (ex->>'position')::smallint, nullif(ex->>'exercise_key', ''), nullif(ex->>'custom_exercise_id', '')::uuid, btrim(ex->>'exercise_name'),
                nullif(ex->>'superset_group', '')::smallint, coalesce(nullif(ex->>'load_mode', ''), 'total'), coalesce(nullif(ex->>'weight_unit', ''), 'kg'), nullif(ex->>'notes', ''), 1);
        for st in select * from jsonb_array_elements(coalesce(ex->'sets', '[]'::jsonb)) loop
          insert into public.strength_sets (id, session_exercise_id, session_id, user_id, position, set_type, weight, weight_unit, reps, duration_s, distance_m, rpe, completed, completed_at, rev)
          values (gen_random_uuid(), eid, sid, uid, (st->>'position')::smallint, coalesce(nullif(st->>'set_type', ''), 'working'), nullif(st->>'weight', '')::numeric,
                  coalesce(nullif(st->>'weight_unit', ''), 'kg'), nullif(st->>'reps', '')::smallint, nullif(st->>'duration_s', '')::integer, nullif(st->>'distance_m', '')::numeric,
                  nullif(st->>'rpe', '')::numeric, true, null, 1);
        end loop;
      end loop;
      imported := imported + 1;
    exception when others then
      rejected := rejected + 1;
      errs := errs || jsonb_build_array(jsonb_build_object('source_ref', s->>'source_ref', 'error', left(sqlerrm, 200)));
    end;
  end loop;
  return jsonb_build_object('imported', imported, 'skipped', skipped, 'rejected', rejected, 'errors', errs);
end $$;

-- Merge two source records into one canonical training session. Fails (and changes nothing) if either source is already linked.
-- p_sources: [{kind: 'activity'|'strength', id}], exactly two; p_primary: index (0 or 1) of the primary source.
create or replace function public.merge_training_sources(p_sources jsonb, p_primary integer, p_confidence text)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  uid uuid := auth.uid();
  src jsonb; i integer := 0;
  starts timestamptz[] := '{}'; ends timestamptz[] := '{}';
  k text; t_start timestamptz; t_end timestamptz; t_title text; t_sport text;
  p_kind text; p_title text; p_sport text;
  tid uuid; pkey text;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if jsonb_typeof(p_sources) is distinct from 'array' or jsonb_array_length(p_sources) <> 2 or p_primary is null or p_primary not in (0, 1) then raise exception 'exactly two sources required'; end if;
  if p_confidence is not null and p_confidence not in ('high', 'medium', 'low') then raise exception 'invalid confidence'; end if;
  for src in select * from jsonb_array_elements(p_sources) loop
    k := src->>'kind';
    if k = 'activity' then
      select a.started_at, a.started_at + make_interval(secs => coalesce(a.elapsed_s, a.duration_s, 0)), a.title, a.sport
        into t_start, t_end, t_title, t_sport from public.activities a where a.id = (src->>'id')::bigint and a.user_id = uid;
    elsif k = 'strength' then
      select s.started_at, s.ended_at, s.title, 'strength' into t_start, t_end, t_title, t_sport
        from public.strength_sessions s where s.id = (src->>'id')::uuid and s.user_id = uid and s.deleted_at is null;
    else raise exception 'unknown source kind';
    end if;
    if t_start is null then raise exception 'source not found'; end if;
    starts := starts || t_start; ends := ends || t_end;
    if i = p_primary then p_kind := k; p_title := t_title; p_sport := t_sport; end if;
    i := i + 1;
  end loop;
  select string_agg(x, '|' order by x collate "C") into pkey
    from (select (e->>'kind') || ':' || (e->>'id') as x from jsonb_array_elements(p_sources) e) q;
  if (p_sources->0->>'kind') || ':' || (p_sources->0->>'id') = (p_sources->1->>'kind') || ':' || (p_sources->1->>'id') then raise exception 'a source cannot be merged with itself'; end if;

  insert into public.training_sessions (user_id, primary_kind, title, sport, started_at, ended_at)
  values (uid, p_kind, left(p_title, 120), left(p_sport, 20), least(starts[1], starts[2]),
          case when ends[1] is null or ends[2] is null then coalesce(ends[1], ends[2]) else greatest(ends[1], ends[2]) end)
  returning id into tid;
  i := 0;
  for src in select * from jsonb_array_elements(p_sources) loop
    insert into public.training_session_links (training_session_id, user_id, activity_id, strength_session_id, role)
    values (tid, uid, case when src->>'kind' = 'activity' then (src->>'id')::bigint end, case when src->>'kind' = 'strength' then (src->>'id')::uuid end,
            case when i = p_primary then 'primary' else 'secondary' end);             -- unique indexes reject a source that is already linked
    i := i + 1;
  end loop;
  update public.training_merge_decisions set reverted_at = now() where user_id = uid and pair_key = pkey and reverted_at is null;
  insert into public.training_merge_decisions (user_id, pair_key, decision, training_session_id, primary_kind, confidence)
  values (uid, pkey, 'merged', tid, p_kind, p_confidence);
  return tid;
end $$;

-- Undo a merge: the canonical session and its links are removed; the source records were never touched, so they simply reappear.
create or replace function public.unmerge_training_session(p_id uuid)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  update public.training_merge_decisions set reverted_at = now() where training_session_id = p_id and user_id = auth.uid() and reverted_at is null;
  delete from public.training_sessions where id = p_id and user_id = auth.uid();
  if not found then raise exception 'training session not found'; end if;
end $$;

revoke all on function public.save_strength_routine(jsonb) from public, anon;
revoke all on function public.apply_strength_ops(jsonb) from public, anon;
revoke all on function public.import_strength_sessions(text, jsonb) from public, anon;
revoke all on function public.merge_training_sources(jsonb, integer, text) from public, anon;
revoke all on function public.unmerge_training_session(uuid) from public, anon;
grant execute on function public.save_strength_routine(jsonb) to authenticated;
grant execute on function public.apply_strength_ops(jsonb) to authenticated;
grant execute on function public.import_strength_sessions(text, jsonb) to authenticated;
grant execute on function public.merge_training_sources(jsonb, integer, text) to authenticated;
grant execute on function public.unmerge_training_session(uuid) to authenticated;

-- ================================================================== verification (run manually in staging)
-- BEFORE applying, confirm the activities key is an integer (training_session_links.activity_id is bigint):
--   select data_type from information_schema.columns where table_schema = 'public' and table_name = 'activities' and column_name in ('id', 'user_id');
--   select relname, relrowsecurity from pg_class where relname like 'strength_%' or relname like 'training_%' or relname = 'wearable_devices';   -- all true
--   select has_table_privilege('anon', 'public.strength_sets', 'SELECT');                                                                        -- false
--   select count(*) from public.activities where origin is not null;                                                                           -- 0 right after the migration
-- Replay safety: call apply_strength_ops twice with the same op: first "applied", second "stale"; the row count does not change.
-- Isolation: as user A create a session; as user B (set_config('request.jwt.claims', '{"sub":"<B uuid>"}', true)) select it: 0 rows;
--            B calling apply_strength_ops with A's session id returns "rejected" (RLS) and A's row is unchanged.
-- Double link: merging an activity that is already part of another canonical session fails with a unique violation; nothing is written.
