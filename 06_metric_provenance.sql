-- 06: field-level provenance + atomic write functions for daily_metrics.
-- Run once in the Supabase SQL Editor BEFORE deploying the new code. Additive: no existing value is changed or deleted.

-- 1) Provenance columns. The old row-level "source" column stays untouched.
alter table public.daily_metrics
  add column if not exists hrv_source         text,
  add column if not exists rhr_source         text,
  add column if not exists sleep_source       text,
  add column if not exists sleep_score_source text;

-- A partial manual entry (e.g. only HRV) must be possible. Harmless if these are already nullable.
alter table public.daily_metrics
  alter column hrv_ms drop not null,
  alter column rhr_bpm drop not null,
  alter column sleep_minutes drop not null;

-- 2) Conservative backfill. Provenance is only claimed where it can be established:
--    * row source = 'manual'  -> the old web form wrote HRV, RHR and sleep together, so those are manual.
--    * anything else (intervals, null, other apps, mixed rows from the first sync version) -> 'legacy_unknown'.
--    legacy_unknown values are never overwritten by sync; a manual edit replaces them.
update public.daily_metrics set hrv_source   = case when source = 'manual' then 'manual' else 'legacy_unknown' end where hrv_ms        is not null and hrv_source   is null;
update public.daily_metrics set rhr_source   = case when source = 'manual' then 'manual' else 'legacy_unknown' end where rhr_bpm       is not null and rhr_source   is null;
update public.daily_metrics set sleep_source = case when source = 'manual' then 'manual' else 'legacy_unknown' end where sleep_minutes is not null and sleep_source is null;
update public.daily_metrics set sleep_score_source = 'legacy_unknown' where sleep_score is not null and sleep_score_source is null;

alter table public.daily_metrics drop constraint if exists daily_metrics_source_values;
alter table public.daily_metrics add constraint daily_metrics_source_values check (
  coalesce(hrv_source, 'manual')   in ('manual','intervals','legacy_unknown') and
  coalesce(rhr_source, 'manual')   in ('manual','intervals','legacy_unknown') and
  coalesce(sleep_source, 'manual') in ('manual','intervals','legacy_unknown') and
  coalesce(sleep_score_source, 'manual') in ('manual','intervals','legacy_unknown'));

-- 3) Atomic manual write. One INSERT .. ON CONFLICT statement: the row is locked, only the supplied
--    (non-null) fields are written, and nothing else (other measurements, score, sources) is touched.
create or replace function public.apply_manual_metrics(
  p_day date, p_hrv numeric default null, p_rhr numeric default null, p_sleep_minutes numeric default null)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_hrv is null and p_rhr is null and p_sleep_minutes is null then return; end if;
  if p_hrv is not null and (p_hrv <= 0 or p_hrv > 300) then raise exception 'hrv out of range'; end if;
  if p_rhr is not null and (p_rhr < 20 or p_rhr > 250) then raise exception 'rhr out of range'; end if;
  if p_sleep_minutes is not null and (p_sleep_minutes <= 0 or p_sleep_minutes > 1440) then raise exception 'sleep out of range'; end if;

  insert into public.daily_metrics as d (user_id, day, hrv_ms, rhr_bpm, sleep_minutes, source, hrv_source, rhr_source, sleep_source)
  values (auth.uid(), p_day, p_hrv, p_rhr, p_sleep_minutes, 'manual',
          case when p_hrv is not null then 'manual' end,
          case when p_rhr is not null then 'manual' end,
          case when p_sleep_minutes is not null then 'manual' end)
  on conflict (user_id, day) do update set
    hrv_ms        = coalesce(excluded.hrv_ms, d.hrv_ms),
    hrv_source    = case when excluded.hrv_ms is not null then 'manual' else d.hrv_source end,
    rhr_bpm       = coalesce(excluded.rhr_bpm, d.rhr_bpm),
    rhr_source    = case when excluded.rhr_bpm is not null then 'manual' else d.rhr_source end,
    sleep_minutes = coalesce(excluded.sleep_minutes, d.sleep_minutes),
    sleep_source  = case when excluded.sleep_minutes is not null then 'manual' else d.sleep_source end;
