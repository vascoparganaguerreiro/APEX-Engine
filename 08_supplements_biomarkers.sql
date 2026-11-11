-- 08: Supplements and blood biomarkers. NOT applied automatically: review, then run once in the Supabase SQL Editor
-- (staging first). Additive only: creates new tables, functions, a private storage bucket and policies.
-- Every row belongs to one user (user_id default auth.uid()) and is protected by row level security.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ helpers
create or replace function public.health_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ------------------------------------------------------------------ supplements
create table if not exists public.supplements (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name                  text not null check (char_length(btrim(name)) between 1 and 120),
  brand                 text check (char_length(brand) <= 120),
  ingredients           text check (char_length(ingredients) <= 500),
  formulation           text check (formulation in ('capsule','tablet','powder','liquid','softgel','gummy','spray','injection','other')),
  dose                  numeric check (dose > 0),
  dose_unit             text check (dose_unit in ('mg','mcg','g','IU','ml','drops','other')),
  notes                 text check (char_length(notes) <= 2000),
  start_date            date not null default current_date,
  end_date              date,
  status                text not null default 'active' check (status in ('active','discontinued')),
  discontinuation_reason text check (char_length(discontinuation_reason) <= 500),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint supplements_dates_ok check (end_date is null or end_date >= start_date),
  constraint supplements_discontinued_has_end check (status = 'active' or end_date is not null)
);
create index if not exists supplements_user_status_idx on public.supplements (user_id, status, start_date desc);
drop trigger if exists supplements_touch on public.supplements;
create trigger supplements_touch before update on public.supplements for each row execute function public.health_touch_updated_at();

-- Edits never destroy history: the previous version of a supplement is kept on every update.
create table if not exists public.supplement_revisions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  supplement_id uuid not null references public.supplements(id) on delete no action,
  changed_at    timestamptz not null default now(),
  snapshot      jsonb not null
);
create index if not exists supplement_revisions_idx on public.supplement_revisions (supplement_id, changed_at desc);
create or replace function public.log_supplement_revision() returns trigger language plpgsql as $$
begin
  if to_jsonb(old) - 'updated_at' is distinct from to_jsonb(new) - 'updated_at' then
    insert into public.supplement_revisions (user_id, supplement_id, snapshot) values (old.user_id, old.id, to_jsonb(old));
  end if;
  return new;
end $$;
drop trigger if exists supplements_revision on public.supplements;
create trigger supplements_revision before update on public.supplements for each row execute function public.log_supplement_revision();

-- Versioned schedule: one dose per supplement and slot, valid for a date range and chosen weekdays (ISO 1=Mon..7=Sun).
create table if not exists public.supplement_schedules (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  supplement_id uuid not null references public.supplements(id) on delete no action,
  slot          text not null check (slot in ('morning','lunch','dinner')),
  dose          numeric not null check (dose > 0),
  dose_unit     text not null check (dose_unit in ('mg','mcg','g','IU','ml','drops','other')),
  days          smallint[] not null default '{1,2,3,4,5,6,7}',
  valid_from    date not null default current_date,
  valid_to      date,
  created_at    timestamptz not null default now(),
  constraint schedules_days_ok check (cardinality(days) > 0 and days <@ array[1,2,3,4,5,6,7]::smallint[]),
  constraint schedules_range_ok check (valid_to is null or valid_to >= valid_from),
  constraint schedules_one_per_slot unique (supplement_id, slot, valid_from)
);
create index if not exists supplement_schedules_idx on public.supplement_schedules (user_id, supplement_id, valid_from);

-- Intake history. "Not yet taken" is the absence of a row. dose/unit are snapshots, so later schedule edits never rewrite history.
create table if not exists public.supplement_intakes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  supplement_id uuid not null references public.supplements(id) on delete no action,
  slot          text not null check (slot in ('morning','lunch','dinner')),
  day           date not null,
  status        text not null check (status in ('taken','skipped')),
  dose          numeric check (dose > 0),
  dose_unit     text check (dose_unit in ('mg','mcg','g','IU','ml','drops','other')),
  logged_at     timestamptz not null default now(),
  constraint intakes_unique unique (user_id, supplement_id, slot, day)
);
create index if not exists supplement_intakes_idx on public.supplement_intakes (user_id, day desc);

