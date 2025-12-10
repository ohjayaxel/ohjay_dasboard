-- Migration: Add returning and guest customer net sales to shopify_daily_sales
-- This allows aggregation by customer type for both Shopify and Financial modes

-- Add returning and guest customer net sales columns
ALTER TABLE IF EXISTS shopify_daily_sales
  ADD COLUMN IF NOT EXISTS returning_customer_net_sales NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS guest_net_sales NUMERIC DEFAULT 0;

-- Update comments
COMMENT ON COLUMN shopify_daily_sales.new_customer_net_sales IS 'Net sales (excl tax) from new/first-time customers only, mode-dependent';
COMMENT ON COLUMN shopify_daily_sales.returning_customer_net_sales IS 'Net sales (excl tax) from returning customers only, mode-dependent';
COMMENT ON COLUMN shopify_daily_sales.guest_net_sales IS 'Net sales (excl tax) from guest checkouts (no customer_id)';

