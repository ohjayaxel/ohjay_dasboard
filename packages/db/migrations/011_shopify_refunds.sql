-- Add total_refunds column to shopify_orders
-- This stores the total refund amount for an order, used for calculating gross_sales correctly
alter table if exists shopify_orders
  add column if not exists total_refunds numeric default 0;

-- Update existing rows: if is_refund is true, try to calculate total_refunds
-- For existing data, we can't recalculate without re-fetching from Shopify,
-- but we set a default of 0 which is fine since we'll backfill properly
update shopify_orders
set total_refunds = 0
where total_refunds is null;

