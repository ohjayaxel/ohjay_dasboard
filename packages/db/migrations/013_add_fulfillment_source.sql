-- Add fulfillment_status and source_name columns to shopify_orders table
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS fulfillment_status text;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS source_name text;

