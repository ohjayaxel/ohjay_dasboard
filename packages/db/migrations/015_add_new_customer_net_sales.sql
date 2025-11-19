-- Add new customer / returning customer net sales columns to kpi_daily
ALTER TABLE IF EXISTS kpi_daily
  ADD COLUMN IF NOT EXISTS new_customer_net_sales numeric,
  ADD COLUMN IF NOT EXISTS returning_customer_net_sales numeric;

