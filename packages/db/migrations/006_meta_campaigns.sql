-- Additional Meta tables for comprehensive campaign coverage.
-- Run with: supabase db execute packages/db/migrations/006_meta_campaigns.sql

set check_function_bodies = off;

-- 1. Ensure meta_insights_levels has level + descriptive columns
alter table if exists meta_insights_levels
  add column if not exists level text default 'ad';

alter table if exists meta_insights_levels
  alter column level drop default;

alter table if exists meta_insights_levels
  add column if not exists campaign_name text;

alter table if exists meta_insights_levels
  add column if not exists adset_name text;

alter table if exists meta_insights_levels
  add column if not exists ad_name text;

alter table if exists meta_insights_levels
  add column if not exists objective text;

alter table if exists meta_insights_levels
  add column if not exists effective_status text;

alter table if exists meta_insights_levels
  add column if not exists configured_status text;

alter table if exists meta_insights_levels
  add column if not exists buying_type text;

alter table if exists meta_insights_levels
  add column if not exists daily_budget numeric;

alter table if exists meta_insights_levels
  add column if not exists lifetime_budget numeric;

-- 2. Campaign catalog table
create table if not exists meta_campaigns(
  tenant_id uuid not null references tenants(id) on delete cascade,
  id text not null,
  account_id text not null,
  name text,
  status text,
  effective_status text,
  configured_status text,
  objective text,
  buying_type text,
  start_time timestamptz,
  stop_time timestamptz,
  created_time timestamptz,
  updated_time timestamptz,
  daily_budget numeric,
  lifetime_budget numeric,
  budget_remaining numeric,
  special_ad_categories jsonb,
  issues_info jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (tenant_id, id)
);

create index if not exists meta_campaigns_account_idx on meta_campaigns(account_id);
create index if not exists meta_campaigns_status_idx on meta_campaigns(tenant_id, effective_status);

-- 3. Enable row level security and policies matching other meta tables
alter table if exists meta_campaigns enable row level security;

do $$
begin
  begin
    execute $p$
      create policy meta_campaigns_read on meta_campaigns
        for select using (is_member_of(tenant_id));
    $p$;
  exception when duplicate_object then
    null;
  end;

  begin
    execute $p$
      create policy meta_campaigns_write on meta_campaigns
        for insert with check (
          exists(
            select 1
            from members m
            where m.tenant_id = meta_campaigns.tenant_id
              and m.user_id = auth.uid()
              and m.role in ('platform_admin','admin')
          )
        );
    $p$;
  exception when duplicate_object then
    null;
  end;
end $$;


