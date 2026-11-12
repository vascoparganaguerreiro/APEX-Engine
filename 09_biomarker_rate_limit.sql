-- 09: durable per-user rate limit for biomarker report extraction (Gemini). NOT applied automatically: review, then run
-- once in the Supabase SQL Editor (staging first). Additive only. Run after 08.
-- Stores only a user id and a timestamp per request: never report contents, biomarker values or any health data.

create table if not exists public.biomarker_extract_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now()
);
create index if not exists biomarker_extract_requests_user_time_idx on public.biomarker_extract_requests (user_id, requested_at);

-- Server-only: RLS on with NO policies, and no privileges for browser roles. Only service_role (server) can touch it.
alter table public.biomarker_extract_requests enable row level security;
alter table public.biomarker_extract_requests force row level security;
revoke all on public.biomarker_extract_requests from public, anon, authenticated;
grant select, insert, delete on public.biomarker_extract_requests to service_role;

-- Consume one unit of the user's allowance, atomically. The per-user advisory lock serialises concurrent calls for the
-- same user, so two simultaneous requests can never both read "9 used" and both insert: the count and the insert happen
-- while the lock is held (released at the end of the transaction). Rolling window measured with clock_timestamp() taken
-- after the lock: only rows newer than the window count, older rows are deleted here, so the table never holds more than
-- `p_limit` rows per user.
create or replace function public.consume_extraction_quota(p_user uuid, p_limit integer default 10, p_window_seconds integer default 3600)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql security invoker set search_path = public as $$
declare
  used    integer;
  oldest  timestamptz;
  win     interval;
  v_now   timestamptz;
begin
  if p_user is null or p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'invalid arguments';
  end if;
  win := make_interval(secs => p_window_seconds);
  perform pg_advisory_xact_lock(hashtextextended('biomarker_extract:' || p_user::text, 0));
  -- Read the clock only AFTER the lock is held. now() is the transaction start time, which can be earlier than the moment
  -- a request that waited on the lock really runs; clock_timestamp() is the actual current time. One value is used for the
  -- whole call, so the expiry, the retry calculation and the recorded request time are consistent with each other.
  v_now := clock_timestamp();
  delete from public.biomarker_extract_requests where user_id = p_user and requested_at < v_now - win;
  select count(*), min(requested_at) into used, oldest from public.biomarker_extract_requests where user_id = p_user;
  if used >= p_limit then
    return query select false, 0, greatest(1, ceil(extract(epoch from (oldest + win - v_now)))::integer);
    return;
  end if;
  insert into public.biomarker_extract_requests (user_id, requested_at) values (p_user, v_now);
  return query select true, p_limit - used - 1, 0;
end $$;

-- Only the server's privileged client may consume capacity: no browser role can call it, so nobody can drain or reset
-- another user's allowance. (Supabase grants EXECUTE on new functions to anon/authenticated by default: revoked explicitly.)
revoke all on function public.consume_extraction_quota(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_extraction_quota(uuid, integer, integer) to service_role;

-- Verification (run manually in staging):
--   select has_table_privilege('authenticated', 'public.biomarker_extract_requests', 'SELECT');            -- false
--   select has_function_privilege('authenticated', 'public.consume_extraction_quota(uuid,integer,integer)', 'EXECUTE');  -- false
--   select has_function_privilege('anon', 'public.consume_extraction_quota(uuid,integer,integer)', 'EXECUTE');           -- false
--   select has_function_privilege('service_role', 'public.consume_extraction_quota(uuid,integer,integer)', 'EXECUTE');   -- true
--   select p.prosecdef, p.proconfig from pg_proc p where p.proname = 'consume_extraction_quota';                       -- false, {search_path=public}