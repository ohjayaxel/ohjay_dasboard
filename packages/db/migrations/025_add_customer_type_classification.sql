-- Migration: Add customer type classification fields to shopify_orders
-- This stores stable customer classification per order that doesn't change over time
-- 
-- Part 1: Add columns only (fast operation, no indexes yet)
-- Indexes will be created in a separate migration if needed

-- Step 1: Add customer classification fields to shopify_orders (fast operation)
ALTER TABLE IF EXISTS shopify_orders
  ADD COLUMN IF NOT EXISTS is_first_order_for_customer BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS customer_type_shopify_mode TEXT,
  ADD COLUMN IF NOT EXISTS customer_type_financial_mode TEXT;

-- Step 2: Add check constraints (if not already exist)
DO $$
BEGIN
  -- Only add constraint if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'shopify_orders_customer_type_shopify_mode_check'
  ) THEN
    ALTER TABLE shopify_orders
      ADD CONSTRAINT shopify_orders_customer_type_shopify_mode_check
      CHECK (customer_type_shopify_mode IS NULL OR customer_type_shopify_mode IN ('FIRST_TIME', 'RETURNING', 'GUEST', 'UNKNOWN'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'shopify_orders_customer_type_financial_mode_check'
  ) THEN
    ALTER TABLE shopify_orders
      ADD CONSTRAINT shopify_orders_customer_type_financial_mode_check
      CHECK (customer_type_financial_mode IS NULL OR customer_type_financial_mode IN ('NEW', 'RETURNING', 'GUEST', 'UNKNOWN'));
  END IF;
END $$;

-- Add comments
COMMENT ON COLUMN shopify_orders.is_first_order_for_customer IS 'True if this is the customer''s first order ever (all-time), regardless of mode';
COMMENT ON COLUMN shopify_orders.customer_type_shopify_mode IS 'Customer type for Shopify Mode: FIRST_TIME (matches Shopify Analytics), RETURNING, GUEST, or UNKNOWN';
COMMENT ON COLUMN shopify_orders.customer_type_financial_mode IS 'Customer type for Financial Mode: NEW (first revenue-generating order), RETURNING, GUEST, or UNKNOWN';

-- Note: Indexes are created separately in migration 027 to avoid timeout on large tables
id timeout on large tables

