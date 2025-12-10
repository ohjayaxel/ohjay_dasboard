-- Add created_at column to shopify_orders table
-- This stores when the customer placed the order (order.created_at from Shopify)
-- Used for date grouping in aggregations instead of processed_at

ALTER TABLE IF EXISTS shopify_orders
  ADD COLUMN IF NOT EXISTS created_at DATE;

-- Create index for faster date filtering by created_at
CREATE INDEX IF NOT EXISTS idx_shopify_orders_created_at 
  ON shopify_orders (tenant_id, created_at);

-- Comment explaining the difference
COMMENT ON COLUMN shopify_orders.created_at IS 'Date when customer placed the order (from Shopify order.created_at). Used for daily aggregations.';
COMMENT ON COLUMN shopify_orders.processed_at IS 'Date when order was processed/fulfilled (from Shopify order.processed_at).';

