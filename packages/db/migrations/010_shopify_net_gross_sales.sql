-- Add gross_sales, net_sales, and is_new_customer columns to shopify_orders
alter table if exists shopify_orders
  add column if not exists gross_sales numeric,
  add column if not exists net_sales numeric,
  add column if not exists is_new_customer boolean default false;

-- Add net_sales, gross_sales, new_customer_conversions, returning_customer_conversions to kpi_daily
alter table if exists kpi_daily
  add column if not exists net_sales numeric,
  add column if not exists gross_sales numeric,
  add column if not exists new_customer_conversions numeric,
  add column if not exists returning_customer_conversions numeric;

-- Create index for faster customer lookup
create index if not exists idx_shopify_orders_customer_processed 
  on shopify_orders (tenant_id, customer_id, processed_at);

