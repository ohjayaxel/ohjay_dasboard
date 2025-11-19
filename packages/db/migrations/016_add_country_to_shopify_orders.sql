-- Add country column to shopify_orders table
ALTER TABLE IF EXISTS shopify_orders
  ADD COLUMN IF NOT EXISTS country text;

