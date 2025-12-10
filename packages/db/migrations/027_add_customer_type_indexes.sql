-- Migration: Add indexes for customer type classification fields
-- This is a separate migration to avoid timeout when creating indexes on large tables
-- Run this manually if the automatic migration times out
-- 
-- These indexes can be created manually later if needed, they're not critical for initial functionality
-- Note: Cannot use CONCURRENTLY in migrations (runs in transaction), so these will lock the table briefly

-- Index 1: For Shopify mode lookups
CREATE INDEX IF NOT EXISTS idx_shopify_orders_customer_type_shopify
  ON shopify_orders (tenant_id, customer_type_shopify_mode) 
  WHERE customer_type_shopify_mode IS NOT NULL;

-- Index 2: For Financial mode lookups  
CREATE INDEX IF NOT EXISTS idx_shopify_orders_customer_type_financial
  ON shopify_orders (tenant_id, customer_type_financial_mode) 
  WHERE customer_type_financial_mode IS NOT NULL;

-- Index 3: For first order lookups
CREATE INDEX IF NOT EXISTS idx_shopify_orders_first_order
  ON shopify_orders (tenant_id, customer_id, is_first_order_for_customer) 
  WHERE customer_id IS NOT NULL AND is_first_order_for_customer = TRUE;
