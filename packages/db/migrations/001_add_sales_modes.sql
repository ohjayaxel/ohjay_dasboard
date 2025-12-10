-- Migration: Add sales mode support to daily sales aggregations
-- This migration adds support for two sales calculation modes:
-- 1. 'shopify' - Matches Shopify Analytics reports
-- 2. 'financial' - Financially correct cash-flow based model

-- Create new table for daily sales by mode
create table if not exists shopify_daily_sales(
  tenant_id uuid not null references tenants(id) on delete cascade,
  date date not null,
  mode text not null check (mode in ('shopify', 'financial')),
  net_sales_excl_tax numeric not null default 0,
  gross_sales_excl_tax numeric,
  refunds_excl_tax numeric,
  discounts_excl_tax numeric,
  orders_count integer not null default 0,
  currency text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (tenant_id, date, mode)
);

-- Create indexes for efficient queries
create index if not exists shopify_daily_sales_tenant_date_idx on shopify_daily_sales(tenant_id, date);
create index if not exists shopify_daily_sales_tenant_mode_idx on shopify_daily_sales(tenant_id, mode);
create index if not exists shopify_daily_sales_tenant_date_mode_idx on shopify_daily_sales(tenant_id, date, mode);

-- Add comment explaining the modes
comment on table shopify_daily_sales is 'Daily aggregated Shopify sales by calculation mode. Mode ''shopify'' matches Shopify Analytics (uses order.createdAt), mode ''financial'' is cash-flow accurate (uses transaction.processedAt).';
comment on column shopify_daily_sales.mode is 'Sales calculation mode: ''shopify'' (matches Shopify Analytics) or ''financial'' (cash-flow accurate)';
comment on column shopify_daily_sales.net_sales_excl_tax is 'Net sales excluding tax after refunds, in shop currency';
comment on column shopify_daily_sales.gross_sales_excl_tax is 'Gross sales excluding tax before discounts and refunds';
comment on column shopify_daily_sales.refunds_excl_tax is 'Total refunds excluding tax for this date';
comment on column shopify_daily_sales.discounts_excl_tax is 'Total discounts excluding tax for this date';
comment on column shopify_daily_sales.orders_count is 'Number of orders included in this daily aggregation';



