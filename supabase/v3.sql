-- Canvasly public paid service. Additive migration: does not delete v1/v2 records.
-- Execute as the project database owner in the Supabase SQL editor.
begin;

create table if not exists public.canvasly_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);
create table if not exists public.canvasly_plans (
  id text primary key, name text not null, price_cents integer not null,
  model_call_limit bigint check(model_call_limit is null or model_call_limit > 0)
);
insert into public.canvasly_plans(id,name,price_cents,model_call_limit)
values ('starter','Canvasly',2000,null) on conflict(id) do nothing;
-- NULL is deliberate: the owner has not chosen a monthly allowance. Never advertise unlimited.
create table if not exists public.canvasly_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique
);
create table if not exists public.canvasly_subscriptions (
  subscription_id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  plan_id text not null references public.canvasly_plans(id), price_id text not null,
  status text not null, period_start timestamptz not null, period_end timestamptz not null,
  cancel_at_period_end boolean not null default false, event_created bigint not null default 0
);
create index if not exists canvasly_subscription_user on public.canvasly_subscriptions(user_id);
create table if not exists public.canvasly_usage (
  call_id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null, period_start timestamptz not null,
  input_tokens bigint not null default 0 check(input_tokens >= 0),
  output_tokens bigint not null default 0 check(output_tokens >= 0),
  completed boolean not null default false, created_at timestamptz not null default now()
);
create index if not exists canvasly_usage_period on public.canvasly_usage(user_id,period_start);
create table if not exists public.canvasly_queue (
  user_id uuid primary key references auth.users(id) on delete cascade,
  available_at timestamptz not null default now(), lease_id uuid, lease_until timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists canvasly_queue_available on public.canvasly_queue(available_at);
create table if not exists public.canvasly_workers (
  worker_id text primary key, heartbeat_at timestamptz not null default now()
);
create table if not exists public.canvasly_rates (
  bucket text primary key, hits integer not null, expires_at timestamptz not null
);
create table if not exists public.canvasly_stripe_events (
  id text primary key, created bigint not null, processed_at timestamptz not null default now()
);
create table if not exists public.canvasly_oauth_clients (
  client_id text primary key, name text not null, redirect_uris jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists public.canvasly_oauth_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null references public.canvasly_oauth_clients(client_id) on delete cascade,
  resource text not null, scopes text[] not null, revoked_at timestamptz, created_at timestamptz not null default now(),
  unique(user_id, client_id)
);
create table if not exists public.canvasly_oauth_requests (
  id uuid primary key, client_id text not null references public.canvasly_oauth_clients(client_id) on delete cascade,
  redirect_uri text not null, resource text not null, scopes text[] not null,
  challenge text not null, state text not null, status text not null default 'pending',
  user_id uuid references auth.users(id) on delete cascade,
  grant_id uuid references public.canvasly_oauth_grants(id) on delete cascade,
  code_hash text unique, used_at timestamptz,
  expires_at timestamptz not null default (now()+interval '10 minutes')
);
create table if not exists public.canvasly_oauth_tokens (
  hash text primary key, kind text not null check(kind in ('access','refresh')),
  grant_id uuid not null references public.canvasly_oauth_grants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null, resource text not null, scopes text[] not null,
  expires_at timestamptz not null, used_at timestamptz
);
create index if not exists canvasly_oauth_token_grant on public.canvasly_oauth_tokens(grant_id);

-- Read an account's active subscription and the actual usage in that billing period.
create or replace function public.canvasly_entitlement(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.canvasly_subscriptions; p public.canvasly_plans; used bigint;
begin
  select * into s from public.canvasly_subscriptions where user_id=p_user
    order by (status in ('active','trialing') and period_end>now()) desc, period_end desc limit 1;
  if not found then return jsonb_build_object('active',false,'status','none','price_cents',2000); end if;
  select * into p from public.canvasly_plans where id=s.plan_id;
  select count(*) into used from public.canvasly_usage where user_id=p_user and period_start=s.period_start;
  return jsonb_build_object('active',s.status in ('active','trialing') and s.period_end>now(),
    'status',s.status,'plan',p.name,'price_cents',p.price_cents,'period_end',s.period_end,
    'cancel_at_period_end',s.cancel_at_period_end,'model_calls',used,'model_call_limit',p.model_call_limit);
end $$;

-- Serialize reservations per account so parallel website/MCP jobs cannot overspend a configured cap.
create or replace function public.canvasly_reserve_model(p_user uuid,p_call uuid,p_job uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare s public.canvasly_subscriptions; maximum bigint; used bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
  select * into s from public.canvasly_subscriptions where user_id=p_user and status in ('active','trialing') and period_end>now() order by period_end desc limit 1;
  if not found then return false; end if;
  if exists(select 1 from public.canvasly_usage where call_id=p_call and user_id=p_user) then return true; end if;
  select model_call_limit into maximum from public.canvasly_plans where id=s.plan_id;
  select count(*) into used from public.canvasly_usage where user_id=p_user and period_start=s.period_start;
  if maximum is not null and used>=maximum then return false; end if;
  insert into public.canvasly_usage(call_id,user_id,job_id,period_start) values(p_call,p_user,p_job,s.period_start);
  return true;
end $$;

-- Wake a saved workspace transactionally: no job can be stored but lost between two API calls.
create or replace function public.canvasly_wake_workspace() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from jsonb_array_elements(coalesce(new.data->'jobs','[]'::jsonb)) j where j->>'status'='queued') then
    insert into public.canvasly_queue(user_id) values(new.user_id)
    on conflict(user_id) do update set available_at=least(public.canvasly_queue.available_at,now()),updated_at=now();
  end if;
  return new;
end $$;
drop trigger if exists canvasly_workspace_queue on public.canvasly_workspaces;
create trigger canvasly_workspace_queue after insert or update of data on public.canvasly_workspaces for each row execute function public.canvasly_wake_workspace();

-- Claim one fair, durable work lease without waiting for another worker's locked rows.
create or replace function public.canvasly_claim_work() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.canvasly_queue;
begin
  select * into q from public.canvasly_queue where available_at<=now() and (lease_until is null or lease_until<now()) order by available_at,user_id for update skip locked limit 1;
  if not found then return null; end if;
  update public.canvasly_queue set lease_id=gen_random_uuid(),lease_until=now()+interval '300 seconds',updated_at=now() where user_id=q.user_id returning * into q;
  return to_jsonb(q);
end $$;

-- Release only the matching lease; stale workers cannot remove another worker's queue entry.
create or replace function public.canvasly_release_work(p_user uuid,p_lease uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare d jsonb;
begin
  perform 1 from public.canvasly_queue where user_id=p_user and lease_id=p_lease for update;
  if not found then return; end if;
  select data into d from public.canvasly_workspaces where user_id=p_user;
  if exists(select 1 from jsonb_array_elements(coalesce(d->'jobs','[]'::jsonb)) j where j->>'status' in ('queued','running')) then
    update public.canvasly_queue set lease_id=null,lease_until=null,available_at=now()+interval '2 seconds',updated_at=now() where user_id=p_user and lease_id=p_lease;
  else delete from public.canvasly_queue where user_id=p_user and lease_id=p_lease; end if;
end $$;

-- Database-clock abuse throttling; separate from any paid-plan customer allowance.
create or replace function public.canvasly_rate(p_bucket text,p_limit integer,p_seconds integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if p_limit<1 or p_limit>10000 or p_seconds<1 or p_seconds>3600 then return false; end if;
  insert into public.canvasly_rates(bucket,hits,expires_at) values(p_bucket,1,now()+make_interval(secs=>p_seconds))
  on conflict(bucket) do update set hits=case when public.canvasly_rates.expires_at<=now() then 1 else public.canvasly_rates.hits+1 end,
    expires_at=case when public.canvasly_rates.expires_at<=now() then now()+make_interval(secs=>p_seconds) else public.canvasly_rates.expires_at end
  returning hits into n;
  return n<=p_limit;
end $$;

-- Apply authoritative Stripe state once, ignoring older events and retaining canceled receipts.
create or replace function public.canvasly_apply_subscription(p_event text,p_created bigint,p_user uuid,p_subscription text,p_price text,p_status text,p_start timestamptz,p_end timestamptz,p_cancel boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.canvasly_stripe_events(id,created) values(p_event,p_created) on conflict(id) do nothing;
  if not found then return; end if;
  insert into public.canvasly_subscriptions(subscription_id,user_id,plan_id,price_id,status,period_start,period_end,cancel_at_period_end,event_created)
  values(p_subscription,p_user,'starter',p_price,p_status,p_start,p_end,p_cancel,p_created)
  on conflict(subscription_id) do update set status=excluded.status,period_start=excluded.period_start,period_end=excluded.period_end,cancel_at_period_end=excluded.cancel_at_period_end,event_created=excluded.event_created,price_id=excluded.price_id
  where public.canvasly_subscriptions.user_id=excluded.user_id and public.canvasly_subscriptions.event_created<=excluded.event_created;
end $$;

-- Bind consent to a verified account, exact client, resource, redirect and requested scope set.
create or replace function public.canvasly_oauth_approve(p_request uuid,p_user uuid,p_code_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.canvasly_oauth_requests; g uuid;
begin
  select * into r from public.canvasly_oauth_requests where id=p_request and status='pending' and expires_at>now() for update;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text||r.client_id,1));
  -- Re-consent replaces the whole token family; old revoked tokens must never become valid again.
  delete from public.canvasly_oauth_grants where user_id=p_user and client_id=r.client_id;
  insert into public.canvasly_oauth_grants(user_id,client_id,resource,scopes) values(p_user,r.client_id,r.resource,r.scopes) returning id into g;
  update public.canvasly_oauth_requests set user_id=p_user,grant_id=g,code_hash=p_code_hash,status='approved' where id=p_request;
  return jsonb_build_object('redirect_uri',r.redirect_uri,'state',r.state);
end $$;

-- Consume a code exactly once with PKCE and audience binding, inserting only hashed opaque tokens.
create or replace function public.canvasly_oauth_exchange(p_code text,p_client text,p_redirect text,p_resource text,p_challenge text,p_access text,p_refresh text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.canvasly_oauth_requests;
begin
  select * into r from public.canvasly_oauth_requests where code_hash=p_code for update;
  if not found or r.status<>'approved' or r.used_at is not null or r.expires_at<=now() or r.client_id<>p_client or r.redirect_uri<>p_redirect or r.resource<>p_resource or r.challenge<>p_challenge then return null; end if;
  if exists(select 1 from public.canvasly_oauth_grants where id=r.grant_id and revoked_at is not null) then return null; end if;
  update public.canvasly_oauth_requests set used_at=now() where id=r.id;
  insert into public.canvasly_oauth_tokens(hash,kind,grant_id,user_id,client_id,resource,scopes,expires_at) values
    (p_access,'access',r.grant_id,r.user_id,r.client_id,r.resource,r.scopes,now()+interval '1 hour'),
    (p_refresh,'refresh',r.grant_id,r.user_id,r.client_id,r.resource,r.scopes,now()+interval '30 days');
  return jsonb_build_object('scope',array_to_string(r.scopes,' '));
end $$;

-- Rotate refresh tokens; replay revokes the grant family without rolling that revocation back.
create or replace function public.canvasly_oauth_refresh(p_token text,p_client text,p_resource text,p_access text,p_refresh text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.canvasly_oauth_tokens;
begin
  select * into t from public.canvasly_oauth_tokens where hash=p_token and kind='refresh' for update;
  if not found or t.client_id<>p_client or t.resource<>p_resource then return null; end if;
  if t.used_at is not null then update public.canvasly_oauth_grants set revoked_at=now() where id=t.grant_id; return null; end if;
  if t.expires_at<=now() or not exists(select 1 from public.canvasly_oauth_grants where id=t.grant_id and revoked_at is null) then return null; end if;
  update public.canvasly_oauth_tokens set used_at=now() where hash=p_token;
  insert into public.canvasly_oauth_tokens(hash,kind,grant_id,user_id,client_id,resource,scopes,expires_at) values
    (p_access,'access',t.grant_id,t.user_id,t.client_id,t.resource,t.scopes,now()+interval '1 hour'),
    (p_refresh,'refresh',t.grant_id,t.user_id,t.client_id,t.resource,t.scopes,now()+interval '30 days');
  return jsonb_build_object('scope',array_to_string(t.scopes,' '));
end $$;

-- Validate an MCP access token on every request, respecting grant revocation and user bans.
create or replace function public.canvasly_mcp_identity(p_token text,p_resource text) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('user_id',t.user_id,'client_id',t.client_id,'scopes',
    (select coalesce(jsonb_agg(s),'[]'::jsonb) from unnest(t.scopes) s where s=any(g.scopes)))
  from public.canvasly_oauth_tokens t join public.canvasly_oauth_grants g on g.id=t.grant_id join auth.users u on u.id=t.user_id
  where t.hash=p_token and t.kind='access' and t.resource=p_resource and t.expires_at>now() and g.revoked_at is null
    and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until<now()) limit 1;
$$;

-- Revoke either kind of token without revealing whether a supplied token existed.
create or replace function public.canvasly_oauth_revoke(p_token text,p_client text) returns void
language sql security definer set search_path = '' as $$
  update public.canvasly_oauth_grants set revoked_at=now() where id in
    (select grant_id from public.canvasly_oauth_tokens where hash=p_token and client_id=p_client);
$$;

-- Bound ephemeral metadata growth; retained usage/subscriptions are not deleted here.
create or replace function public.canvasly_cleanup() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.canvasly_rates where expires_at<now()-interval '1 day';
  delete from public.canvasly_oauth_requests where expires_at<now()-interval '1 day';
  delete from public.canvasly_oauth_tokens where expires_at<now()-interval '7 days';
  delete from public.canvasly_workers where heartbeat_at<now()-interval '7 days';
end $$;

-- Private service-only data. Browser and MCP tokens cannot query these tables directly.
do $$ declare t text; f record;
begin
  foreach t in array array['canvasly_workspaces','canvasly_plans','canvasly_customers','canvasly_subscriptions','canvasly_usage','canvasly_queue','canvasly_workers','canvasly_rates','canvasly_stripe_events','canvasly_oauth_clients','canvasly_oauth_grants','canvasly_oauth_requests','canvasly_oauth_tokens'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  for f in select p.oid::regprocedure as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
    ('canvasly_entitlement','canvasly_reserve_model','canvasly_wake_workspace','canvasly_claim_work','canvasly_release_work','canvasly_rate','canvasly_apply_subscription','canvasly_oauth_approve','canvasly_oauth_exchange','canvasly_oauth_refresh','canvasly_mcp_identity','canvasly_oauth_revoke','canvasly_cleanup') loop
    execute format('revoke all on function %s from public, anon, authenticated',f.name);
    execute format('grant execute on function %s to service_role',f.name);
  end loop;
end $$;
commit;