end $$;

-- 4) Atomic sync write. A single statement over all days. In ON CONFLICT DO UPDATE the CASE conditions are
--    evaluated against the row version that is locked at that moment, so a manual value committed by a
--    concurrent transaction is seen and kept; a manual edit that commits afterwards simply replaces the synced
--    value. There is no read-then-write gap. Sync only writes a field that is empty or already 'intervals';
--    null never erases anything; the sleep score is independent of sleep_minutes.
create or replace function public.apply_synced_metrics(p_rows jsonb)
returns integer language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  with up as (
    insert into public.daily_metrics as d (user_id, day, hrv_ms, rhr_bpm, sleep_minutes, sleep_score, source,
                                           hrv_source, rhr_source, sleep_source, sleep_score_source)
    select distinct on (r.day) auth.uid(), r.day, r.hrv_ms, r.rhr_bpm, r.sleep_minutes, r.sleep_score, 'intervals',
           case when r.hrv_ms is not null then 'intervals' end,
           case when r.rhr_bpm is not null then 'intervals' end,
           case when r.sleep_minutes is not null then 'intervals' end,
           case when r.sleep_score is not null then 'intervals' end
    from jsonb_to_recordset(p_rows) as r(day date, hrv_ms numeric, rhr_bpm numeric, sleep_minutes numeric, sleep_score numeric)
    where r.hrv_ms is not null or r.rhr_bpm is not null or r.sleep_minutes is not null or r.sleep_score is not null
    on conflict (user_id, day) do update set
      hrv_ms = case when excluded.hrv_ms is not null and (d.hrv_ms is null or d.hrv_source = 'intervals') then excluded.hrv_ms else d.hrv_ms end,
      hrv_source = case when excluded.hrv_ms is not null and (d.hrv_ms is null or d.hrv_source = 'intervals') then 'intervals' else d.hrv_source end,
      rhr_bpm = case when excluded.rhr_bpm is not null and (d.rhr_bpm is null or d.rhr_source = 'intervals') then excluded.rhr_bpm else d.rhr_bpm end,
      rhr_source = case when excluded.rhr_bpm is not null and (d.rhr_bpm is null or d.rhr_source = 'intervals') then 'intervals' else d.rhr_source end,
      sleep_minutes = case when excluded.sleep_minutes is not null and (d.sleep_minutes is null or d.sleep_source = 'intervals') then excluded.sleep_minutes else d.sleep_minutes end,
      sleep_source = case when excluded.sleep_minutes is not null and (d.sleep_minutes is null or d.sleep_source = 'intervals') then 'intervals' else d.sleep_source end,
      sleep_score = case when excluded.sleep_score is not null and (d.sleep_score is null or d.sleep_score_source = 'intervals') then excluded.sleep_score else d.sleep_score end,
      sleep_score_source = case when excluded.sleep_score is not null and (d.sleep_score is null or d.sleep_score_source = 'intervals') then 'intervals' else d.sleep_score_source end
    returning 1)
  select count(*) into n from up;
  return n;
end $$;

-- Only signed-in users may call them; they run as the caller, so RLS on daily_metrics still applies.
revoke all on function public.apply_manual_metrics(date, numeric, numeric, numeric) from public, anon;
revoke all on function public.apply_synced_metrics(jsonb) from public, anon;
grant execute on function public.apply_manual_metrics(date, numeric, numeric, numeric) to authenticated;
grant execute on function public.apply_synced_metrics(jsonb) to authenticated;

-- OPTIONAL, review first: legacy values you know came from the first Intervals sync can be re-labelled so that
-- sync may refresh them again, e.g. for rows you are sure were never edited by hand:
-- update public.daily_metrics set hrv_source = 'intervals' where source = 'intervals' and hrv_source = 'legacy_unknown' and <your condition>;
