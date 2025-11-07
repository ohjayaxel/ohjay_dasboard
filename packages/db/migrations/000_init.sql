-- Core schema for Orange Juice multi-tenant analytics platform.
-- Execute with Supabase CLI: supabase db execute packages/db/migrations/000_init.sql

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

create table tenants(
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  created_at timestamptz default now()
);

create table members(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('platform_admin','admin','editor','viewer')),
  unique (tenant_id, user_id)
);

create table connections(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source text not null check (source in ('meta','google_ads','shopify')),
  status text not null default 'disconnected',
  access_token_enc bytea,
  refresh_token_enc bytea,
  expires_at timestamptz,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table meta_insights_daily(
  tenant_id uuid not null references tenants(id) on delete cascade,
  date date not null,
  ad_account_id text not null,
  campaign_id text,
  adset_id text,
  ad_id text,
  spend numeric,
  impressions bigint,
  clicks bigint,
  purchases bigint,
  revenue numeric,
  primary key (tenant_id, date, ad_account_id, campaign_id, adset_id, ad_id)
);

create table google_insights_daily(
  tenant_id uuid not null references tenants(id) on delete cascade,
  date date not null,
  customer_id text not null,
  campaign_id text,
  adgroup_id text,
  ad_id text,
  cost_micros bigint,
  impressions bigint,
  clicks bigint,
  conversions numeric,
  revenue numeric,
  primary key (tenant_id, date, customer_id, campaign_id, adgroup_id, ad_id)
);

create table shopify_orders(
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id text not null,
  processed_at date,
  total_price numeric,
  discount_total numeric,
  currency text,
  customer_id text,
  is_refund bool default false,
  primary key (tenant_id, order_id)
);

create table kpi_daily(
  tenant_id uuid not null references tenants(id) on delete cascade,
  date date not null,
  source text not null check (source in ('meta','google_ads','shopify','all')),
  spend numeric,
  clicks numeric,
  conversions numeric,
  revenue numeric,
  aov numeric,
  cos numeric,
  roas numeric,
  primary key (tenant_id, date, source)
);

create table jobs_log(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  source text not null check (source in ('meta','google_ads','shopify')),
  status text not null check (status in ('pending','running','succeeded','failed')),
  started_at timestamptz default now(),
  finished_at timestamptz,
  error text
);

create index on members (tenant_id, user_id);
create index on connections (tenant_id, source);
create index on meta_insights_daily (tenant_id, date);
create index on google_insights_daily (tenant_id, date);
create index on shopify_orders (tenant_id, processed_at);
create index on kpi_daily (tenant_id, date);
create index on jobs_log (tenant_id, started_at);

