-- Migration: Add semantic layer views for unified cross-channel analytics
-- Execute with Supabase CLI: supabase db execute packages/db/migrations/031_add_semantic_layer_views.sql
--
-- This migration creates two semantic layer views:
-- 1. v_marketing_spend_daily - Unified cross-channel marketing spend (Meta + Google Ads)
-- 2. v_daily_metrics - Combined sales and marketing metrics with aMER calculation
--
-- These views provide a clean semantic layer on top of existing fact tables,
-- enabling consistent cross-channel metric calculations without modifying ingestion flows.

-- ============================================================================
-- View 1: v_marketing_spend_daily
-- ============================================================================
-- Purpose: Unified cross-channel marketing spend aggregation
-- Source: kpi_daily (Meta and Google Ads sources)
-- Exposes: meta_spend, google_ads_spend, total_marketing_spend, currency

CREATE OR REPLACE VIEW v_marketing_spend_daily AS
SELECT
  tenant_id,
  date,
  SUM(CASE WHEN source = 'meta' THEN spend ELSE 0 END) AS meta_spend,
  SUM(CASE WHEN source = 'google_ads' THEN spend ELSE 0 END) AS google_ads_spend,
  SUM(spend) AS total_marketing_spend,
  -- Currency: Use MAX to pick a currency (assumes single currency per tenant/date)
  -- Note: currency column may not exist in all environments (added in migration 009)
  -- If column doesn't exist, this will return NULL gracefully
  MAX(currency) AS currency
FROM kpi_daily
WHERE source IN ('meta', 'google_ads')
GROUP BY tenant_id, date;

-- Add comment explaining the view
COMMENT ON VIEW v_marketing_spend_daily IS 
  'Semantic layer view: Unified cross-channel marketing spend per tenant and date. Aggregates Meta and Google Ads spend from kpi_daily. Currency column may be NULL if not available in kpi_daily.';

-- ============================================================================
-- View 2: v_daily_metrics
-- ============================================================================
-- Purpose: Combined daily metrics (sales + marketing + aMER)
-- Source: shopify_daily_sales (Shopify Mode) + v_marketing_spend_daily
-- Exposes: net_sales, new_customer_net_sales, marketing spend columns, aMER

CREATE OR REPLACE VIEW v_daily_metrics AS
SELECT
  s.tenant_id,
  s.date,
  -- Sales metrics from shopify_daily_sales
  s.net_sales_excl_tax AS net_sales,
  s.gross_sales_excl_tax AS gross_sales,
  s.new_customer_net_sales,
  s.returning_customer_net_sales,
  s.guest_net_sales,
  s.orders_count AS orders,
  -- Marketing spend from v_marketing_spend_daily
  COALESCE(m.meta_spend, 0) AS meta_spend,
  COALESCE(m.google_ads_spend, 0) AS google_ads_spend,
  COALESCE(m.total_marketing_spend, 0) AS total_marketing_spend,
  -- aMER calculation: new_customer_net_sales / total_marketing_spend
  -- Returns NULL if denominator is 0 or NULL
  CASE 
    WHEN COALESCE(m.total_marketing_spend, 0) > 0
    THEN s.new_customer_net_sales / m.total_marketing_spend
    ELSE NULL
  END AS amer,
  -- Currency: prefer shopify_daily_sales, fallback to marketing_spend_daily
  COALESCE(s.currency, m.currency) AS currency
FROM shopify_daily_sales s
LEFT JOIN v_marketing_spend_daily m
  ON s.tenant_id = m.tenant_id
 AND s.date = m.date
WHERE s.mode = 'shopify';

-- Add comment explaining the view
COMMENT ON VIEW v_daily_metrics IS 
  'Semantic layer view: Unified daily metrics combining Shopify sales data (mode=''shopify'') with cross-channel marketing spend. Calculates aMER (adjusted Marketing Efficiency Ratio) as new_customer_net_sales / total_marketing_spend. LEFT JOIN ensures dates with sales but no marketing spend are still included (marketing columns will be 0 or NULL).';


