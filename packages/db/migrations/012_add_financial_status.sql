-- Add financial_status column to shopify_orders table
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS financial_status text;

