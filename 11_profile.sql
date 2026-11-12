-- 11: Profile module columns for public.profiles. NOT applied automatically: review, then run once in the Supabase SQL Editor
-- (staging first), AFTER 10. Additive and idempotent. The existing columns (display_name, timezone, units, weight_kg, height_cm,
-- max_hr, ftp_watts, sleep_goal_h, created_at), every existing row, RLS (own_profile) and grants are NOT touched.
--
-- Profile = slow-moving BASELINES the user sets (resting HR baseline, max HR, VO2max, thresholds, body measurements).
-- Daily measurements (HRV, daily resting HR, sleep, ...) stay in daily_metrics and activities and are never copied here.
-- field_sources records where each baseline value came from (manual, lab, garmin, intervals). Existing values get NO entry:
-- the app shows them as "source not recorded" instead of inventing a provenance.

alter table public.profiles
  add column if not exists birth_date              date,
  add column if not exists body_fat_pct            numeric(4,1),
  add column if not exists preferred_sports        text[] not null default '{}',
  add column if not exists primary_goal            text,
  add column if not exists goal_notes              text,
  add column if not exists resting_hr              integer,
  add column if not exists vo2max                  numeric(4,1),
  add column if not exists lthr                    integer,
  add column if not exists threshold_pace_s_per_km integer,
  add column if not exists experience_level        text,
  add column if not exists field_sources           jsonb not null default '{}'::jsonb;

alter table public.profiles drop constraint if exists profiles_birth_date_check;
alter table public.profiles add constraint profiles_birth_date_check check (birth_date is null or (birth_date >= date '1900-01-01' and birth_date <= current_date + 1));
alter table public.profiles drop constraint if exists profiles_body_fat_check;
alter table public.profiles add constraint profiles_body_fat_check check (body_fat_pct is null or (body_fat_pct >= 2 and body_fat_pct <= 60));
alter table public.profiles drop constraint if exists profiles_preferred_sports_check;
alter table public.profiles add constraint profiles_preferred_sports_check check (
  cardinality(preferred_sports) <= 7 and preferred_sports <@ array['running', 'cycling', 'triathlon', 'swimming', 'strength', 'football', 'other']::text[]);
alter table public.profiles drop constraint if exists profiles_primary_goal_check;
alter table public.profiles add constraint profiles_primary_goal_check check (
  primary_goal is null or primary_goal in ('general_fitness', 'weight_management', 'endurance', 'speed', 'race_performance', 'health', 'return_from_injury'));
alter table public.profiles drop constraint if exists profiles_goal_notes_len;
alter table public.profiles add constraint profiles_goal_notes_len check (goal_notes is null or char_length(goal_notes) <= 500);
alter table public.profiles drop constraint if exists profiles_resting_hr_check;
alter table public.profiles add constraint profiles_resting_hr_check check (resting_hr is null or (resting_hr >= 25 and resting_hr <= 120));
alter table public.profiles drop constraint if exists profiles_vo2max_check;
alter table public.profiles add constraint profiles_vo2max_check check (vo2max is null or (vo2max >= 10 and vo2max <= 95));
alter table public.profiles drop constraint if exists profiles_lthr_check;
alter table public.profiles add constraint profiles_lthr_check check (lthr is null or (lthr >= 60 and lthr <= 230));
alter table public.profiles drop constraint if exists profiles_threshold_pace_check;
alter table public.profiles add constraint profiles_threshold_pace_check check (threshold_pace_s_per_km is null or (threshold_pace_s_per_km >= 90 and threshold_pace_s_per_km <= 1200));
alter table public.profiles drop constraint if exists profiles_experience_check;
alter table public.profiles add constraint profiles_experience_check check (experience_level is null or experience_level in ('beginner', 'intermediate', 'advanced', 'elite'));
alter table public.profiles drop constraint if exists profiles_field_sources_check;
alter table public.profiles add constraint profiles_field_sources_check check (jsonb_typeof(field_sources) = 'object');

-- Verification (run manually in staging):
--   select count(*) from public.profiles where field_sources <> '{}'::jsonb;      -- 0 right after the migration (nothing invented)
--   select policyname, cmd from pg_policies where tablename = 'profiles';          -- still only own_profile
--   select column_name from information_schema.columns where table_name = 'profiles' order by ordinal_position;