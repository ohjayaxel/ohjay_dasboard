-- Add total_tax column to shopify_orders table
-- This stores the tax amount, which should be excluded from gross_sales
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS total_tax numeric;

