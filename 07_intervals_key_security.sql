-- 07: protect the Intervals.icu API key. Run once AFTER 05 and 06 and BEFORE deploying the new code.
-- Existing keys are kept: the server encrypts each legacy plaintext key the first time it is used (sync/connect).

alter table public.intervals_connections add column if not exists api_key_enc text;
alter table public.intervals_connections alter column api_key drop not null;

alter table public.intervals_connections enable row level security;
drop policy if exists "own connection" on public.intervals_connections;
drop policy if exists "own connection read" on public.intervals_connections;
create policy "own connection read" on public.intervals_connections
  for select using (auth.uid() = user_id);

-- Browsers (anon / signed-in users) may read only non-secret columns and may not write at all.
-- The key is written and read only by the server with the service-role key, which bypasses RLS.
revoke all on public.intervals_connections from anon, authenticated;
grant select (user_id, athlete_id, last_sync_at, created_at) on public.intervals_connections to authenticated;

-- Later, once everyone has synced or reconnected, this should return 0 (then api_key can be dropped):
-- select count(*) from public.intervals_connections where api_key is not null;
