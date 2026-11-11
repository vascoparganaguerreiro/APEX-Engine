-- 06: field-level provenance for daily_metrics. Run once in the Supabase SQL Editor, BEFORE deploying the new code.
-- Additive only: no existing value is changed or deleted. The old row-level "source" column stays as it is.

alter table public.daily_metrics
  add column if not exists hrv_source         text,
  add column if not exists rhr_source         text,
  add column if not exists sleep_source       text,
  add column if not exists sleep_score_source text;

-- Backfill: every existing value inherits the old row-level source. Rows with no source are treated as
-- 'manual', which protects them from sync (the safe side).
update public.daily_metrics set hrv_source   = coalesce(source, 'manual') where hrv_ms        is not null and hrv_source   is null;
update public.daily_metrics set rhr_source   = coalesce(source, 'manual') where rhr_bpm       is not null and rhr_source   is null;
update public.daily_metrics set sleep_source = coalesce(source, 'manual') where sleep_minutes is not null and sleep_source is null;
-- A sleep score can only have come from a sync; the manual form never wrote one.
update public.daily_metrics set sleep_score_source = 'intervals' where sleep_score is not null and sleep_score_source is null;

-- OPTIONAL, review first: list manual sleep entries that still carry a score from a different night length.
-- select user_id, day, sleep_minutes, sleep_score from public.daily_metrics where sleep_source = 'manual' and sleep_score is not null;
-- Then, if you agree those scores are outdated:
-- update public.daily_metrics set sleep_score = null, sleep_score_source = null where sleep_source = 'manual' and sleep_score is not null;
