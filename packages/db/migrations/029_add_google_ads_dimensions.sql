-- Add country and attribution_model dimensions to google_insights_daily
-- Execute with Supabase CLI: supabase db execute packages/db/migrations/029_add_google_ads_dimensions.sql

ALTER TABLE google_insights_daily 
  ADD COLUMN IF NOT EXISTS country_code TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS attribution_model TEXT DEFAULT '';

-- Update primary key constraint to include country_code and attribution_model
-- First, drop the existing primary key
ALTER TABLE google_insights_daily DROP CONSTRAINT IF EXISTS google_insights_daily_pkey;

-- Recreate primary key with new columns (using empty string default to avoid NULL issues)
ALTER TABLE google_insights_daily
  ADD CONSTRAINT google_insights_daily_pkey 
  PRIMARY KEY (tenant_id, date, customer_id, campaign_id, adgroup_id, ad_id, country_code, attribution_model);

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_google_insights_daily_country 
  ON google_insights_daily(tenant_id, date, country_code)
  WHERE country_code != '';

CREATE INDEX IF NOT EXISTS idx_google_insights_daily_attribution 
  ON google_insights_daily(tenant_id, date, attribution_model)
  WHERE attribution_model != '';

