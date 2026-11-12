-- 12: APEX Coach. NOT applied automatically: review, then run once in the Supabase SQL Editor (staging first), AFTER 11.
-- Additive only. The existing public.coach_messages table (no conversation id, plain text) is left untouched.
--
-- Users can READ and DELETE their own Coach data. They cannot insert or update it: conversations, answers and assessments are
-- written only by the server (service role) after authentication, so nobody can forge a Coach answer or an assessment score.
-- coach_usage and the rate limiter are server-only (no browser access at all).

create table if not exists public.coach_conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text not null default 'New conversation' check (char_length(title) between 1 and 120),
  domain     text not null default 'general' check (domain in ('general', 'strength')),   -- "strength" is reserved for the future gym assistant
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists coach_conversations_user_idx on public.coach_conversations (user_id, domain, updated_at desc);

create table if not exists public.coach_chat_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.coach_conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null check (char_length(content) between 1 and 8000),
  meta            jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object' and octet_length(meta::text) <= 20000),   -- confidence, data categories sent, follow-ups: never raw health data
  created_at      timestamptz not null default now()
);
create index if not exists coach_chat_messages_conv_idx on public.coach_chat_messages (conversation_id, created_at);

create table if not exists public.coach_assessments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  kind            text not null check (kind in ('session', 'daily')),
  mode            text check (mode in ('completed', 'planned')),
  sport           text check (char_length(sport) <= 20),
  subject         jsonb not null default '{}'::jsonb check (jsonb_typeof(subject) = 'object' and octet_length(subject::text) <= 8000),   -- an activity id or a short manual description, never a copy of the activity
  result          jsonb not null check (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 60000),
  score           integer check (score between 1 and 100),                      -- only set when there was enough evidence
  confidence      text not null check (confidence in ('low', 'medium', 'high')),
  categories_sent text[] not null default '{}',
  created_at      timestamptz not null default now()
);
create index if not exists coach_assessments_user_idx on public.coach_assessments (user_id, kind, created_at desc);

-- Server-only usage log: one row per Coach request, used for the durable rate limit and for token/cost monitoring.
create table if not exists public.coach_usage (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('chat', 'plan', 'session', 'daily')),
  requested_at timestamptz not null default now(),
  tokens_in    integer check (tokens_in >= 0),
  tokens_out   integer check (tokens_out >= 0),
  model        text check (char_length(model) <= 80),
  outcome      text check (outcome in ('ok', 'error'))
);
create index if not exists coach_usage_user_time_idx on public.coach_usage (user_id, requested_at);

-- ------------------------------------------------------------------ RLS and grants
alter table public.coach_conversations enable row level security;
alter table public.coach_chat_messages enable row level security;
alter table public.coach_assessments   enable row level security;
alter table public.coach_usage         enable row level security;
alter table public.coach_usage         force row level security;

drop policy if exists "own conversations read" on public.coach_conversations;
create policy "own conversations read" on public.coach_conversations for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "own conversations delete" on public.coach_conversations;
create policy "own conversations delete" on public.coach_conversations for delete to authenticated using (user_id = (select auth.uid()));
drop policy if exists "own messages read" on public.coach_chat_messages;
create policy "own messages read" on public.coach_chat_messages for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "own messages delete" on public.coach_chat_messages;
create policy "own messages delete" on public.coach_chat_messages for delete to authenticated using (user_id = (select auth.uid()));
drop policy if exists "own assessments read" on public.coach_assessments;
create policy "own assessments read" on public.coach_assessments for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "own assessments delete" on public.coach_assessments;
create policy "own assessments delete" on public.coach_assessments for delete to authenticated using (user_id = (select auth.uid()));
-- coach_usage: deliberately no policy.

revoke all on public.coach_conversations, public.coach_chat_messages, public.coach_assessments, public.coach_usage from public, anon, authenticated;
grant select, delete on public.coach_conversations, public.coach_chat_messages, public.coach_assessments to authenticated;
grant select, insert, update, delete on public.coach_conversations, public.coach_chat_messages, public.coach_assessments, public.coach_usage to service_role;

-- ------------------------------------------------------------------ durable, atomic Coach rate limit (separate from biomarker extraction)
-- A per-user advisory lock serialises concurrent requests for the same user, so two simultaneous calls cannot both pass at the limit.
-- The clock is read after the lock is held (clock_timestamp, not the transaction start time). One row is recorded per allowed request.
create or replace function public.consume_coach_quota(p_user uuid, p_kind text, p_hour_limit integer default 30, p_day_limit integer default 150)
returns table (allowed boolean, remaining_hour integer, retry_after_seconds integer, usage_id uuid)
language plpgsql security invoker set search_path = public as $$
declare
  v_now    timestamptz;
  used_h   integer;
  used_d   integer;
  oldest_h timestamptz;
  oldest_d timestamptz;
  new_id   uuid;
  win_h    constant interval := interval '1 hour';
  win_d    constant interval := interval '24 hours';
begin
  if p_user is null or p_kind not in ('chat', 'plan', 'session', 'daily') or p_hour_limit is null or p_hour_limit < 1 or p_day_limit is null or p_day_limit < p_hour_limit then
    raise exception 'invalid arguments';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('coach:' || p_user::text, 0));
  v_now := clock_timestamp();
  delete from public.coach_usage where user_id = p_user and requested_at < v_now - interval '35 days';
  select count(*), min(requested_at) into used_h, oldest_h from public.coach_usage where user_id = p_user and requested_at >= v_now - win_h;
  select count(*), min(requested_at) into used_d, oldest_d from public.coach_usage where user_id = p_user and requested_at >= v_now - win_d;
  if used_h >= p_hour_limit then
    return query select false, 0, greatest(1, ceil(extract(epoch from (oldest_h + win_h - v_now)))::integer), null::uuid;
    return;
  end if;
  if used_d >= p_day_limit then
    return query select false, 0, greatest(1, ceil(extract(epoch from (oldest_d + win_d - v_now)))::integer), null::uuid;
    return;
  end if;
  insert into public.coach_usage (user_id, kind, requested_at) values (p_user, p_kind, v_now) returning id into new_id;
  return query select true, p_hour_limit - used_h - 1, 0, new_id;
end $$;

revoke all on function public.consume_coach_quota(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_coach_quota(uuid, text, integer, integer) to service_role;

-- Verification (run manually in staging):
--   select has_table_privilege('authenticated', 'public.coach_usage', 'SELECT');                                  -- false
--   select has_table_privilege('authenticated', 'public.coach_chat_messages', 'INSERT');                          -- false
--   select has_table_privilege('authenticated', 'public.coach_chat_messages', 'SELECT');                          -- true (own rows via RLS)
--   select has_function_privilege('authenticated', 'public.consume_coach_quota(uuid,text,integer,integer)', 'EXECUTE');   -- false
--   select has_function_privilege('service_role', 'public.consume_coach_quota(uuid,text,integer,integer)', 'EXECUTE');    -- true
--   select policyname, cmd from pg_policies where tablename like 'coach_%' order by 1;                           -- read + delete only