-- 10: Race Hub columns for public.races. NOT applied automatically: review, then run once in the Supabase SQL Editor
-- (staging first), after 09. Additive and idempotent: the existing columns (name, race_date, race_type, priority, goal,
-- bib_number, notes) and every existing row are preserved. RLS and grants on races are NOT touched (the existing
-- "own_rows" policy already limits every row to its owner). No results or predictions are stored here.

alter table public.races
  add column if not exists sport         text,
  add column if not exists location      text,
  add column if not exists distance      numeric,
  add column if not exists distance_unit text,
  add column if not exists target_time_s integer,
  add column if not exists status        text not null default 'planned';

-- Backfill sport from the existing, already-chosen race_type (a fixed mapping of the old categories, nothing invented).
update public.races set sport = case
    when race_type in ('marathon', 'half_marathon', '10k', 'trail')                   then 'running'
    when race_type = 'cycling'                                                          then 'cycling'
    when race_type in ('triathlon_sprint', 'triathlon_olympic', 'half_ironman', 'ironman') then 'triathlon'
    else 'other' end
  where sport is null;
alter table public.races alter column sport set default 'other';
alter table public.races alter column sport set not null;

alter table public.races drop constraint if exists races_sport_check;
alter table public.races add constraint races_sport_check check (sport in ('running', 'cycling', 'triathlon', 'swimming', 'football', 'other'));
alter table public.races drop constraint if exists races_status_check;
alter table public.races add constraint races_status_check check (status in ('planned', 'registered', 'completed', 'dnf', 'dns', 'cancelled'));
alter table public.races drop constraint if exists races_distance_check;
alter table public.races add constraint races_distance_check check (
  (distance is null and distance_unit is null) or (distance > 0 and distance_unit in ('km', 'mi', 'm')));
alter table public.races drop constraint if exists races_target_time_check;
alter table public.races add constraint races_target_time_check check (target_time_s is null or (target_time_s > 0 and target_time_s <= 604800));
alter table public.races drop constraint if exists races_location_len;
alter table public.races add constraint races_location_len check (location is null or char_length(location) <= 120);

-- Verification (run manually in staging):
--   select sport, count(*) from public.races group by 1;                          -- every old row has a sport
--   select count(*) from public.races where status <> 'planned';                  -- 0 right after the migration
--   select policyname, cmd from pg_policies where tablename = 'races';            -- still only own_rows