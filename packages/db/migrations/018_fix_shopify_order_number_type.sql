-- Fix shopify_order_number to be text instead of integer
-- Shopify order numbers can be very large and exceed integer range

ALTER TABLE IF EXISTS shopify_sales_transactions 
ALTER COLUMN shopify_order_number TYPE text;

