-- Additive migration: does NOT merge old email-based accounts with ChatGPT identities.
-- All access is authenticated server-side; no browser Supabase SDK/key is needed.
create table if not exists public.canvasly_v2_records (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  version bigint not null default 1,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.canvasly_v2_records enable row level security;
revoke all on public.canvasly_v2_records from anon, authenticated;
grant select, insert, update, delete on public.canvasly_v2_records to service_role;
-- CAS writes use WHERE id=... AND version=... and increment version atomically.
-- Configure retention/backups for your private beta. OAuth transaction/rate-limit
-- records are deliberately not workspace-indexed. Periodically purge old transient
-- rows, identified by data ? 'sealed' (OAuth) or data ? 'calls' (pre-login quota).
