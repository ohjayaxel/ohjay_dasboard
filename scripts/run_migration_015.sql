-- Migration 015: Add new_customer_net_sales and returning_customer_net_sales to kpi_daily
-- Run this script in your Supabase SQL editor

ALTER TABLE IF EXISTS kpi_daily
  ADD COLUMN IF NOT EXISTS new_customer_net_sales numeric,
  ADD COLUMN IF NOT EXISTS returning_customer_net_sales numeric;

-- Verify the columns were added
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'kpi_daily' 
  AND column_name IN ('new_customer_net_sales', 'returning_customer_net_sales');