-- ------------------------------------------------------------------ blood panels and results
create table if not exists public.blood_panels (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  collected_on    date not null check (collected_on <= current_date + 1),
  lab_name        text check (char_length(lab_name) <= 120),
  notes           text check (char_length(notes) <= 2000),
  source          text not null default 'manual' check (source in ('manual','document')),
  report_path     text check (char_length(report_path) <= 300),
  report_filename text check (char_length(report_filename) <= 200),
  report_sha256   text check (report_sha256 ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- A report path must live inside the owner's own storage folder ("<user id>/<file>"), with no path tricks.
alter table public.blood_panels drop constraint if exists blood_panels_report_path_own_folder;
alter table public.blood_panels add constraint blood_panels_report_path_own_folder check (
  report_path is null or (left(report_path, 37) = user_id::text || '/' and char_length(report_path) > 37 and position('..' in report_path) = 0));
create index if not exists blood_panels_user_date_idx on public.blood_panels (user_id, collected_on desc);
create unique index if not exists blood_panels_report_unique on public.blood_panels (user_id, report_sha256) where report_sha256 is not null;
drop trigger if exists blood_panels_touch on public.blood_panels;
create trigger blood_panels_touch before update on public.blood_panels for each row execute function public.health_touch_updated_at();

create table if not exists public.biomarker_results (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  panel_id      uuid not null references public.blood_panels(id) on delete cascade,
  original_name text not null check (char_length(btrim(original_name)) between 1 and 160),
  marker_key    text check (char_length(marker_key) <= 60),            -- normalized identity, only when confidently recognised
  value         numeric not null,
  unit          text not null check (char_length(btrim(unit)) between 1 and 30),   -- the laboratory's original unit
  ref_low       numeric,
  ref_high      numeric,
  flag          text check (char_length(flag) <= 40),                  -- laboratory's own interpretation, if printed
  source        text not null default 'manual' check (source in ('manual','document')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint results_ref_ok check (ref_low is null or ref_high is null or ref_low <= ref_high)
);
create index if not exists biomarker_results_user_marker_idx on public.biomarker_results (user_id, marker_key);
create index if not exists biomarker_results_panel_idx on public.biomarker_results (panel_id);
create unique index if not exists biomarker_results_dedupe on public.biomarker_results (panel_id, lower(btrim(original_name)), lower(btrim(unit)));
drop trigger if exists biomarker_results_touch on public.biomarker_results;
create trigger biomarker_results_touch before update on public.biomarker_results for each row execute function public.health_touch_updated_at();

-- ------------------------------------------------------------------ row level security
alter table public.supplements          enable row level security;
alter table public.supplement_revisions enable row level security;
alter table public.supplement_schedules enable row level security;
alter table public.supplement_intakes   enable row level security;
alter table public.blood_panels         enable row level security;
alter table public.biomarker_results    enable row level security;

drop policy if exists "own supplements" on public.supplements;
create policy "own supplements" on public.supplements for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own revisions read" on public.supplement_revisions;
create policy "own revisions read" on public.supplement_revisions for select to authenticated using (user_id = auth.uid());
drop policy if exists "own revisions insert" on public.supplement_revisions;
create policy "own revisions insert" on public.supplement_revisions for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.supplements s where s.id = supplement_id and s.user_id = auth.uid()));

-- Child rows must also point at a parent row owned by the same user.
drop policy if exists "own schedules" on public.supplement_schedules;
create policy "own schedules" on public.supplement_schedules for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.supplements s where s.id = supplement_id and s.user_id = auth.uid()));

drop policy if exists "own intakes" on public.supplement_intakes;
create policy "own intakes" on public.supplement_intakes for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.supplements s where s.id = supplement_id and s.user_id = auth.uid()));

drop policy if exists "own panels" on public.blood_panels;
create policy "own panels" on public.blood_panels for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own results" on public.biomarker_results;
create policy "own results" on public.biomarker_results for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.blood_panels p where p.id = panel_id and p.user_id = auth.uid()));

-- Start from nothing: Supabase's default grants give anon/authenticated ALL (including TRUNCATE, REFERENCES, TRIGGER).
-- Remove them all, then grant back exactly the CRUD the app needs to signed-in users. RLS still limits every row to its owner.
revoke all on public.supplements, public.supplement_revisions, public.supplement_schedules, public.supplement_intakes,
              public.blood_panels, public.biomarker_results from public, anon, authenticated;
grant select, insert, update, delete on public.supplements, public.supplement_schedules, public.supplement_intakes,
              public.blood_panels, public.biomarker_results to authenticated;
grant select, insert on public.supplement_revisions to authenticated;   -- history is append-only for users

