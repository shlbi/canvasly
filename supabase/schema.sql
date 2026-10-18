-- Run once in your own Supabase SQL editor. No public table reads/writes.
-- Supabase Auth handles passwords; this app never stores passwords.
create table if not exists public.canvasly_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  origin text not null, token_encrypted text not null, canvas_user_id bigint not null,
  name text not null, connection_key text not null, created_at timestamptz not null default now()
);
create table if not exists public.canvasly_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null, synced_at timestamptz not null default now()
);
create table if not exists public.canvasly_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_key text not null, course_id bigint not null, assignment_id bigint not null,
  title text not null, format text not null, notes text not null default '',
  stage text not null default 'created' check (stage in ('created','planning','planned','writing','written','reviewing','ready','submitting','submitted','needs_manual_check')),
  version integer not null default 0, revisions integer not null default 0,
  packet jsonb not null, plan jsonb, deliverable jsonb, review jsonb, last_usage jsonb,
  error text, submission_id bigint, submitted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists canvasly_drafts_user_updated on public.canvasly_drafts(user_id, updated_at desc);
create table if not exists public.canvasly_quota (
  bucket text primary key, hits integer not null default 1, created_at timestamptz not null default now()
);
alter table public.canvasly_connections enable row level security;
alter table public.canvasly_workspaces enable row level security;
alter table public.canvasly_drafts enable row level security;
alter table public.canvasly_quota enable row level security;
revoke all on public.canvasly_connections, public.canvasly_workspaces, public.canvasly_drafts, public.canvasly_quota from anon, authenticated;
grant all on public.canvasly_connections, public.canvasly_workspaces, public.canvasly_drafts, public.canvasly_quota to service_role;
-- Atomic increments enforce quotas even across concurrent serverless instances.
create or replace function public.canvasly_take_quota(p_bucket text, p_limit integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare used integer;
begin
  if p_limit < 1 or length(p_bucket) > 180 then return false; end if;
  insert into public.canvasly_quota(bucket, hits) values(p_bucket, 1)
  on conflict(bucket) do update set hits = canvasly_quota.hits + 1
  returning hits into used;
  return used <= p_limit;
end;
$$;
revoke all on function public.canvasly_take_quota(text, integer) from public, anon, authenticated;
grant execute on function public.canvasly_take_quota(text, integer) to service_role;
-- Maintenance (optional, run periodically):
-- delete from public.canvasly_quota where created_at < now() - interval '7 days';
