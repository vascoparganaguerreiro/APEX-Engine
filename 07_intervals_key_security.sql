-- 07: protect the Intervals.icu API key. Run once AFTER 05 and 06 and BEFORE deploying the new code.
-- Design: encrypted keys live in a SEPARATE server-only table that browsers cannot touch at all, instead of
-- relying on column-level grants of a table that browsers can query. Existing plaintext keys are kept until
-- the server has encrypted AND verified them (it clears the legacy column itself, see lib/connectionStore.ts).

-- 1) Server-only credentials table. RLS enabled with NO policies = deny for every non-bypass role.
create table if not exists public.intervals_credentials (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  api_key_enc text not null,
  key_version integer not null default 1,
  updated_at  timestamptz not null default now()
);
alter table public.intervals_credentials enable row level security;
alter table public.intervals_credentials force row level security;
drop policy if exists "own credentials" on public.intervals_credentials;      -- there must be none
revoke all on public.intervals_credentials from public, anon, authenticated;
-- service_role (server only) keeps its default privileges and bypasses RLS.

-- 2) intervals_connections: browsers may read only non-secret columns and may not write.
alter table public.intervals_connections alter column api_key drop not null;  -- legacy column, emptied by the server
alter table public.intervals_connections enable row level security;
drop policy if exists "own connection" on public.intervals_connections;
drop policy if exists "own connection read" on public.intervals_connections;
create policy "own connection read" on public.intervals_connections for select using (auth.uid() = user_id);
revoke all on public.intervals_connections from public, anon, authenticated;
grant select (user_id, athlete_id, last_sync_at, created_at) on public.intervals_connections to authenticated;

-- 3) Verification (run manually; each must fail with "permission denied"):
--   set role authenticated; select api_key from public.intervals_connections;
--   set role authenticated; select * from public.intervals_connections;
--   set role authenticated; select * from public.intervals_credentials;
--   reset role;
-- And this must list ONLY the four safe columns for authenticated/anon, and nothing for intervals_credentials:
--   select grantee, table_name, column_name, privilege_type from information_schema.column_privileges
--   where table_name in ('intervals_connections','intervals_credentials') and grantee in ('anon','authenticated','PUBLIC');

-- 4) After every user has synced or reconnected once, this must return 0; then the plaintext column can go:
--   select count(*) from public.intervals_connections where api_key is not null;
--   alter table public.intervals_connections drop column api_key;
