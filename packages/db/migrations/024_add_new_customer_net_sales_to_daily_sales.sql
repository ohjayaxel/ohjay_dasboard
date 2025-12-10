-- Migration: Add new_customer_net_sales to shopify_daily_sales table
-- This column tracks net sales from new customers only, which is needed for aMER calculation

-- Add new_customer_net_sales column
alter table shopify_daily_sales
  add column if not exists new_customer_net_sales numeric default 0;

-- Update comment to document the new column
comment on column shopify_daily_sales.new_customer_net_sales is 'Net sales excluding tax from new customers only (is_new_customer = true), used for aMER calculation';


