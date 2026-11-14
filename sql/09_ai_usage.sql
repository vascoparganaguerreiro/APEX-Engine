-- 09: server-only ledger of AI usage, for per-user daily limits. Run once AFTER 07 and BEFORE deploying the code
-- that calls consume_ai_usage (lib/aiUsage.ts). Additive and idempotent: safe to run again.
-- Design (same model as intervals_credentials in 07): browsers can neither read nor write this table, so the
-- counter cannot be reset or faked from the client. Only the server (service_role) records and releases events.
-- Each AI call inserts one row; regenerating the same activity/week inserts another row, so it counts again.

-- 1) Server-only events table. RLS enabled and forced with NO policies = deny for every non-bypass role.
create table if not exists public.ai_usage_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('summary','report_extract')),
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_events_user_kind_created on public.ai_usage_events (user_id, kind, created_at);
alter table public.ai_usage_events enable row level security;
alter table public.ai_usage_events force row level security;
do $$
declare p record;
begin   -- there must be no policy at all; remove any that was added by hand
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'ai_usage_events' loop
    execute format('drop policy %I on public.ai_usage_events', p.policyname);
  end loop;
end $$;
revoke all on public.ai_usage_events from public, anon, authenticated;
do $$
declare s text := pg_get_serial_sequence('public.ai_usage_events', 'id');
begin   -- Supabase's default privileges also grant the identity sequence to the browser roles
  if s is not null then execute format('revoke all on sequence %s from public, anon, authenticated', s); end if;
end $$;
-- service_role (server only) keeps its default privileges and bypasses RLS.

-- 2) Atomic consume: per-user transaction lock, count today's events (UTC day) of this kind, insert if under the limit.
--    Returns the new event id, or null when the limit is reached. Parallel calls for one user are serialised by the
--    lock, so N concurrent requests can never all pass. The server releases an event (plain delete by id, as
--    service_role) when the AI call or saving its result fails, so users are not charged for failures.
create or replace function public.consume_ai_usage(p_user uuid, p_kind text, p_limit integer)
returns bigint language plpgsql volatile security invoker set search_path = '' as $$
declare
  day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  used integer;
  new_id bigint;
begin
  if p_user is null then raise exception 'consume_ai_usage: user is required'; end if;
  if p_kind is null or p_kind not in ('summary','report_extract') then raise exception 'consume_ai_usage: unknown kind %', p_kind; end if;
  if p_limit is null or p_limit < 0 then raise exception 'consume_ai_usage: invalid limit %', p_limit; end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_usage:' || p_user::text, 0));   -- held until commit
  select count(*) into used from public.ai_usage_events
   where user_id = p_user and kind = p_kind and created_at >= day_start;
  if used >= p_limit then return null; end if;
  insert into public.ai_usage_events (user_id, kind) values (p_user, p_kind) returning id into new_id;
  return new_id;
end $$;
revoke all on function public.consume_ai_usage(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.consume_ai_usage(uuid, text, integer) to service_role;

-- 3) Verification (run manually).
-- Each of these must fail with "permission denied":
--   set role authenticated; select * from public.ai_usage_events;
--   set role authenticated; insert into public.ai_usage_events (user_id, kind) values (auth.uid(), 'summary');
--   set role authenticated; delete from public.ai_usage_events;
--   set role authenticated; select public.consume_ai_usage(gen_random_uuid(), 'summary', 30);
--   set role anon; select public.consume_ai_usage(gen_random_uuid(), 'summary', 30);
--   reset role;
-- These must return no rows (no browser grants on the table, its sequence or the function, and no policies):
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'ai_usage_events' and grantee in ('anon','authenticated','PUBLIC');
--   select grantee, privilege_type from information_schema.role_usage_grants
--    where object_name = 'ai_usage_events_id_seq' and grantee in ('anon','authenticated','PUBLIC');
--   select grantee from information_schema.role_routine_grants
--    where routine_name = 'consume_ai_usage' and grantee in ('anon','authenticated','PUBLIC');
--   select * from pg_policies where tablename = 'ai_usage_events';
-- Limit behaviour (as postgres / service_role, with a real user id): with limit 2 the first two calls return ids,
-- the third returns null; deleting one of the ids makes the next call succeed again:
--   select public.consume_ai_usage('<user-uuid>', 'summary', 2);   -- x3
--   delete from public.ai_usage_events where user_id = '<user-uuid>';   -- clean up

-- 4) Optional housekeeping: only today's rows matter for the limit; old rows can be pruned at any time:
--   delete from public.ai_usage_events where created_at < now() - interval '90 days';
