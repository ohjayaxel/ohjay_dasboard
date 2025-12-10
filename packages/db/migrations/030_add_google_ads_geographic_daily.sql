-- Create google_ads_geographic_daily table for storing Google Ads performance data
-- with country, campaign, and ad_group breakdowns
-- Execute with Supabase CLI: supabase db execute packages/db/migrations/030_add_google_ads_geographic_daily.sql

-- This table stores daily Google Ads metrics broken down by:
-- - date
-- - customer_id (Google Ads account)
-- - campaign_id, ad_group_id
-- - country_criterion_id, country_code, location_type
--
-- The cost_micros field represents Google Ads ad spend in micros of the account currency.
-- This field will be used (after conversion: cost_micros / 1_000_000) alongside Meta's spend
-- column to calculate total marketing spend and cross-channel KPIs like aMER.

CREATE TABLE IF NOT EXISTS google_ads_geographic_daily (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  
  country_criterion_id TEXT NOT NULL,
  country_code TEXT,
  location_type TEXT NOT NULL CHECK (location_type IN ('AREA_OF_INTEREST', 'LOCATION_OF_PRESENCE')),
  
  impressions BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  conversions NUMERIC NOT NULL DEFAULT 0,
  conversions_value NUMERIC NOT NULL DEFAULT 0,
  
  conversion_action_id TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Unique constraint for idempotent upserts
  CONSTRAINT google_ads_geographic_daily_unique UNIQUE (
    tenant_id,
    customer_id,
    date,
    campaign_id,
    ad_group_id,
    country_criterion_id,
    location_type
  )
);

-- Create indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_google_ads_geographic_daily_tenant_date 
  ON google_ads_geographic_daily(tenant_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_google_ads_geographic_daily_tenant_customer_date 
  ON google_ads_geographic_daily(tenant_id, customer_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_google_ads_geographic_daily_country 
  ON google_ads_geographic_daily(tenant_id, date, country_code)
  WHERE country_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_google_ads_geographic_daily_campaign 
  ON google_ads_geographic_daily(tenant_id, date, campaign_id);

-- Add comment explaining the cost_micros field for cross-channel metrics
COMMENT ON COLUMN google_ads_geographic_daily.cost_micros IS 
  'Google Ads ad spend in micros of account currency. Convert to spend by dividing by 1,000,000. This field is used alongside Meta spend (from meta_insights_daily.spend) for calculating total marketing spend and cross-channel KPIs like aMER (new_customer_net_sales / marketing_spend).';

-- Add table comment
COMMENT ON TABLE google_ads_geographic_daily IS 
  'Daily Google Ads performance data with country, campaign, and ad_group breakdowns. Uses geographic_view to fetch all dimensions in a single query. The cost_micros field represents Google Ads ad spend and should be converted to normalized spend (cost_micros / 1_000_000) when aggregating with Meta spend for cross-channel metrics.';