-- ------------------------------------------------------------------ atomic functions (SECURITY INVOKER: RLS applies)
-- Replace a supplement's schedule without touching history. p_effective is the CALLER'S local calendar date (not the
-- server's): versions that started before it are closed the day before; versions starting on or after it are replaced.
-- Past intake logs keep their own dose snapshot. Time zones differ from UTC by at most one day, so a date further
-- than one day from the server's date is rejected.
create or replace function public.replace_supplement_schedule(p_supplement uuid, p_rows jsonb, p_effective date)
returns integer language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_effective is null or abs(p_effective - current_date) > 1 then raise exception 'invalid effective date'; end if;
  if not exists (select 1 from public.supplements where id = p_supplement and user_id = auth.uid()) then
    raise exception 'supplement not found';
  end if;
  delete from public.supplement_schedules where supplement_id = p_supplement and valid_from >= p_effective;
  update public.supplement_schedules set valid_to = p_effective - 1
    where supplement_id = p_supplement and (valid_to is null or valid_to >= p_effective);
  insert into public.supplement_schedules (user_id, supplement_id, slot, dose, dose_unit, days, valid_from)
  select auth.uid(), p_supplement, r.slot, r.dose, r.dose_unit, r.days, p_effective
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(slot text, dose numeric, dose_unit text, days smallint[]);
  get diagnostics n = row_count;
  return n;
end $$;

-- Create a blood panel and its results in one transaction (manual entry or confirmed document import).
create or replace function public.save_blood_panel(p_panel jsonb, p_results jsonb)
returns uuid language plpgsql security invoker set search_path = public as $$
declare pid uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.blood_panels (user_id, collected_on, lab_name, notes, source, report_path, report_filename, report_sha256)
  values (auth.uid(), (p_panel->>'collected_on')::date, nullif(btrim(p_panel->>'lab_name'), ''), nullif(btrim(p_panel->>'notes'), ''),
          coalesce(p_panel->>'source', 'manual'), nullif(p_panel->>'report_path', ''), nullif(p_panel->>'report_filename', ''),
          nullif(p_panel->>'report_sha256', ''))
  returning id into pid;
  insert into public.biomarker_results (user_id, panel_id, original_name, marker_key, value, unit, ref_low, ref_high, flag, source)
  select auth.uid(), pid, btrim(r.original_name), nullif(r.marker_key, ''), r.value, btrim(r.unit), r.ref_low, r.ref_high,
         nullif(btrim(r.flag), ''), coalesce(r.source, 'manual')
  from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb))
       as r(original_name text, marker_key text, value numeric, unit text, ref_low numeric, ref_high numeric, flag text, source text);
  return pid;
end $$;

revoke all on function public.replace_supplement_schedule(uuid, jsonb, date) from public, anon;
revoke all on function public.save_blood_panel(jsonb, jsonb) from public, anon;
grant execute on function public.replace_supplement_schedule(uuid, jsonb, date) to authenticated;
grant execute on function public.save_blood_panel(jsonb, jsonb) to authenticated;

-- ------------------------------------------------------------------ private storage for original lab reports
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lab-reports', 'lab-reports', false, 10485760, array['application/pdf','image/png','image/jpeg','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['application/pdf','image/png','image/jpeg','image/webp'];

-- Objects live under "<user id>/<file>"; a user can only touch their own folder. No update policy: reports are immutable.
drop policy if exists "lab reports read"   on storage.objects;
drop policy if exists "lab reports insert" on storage.objects;
drop policy if exists "lab reports delete" on storage.objects;
create policy "lab reports read"   on storage.objects for select to authenticated
  using (bucket_id = 'lab-reports' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "lab reports insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'lab-reports' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "lab reports delete" on storage.objects for delete to authenticated
  using (bucket_id = 'lab-reports' and (storage.foldername(name))[1] = auth.uid()::text);

-- ------------------------------------------------------------------ verification (run manually in staging)
-- RLS on, and no anon access:
--   select relname, relrowsecurity from pg_class where relname in ('supplements','supplement_schedules','supplement_intakes','supplement_revisions','blood_panels','biomarker_results');
--   select has_table_privilege('anon', 'public.blood_panels', 'SELECT');           -- false
-- Bucket is private:  select id, public from storage.buckets where id = 'lab-reports';   -- false
-- Isolation: as user A insert a panel, then as user B (set_config('request.jwt.claims', '{"sub":"<B uuid>"}', true)) select from it: 0 rows.
