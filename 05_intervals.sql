-- Run once in the Supabase SQL Editor. Lets the Intervals.icu sync import activities without duplicates.
alter table public.activities add column if not exists external_id text;
create unique index if not exists activities_user_external_idx on public.activities (user_id, external_id);

-- intervals_connections holds the API key: make sure only the owner can touch it.
alter table public.intervals_connections enable row level security;
drop policy if exists "own connection" on public.intervals_connections;
create policy "own connection" on public.intervals_connections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
