-- 14: APEX Universal Connect: provider connections, encrypted OAuth tokens, OAuth state, normalised observations.
-- STAGING FIRST. Apply after 09-13 (planned order 09 -> 10 -> 11 -> 12 -> 13 -> 14).
--
-- Dependencies:
--   * Base schema (auth.users, public.daily_metrics) and 06_metric_provenance.sql (the per-field source columns and the constraint
--     daily_metrics_source_values, which this file widens to also allow 'whoop').
--   * It does NOT reference any object from 09-13. The app works without this file: the Connectivity Centre shows a setup notice,
--     WHOOP cannot be connected, and the Intervals.icu sync runs exactly as before (without saving observations or sync status).
-- Additive and idempotent: no existing row is changed or deleted. The only change to an existing object is the widened check
-- constraint on daily_metrics (same rules, one more allowed source value).
--
-- Wrap in a transaction when pasting into the SQL Editor:  begin;  <this file>  commit;

-- ------------------------------------------------------------------ 1) connection status (browser: read-only, non-secret columns)
create table if not exists public.provider_connections (
  user_id              uuid not null references auth.users(id) on delete cascade,
  provider             text not null check (provider in ('intervals','whoop','garmin','coros','polar','suunto','oura','amazfit','apple_health','samsung_health','strava')),
  transport            text not null default 'direct' check (transport in ('direct','intervals','companion_app','file')),
  status               text not null default 'connected' check (status in ('connected','reauth_required','error','disconnected')),
  external_user_id     text check (external_user_id is null or length(external_user_id) <= 100),
  scopes               text[] not null default '{}',
  settings             jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) < 2000),
  cursor               jsonb check (cursor is null or (jsonb_typeof(cursor) = 'object' and pg_column_size(cursor) < 4000)),
  connected_at         timestamptz not null default now(),
  disconnected_at      timestamptz,
  last_sync_started_at timestamptz,
  lease_until          timestamptz,
  last_sync_at         timestamptz,
  last_success_at      timestamptz,
  last_error           text check (last_error is null or length(last_error) <= 200),
  last_error_at        timestamptz,
  failures             integer not null default 0 check (failures >= 0),
  next_retry_at        timestamptz,
  primary key (user_id, provider)
);
alter table public.provider_connections enable row level security;
drop policy if exists "own provider connections read" on public.provider_connections;
create policy "own provider connections read" on public.provider_connections for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.provider_connections from public, anon, authenticated;
grant select on public.provider_connections to authenticated;          -- no secrets in this table; writes are server-only

-- ------------------------------------------------------------------ 2) encrypted tokens (server only: RLS on, NO policies, NO grants)
create table if not exists public.provider_credentials (
  user_id            uuid not null references auth.users(id) on delete cascade,
  provider           text not null check (provider in ('intervals','whoop','garmin','coros','polar','suunto','oura','strava')),
  access_token_enc   text not null,
  refresh_token_enc  text,
  expires_at         timestamptz,
  scopes             text[] not null default '{}',
  key_version        integer not null default 1,
  rev                integer not null default 1,           -- compare-and-set for refresh-token rotation
  updated_at         timestamptz not null default now(),
  primary key (user_id, provider)
);
alter table public.provider_credentials enable row level security;
alter table public.provider_credentials force row level security;
revoke all on public.provider_credentials from public, anon, authenticated;

-- ------------------------------------------------------------------ 3) OAuth state (server only, one-time, 10-minute life)
create table if not exists public.oauth_states (
  state_hash  text primary key,                            -- sha256(state); the raw state is never stored
  user_id     uuid not null references auth.users(id) on delete cascade,
  provider    text not null,
  nonce_hash  text not null,                               -- sha256 of the HttpOnly cookie nonce that binds the flow to the browser
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists oauth_states_expires_idx on public.oauth_states (expires_at);
create index if not exists oauth_states_user_idx on public.oauth_states (user_id);
alter table public.oauth_states enable row level security;
alter table public.oauth_states force row level security;
revoke all on public.oauth_states from public, anon, authenticated;

-- ------------------------------------------------------------------ 4) normalised observations (one value of one metric from one source record)
-- provider  = where it was measured ('unknown' when the transport does not say, e.g. Intervals.icu wellness)
-- transport = how it reached APEX
-- Vendor scores are namespaced in `metric` (whoop.recovery_score, intervals.readiness) and never merged across vendors.
create table if not exists public.metric_observations (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references auth.users(id) on delete cascade,
  provider         text not null check (provider ~ '^[a-z_0-9]{2,30}$'),
  transport        text not null check (transport in ('direct','intervals','manual','companion_app','file')),
  source_record_id text not null check (length(source_record_id) between 1 and 200),
  metric           text not null check (metric ~ '^[a-z][a-z0-9_.]{1,60}$'),
  value            numeric not null,
  unit             text not null check (length(unit) <= 20),
  measured_at      timestamptz not null,
  local_day        date,
  quality          text not null default 'ok' check (quality in ('ok','origin_unknown','approximate_day','pending')),
  vendor_state     text check (vendor_state is null or length(vendor_state) <= 40),
  imported_at      timestamptz not null default now(),   -- first import; never changed by later syncs
  updated_at       timestamptz not null default now(),
  unique (user_id, provider, transport, source_record_id, metric)
);
create index if not exists metric_observations_user_metric_day_idx on public.metric_observations (user_id, metric, local_day desc);
create index if not exists metric_observations_user_measured_idx on public.metric_observations (user_id, measured_at desc);
alter table public.metric_observations enable row level security;
drop policy if exists "own observations read" on public.metric_observations;
drop policy if exists "own observations insert" on public.metric_observations;
drop policy if exists "own observations update" on public.metric_observations;
drop policy if exists "own observations delete" on public.metric_observations;
create policy "own observations read"   on public.metric_observations for select to authenticated using (user_id = (select auth.uid()));
create policy "own observations insert" on public.metric_observations for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own observations update" on public.metric_observations for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own observations delete" on public.metric_observations for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.metric_observations from public, anon, authenticated;
grant select, insert, update, delete on public.metric_observations to authenticated;
-- imported_at stays the first-import time: updates may not change it (column-level privilege). The key columns stay updatable only
-- because an upsert's DO UPDATE re-sets them to the same values; RLS still pins user_id to the caller.
revoke update on public.metric_observations from authenticated;
grant update (user_id, provider, transport, source_record_id, metric, value, unit, measured_at, local_day, quality, vendor_state, updated_at)
  on public.metric_observations to authenticated;

