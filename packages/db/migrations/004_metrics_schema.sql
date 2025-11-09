-- Enhanced metrics schema for multi-channel analytics.
-- Run with: supabase db execute packages/db/migrations/004_metrics_schema.sql

set check_function_bodies = off;

-- 1. Fact tables per channel with richer schema

create table if not exists meta_accounts(
  id text primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text,
  currency text,
  status text,
  business_id text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists meta_accounts_tenant_idx on meta_accounts(tenant_id);

create table if not exists meta_insights_levels(
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  ad_account_id text not null references meta_accounts(id) on delete cascade,
  date date not null,
  campaign_id text,
  adset_id text,
  ad_id text,
  currency text,
  spend numeric,
  impressions bigint,
  clicks bigint,
  purchases bigint,
  add_to_cart bigint,
  revenue numeric,
  leads bigint,
  reach bigint,
  frequency numeric,
  cpm numeric,
  cpc numeric,
  ctr numeric,
  roas numeric,
  cos numeric,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists meta_insights_levels_tenant_date_idx on meta_insights_levels(tenant_id, date);
create index if not exists meta_insights_levels_account_date_idx on meta_insights_levels(ad_account_id, date);


create table if not exists google_ads_customers(
  id text primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  descriptive_name text,
  currency_code text,
  timezone text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists google_ads_customers_tenant_idx on google_ads_customers(tenant_id);

create table if not exists google_insights_fact(
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id text not null references google_ads_customers(id) on delete cascade,
  date date not null,
  campaign_id text,
  ad_group_id text,
  ad_id text,
  currency text,
  cost_micros bigint,
  impressions bigint,
  clicks bigint,
  conversions numeric,
  conversions_value numeric,
  all_conversions numeric,
  all_conversions_value numeric,
  conversions_value_per_cost numeric,
  cost_per_conversion numeric,
  ctr numeric,
  average_cpc numeric,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists google_insights_fact_tenant_date_idx on google_insights_fact(tenant_id, date);
create index if not exists google_insights_fact_customer_date_idx on google_insights_fact(customer_id, date);


create table if not exists shopify_shops(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  domain text,
  name text,
  currency text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (tenant_id, external_id)
);

create index if not exists shopify_shops_tenant_idx on shopify_shops(tenant_id);

create table if not exists shopify_orders_fact(
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  shop_id uuid not null references shopify_shops(id) on delete cascade,
  order_id text not null,
  processed_at date,
  total_price numeric,
  subtotal_price numeric,
  total_tax numeric,
  total_discount numeric,
  currency text,
  customer_id text,
  financial_status text,
  fulfillment_status text,
  line_items jsonb default '[]'::jsonb,
  tags text[],
  source_name text,
  is_refund boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (tenant_id, order_id)
);

create index if not exists shopify_orders_fact_tenant_processed_idx on shopify_orders_fact(tenant_id, processed_at);

-- 2. Metrics dictionary and fact table to allow arbitrary KPIs

create table if not exists metrics_catalog(
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null,
  description text,
  unit text, -- currency, percentage, count
  source text not null check (source in ('meta', 'google_ads', 'shopify', 'blended')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists metrics_daily(
  tenant_id uuid not null references tenants(id) on delete cascade,
  date date not null,
  source text not null check (source in ('meta', 'google_ads', 'shopify', 'blended')),
  metric_key text not null references metrics_catalog(key) on delete cascade,
  value numeric not null,
  breakdown jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (tenant_id, date, source, metric_key, breakdown)
);

create index if not exists metrics_daily_tenant_date_idx on metrics_daily(tenant_id, date);
create index if not exists metrics_daily_metric_idx on metrics_daily(metric_key);
create index if not exists metrics_daily_source_idx on metrics_daily(source);

-- 3. View to maintain backward compatibility with existing kpi_daily readers

create or replace view kpi_daily_view as
  select
    tenant_id,
    date,
    source,
    sum(case when metric_key = 'spend' then value end) as spend,
    sum(case when metric_key = 'clicks' then value end) as clicks,
    sum(case when metric_key = 'conversions' then value end) as conversions,
    sum(case when metric_key = 'revenue' then value end) as revenue,
    sum(case when metric_key = 'aov' then value end) as aov,
    sum(case when metric_key = 'cos' then value end) as cos,
    sum(case when metric_key = 'roas' then value end) as roas
  from metrics_daily
  group by tenant_id, date, source;

-- replace original kpi_daily table with view if desired (commented to avoid destructive change)
-- drop table if exists kpi_daily cascade;
-- create table kpi_daily as table kpi_daily_view with no data;

-- 4. RLS policies for new tables

alter table meta_accounts enable row level security;
alter table meta_insights_levels enable row level security;
alter table google_ads_customers enable row level security;
alter table google_insights_fact enable row level security;
alter table shopify_shops enable row level security;
alter table shopify_orders_fact enable row level security;
alter table metrics_catalog enable row level security;
alter table metrics_daily enable row level security;

do $$
declare
  tbl regclass;
begin
  for tbl in select unnest(array[
    'meta_accounts'::regclass,
    'meta_insights_levels',
    'google_ads_customers',
    'google_insights_fact',
    'shopify_shops',
    'shopify_orders_fact',
    'metrics_daily'
  ])
  loop
    execute format($f$
      create policy %I_read on %s
        for select using (is_member_of(tenant_id));
    $f$, tbl::text, tbl::text);
    execute format($f$
      create policy %I_write on %s
        for insert with check (
          exists(select 1 from members x
            where x.tenant_id = %s.tenant_id
              and x.user_id = auth.uid()
              and x.role in ('platform_admin','admin'))
        );
    $f$, tbl::text, tbl::text, tbl::text);
  end loop;
end $$;

-- metrics_catalog is shared but read-only for standard members
create policy metrics_catalog_read on metrics_catalog
  for select using (true);

-- 5. Seed default metrics
insert into metrics_catalog (key, label, description, unit, source)
values
  ('spend', 'Spend', 'Advertising spend', 'currency', 'meta'),
  ('clicks', 'Clicks', 'Number of clicks', 'count', 'meta'),
  ('conversions', 'Conversions', 'Number of conversions', 'count', 'meta'),
  ('revenue', 'Revenue', 'Attributed revenue', 'currency', 'meta'),
  ('roas', 'ROAS', 'Return on ad spend', 'ratio', 'meta'),
  ('cos', 'COS', 'Cost of sale', 'ratio', 'meta'),
  ('aov', 'Average order value', 'Average revenue per conversion', 'currency', 'meta')
on conflict (key) do nothing;


