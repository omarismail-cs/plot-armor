-- Plot Armor: false-positive reports from extension "not a spoiler?" feedback.
-- Run in Supabase SQL Editor (Dashboard → SQL → New query).

create table if not exists public.false_positive_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  report_id text,
  show_title text,
  page_url text,
  snippet text,
  reason text,
  confidence double precision,
  source text,
  detector_version text,
  extension_version text,
  raw jsonb not null default '{}'::jsonb
);

create index if not exists false_positive_reports_created_at_idx
  on public.false_positive_reports (created_at desc);

create index if not exists false_positive_reports_show_title_idx
  on public.false_positive_reports (show_title);

-- No public API access; Edge Function inserts with service role only.
alter table public.false_positive_reports enable row level security;