-- ------------------------------------------------------------------ 5) daily_metrics: allow 'whoop' as a per-field source (06 rules otherwise unchanged)
alter table public.daily_metrics drop constraint if exists daily_metrics_source_values;
alter table public.daily_metrics add constraint daily_metrics_source_values check (
  coalesce(hrv_source, 'manual')   in ('manual','intervals','legacy_unknown','whoop') and
  coalesce(rhr_source, 'manual')   in ('manual','intervals','legacy_unknown','whoop') and
  coalesce(sleep_source, 'manual') in ('manual','intervals','legacy_unknown','whoop') and
  coalesce(sleep_score_source, 'manual') in ('manual','intervals','legacy_unknown'));   -- vendor sleep scores are not interchangeable

-- Atomic fill from a direct provider. A field is written only when it is EMPTY or was written by the SAME provider, so manual,
-- legacy_unknown and Intervals values are never overwritten (and apply_synced_metrics from 06 never overwrites a 'whoop' value).
-- Null never erases. The sleep score is never touched. Runs as the caller (RLS on daily_metrics applies).
create or replace function public.apply_provider_daily_metrics(p_provider text, p_rows jsonb)
returns integer language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_provider is distinct from 'whoop' then raise exception 'unsupported provider'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 400 then raise exception 'bad rows'; end if;
  with up as (
    insert into public.daily_metrics as d (user_id, day, hrv_ms, rhr_bpm, sleep_minutes, source, hrv_source, rhr_source, sleep_source)
    select distinct on (r.day) auth.uid(), r.day,
           case when r.hrv_ms between 1 and 300 then r.hrv_ms end,
           case when r.rhr_bpm between 20 and 250 then r.rhr_bpm end,
           case when r.sleep_minutes between 1 and 1440 then r.sleep_minutes end,
           p_provider,
           case when r.hrv_ms between 1 and 300 then p_provider end,
           case when r.rhr_bpm between 20 and 250 then p_provider end,
           case when r.sleep_minutes between 1 and 1440 then p_provider end
    from jsonb_to_recordset(p_rows) as r(day date, hrv_ms numeric, rhr_bpm numeric, sleep_minutes numeric)
    where r.day is not null and (r.hrv_ms between 1 and 300 or r.rhr_bpm between 20 and 250 or r.sleep_minutes between 1 and 1440)
    on conflict (user_id, day) do update set
      hrv_ms        = case when excluded.hrv_ms is not null and (d.hrv_ms is null or d.hrv_source = p_provider) then excluded.hrv_ms else d.hrv_ms end,
      hrv_source    = case when excluded.hrv_ms is not null and (d.hrv_ms is null or d.hrv_source = p_provider) then p_provider else d.hrv_source end,
      rhr_bpm       = case when excluded.rhr_bpm is not null and (d.rhr_bpm is null or d.rhr_source = p_provider) then excluded.rhr_bpm else d.rhr_bpm end,
      rhr_source    = case when excluded.rhr_bpm is not null and (d.rhr_bpm is null or d.rhr_source = p_provider) then p_provider else d.rhr_source end,
      sleep_minutes = case when excluded.sleep_minutes is not null and (d.sleep_minutes is null or d.sleep_source = p_provider) then excluded.sleep_minutes else d.sleep_minutes end,
      sleep_source  = case when excluded.sleep_minutes is not null and (d.sleep_minutes is null or d.sleep_source = p_provider) then p_provider else d.sleep_source end
    returning 1)
  select count(*) into n from up;
  return n;
end $$;
revoke all on function public.apply_provider_daily_metrics(text, jsonb) from public, anon;
grant execute on function public.apply_provider_daily_metrics(text, jsonb) to authenticated;

-- ------------------------------------------------------------------ verification (run manually after applying)
-- BEFORE applying, check that daily_metrics.source accepts a new value (a base-schema check constraint on the row-level `source`
-- column would make WHOOP daily fills fail; observations would still be saved):
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.daily_metrics'::regclass and contype = 'c';
-- After applying:
--   select count(*) from public.metric_observations;                     -- 0
--   set role authenticated; select * from public.provider_credentials;   -- must fail: permission denied
--   set role authenticated; select * from public.oauth_states;           -- must fail: permission denied
--   reset role;
--   select tablename, policyname from pg_policies where tablename in ('provider_connections','provider_credentials','oauth_states','metric_observations');
--   -- expected: 1 policy on provider_connections, 4 on metric_observations, none on provider_credentials / oauth_states
