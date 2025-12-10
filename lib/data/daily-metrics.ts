/**
 * Daily Metrics Data Access Layer
 * 
 * This module provides access to the semantic layer views, specifically v_daily_metrics.
 * These views combine Shopify sales data with cross-channel marketing spend and compute
 * metrics like aMER in SQL.
 * 
 * This is the new, semantic-layer-based approach. The old aggregation logic remains
 * in lib/data/agg.ts for backwards compatibility.
 */

import { getSupabaseServiceClient } from '@/lib/supabase/server';

/**
 * Row type matching v_daily_metrics view columns
 */
export type DailyMetricsRow = {
  date: string;
  net_sales: number | null;
  new_customer_net_sales: number | null;
  gross_sales: number | null;
  returning_customer_net_sales: number | null;
  guest_net_sales: number | null;
  orders: number | null;
  meta_spend: number | null;
  google_ads_spend: number | null;
  total_marketing_spend: number | null;
  amer: number | null;
  currency: string | null;
};

/**
 * Parameters for fetching daily metrics from the semantic layer view
 */
export type GetDailyMetricsFromViewParams = {
  tenantId: string;
  from: string; // 'YYYY-MM-DD'
  to: string;   // 'YYYY-MM-DD'
};

/**
 * Fetches daily metrics from the v_daily_metrics semantic layer view.
 * 
 * This view combines:
 * - Shopify sales data (from shopify_daily_sales, mode='shopify')
 * - Marketing spend (from v_marketing_spend_daily, aggregating Meta + Google Ads)
 * - Calculated aMER (new_customer_net_sales / total_marketing_spend)
 * 
 * @param params - Query parameters
 * @returns Array of daily metrics rows, ordered by date ascending
 */
export async function getDailyMetricsFromView(
  params: GetDailyMetricsFromViewParams,
): Promise<DailyMetricsRow[]> {
  const client = getSupabaseServiceClient();

  const { data, error } = await client
    .from('v_daily_metrics')
    .select(
      'date, net_sales, new_customer_net_sales, gross_sales, returning_customer_net_sales, guest_net_sales, orders, meta_spend, google_ads_spend, total_marketing_spend, amer, currency',
    )
    .eq('tenant_id', params.tenantId)
    .gte('date', params.from)
    .lte('date', params.to)
    .order('date', { ascending: true });

  if (error) {
    throw new Error(
      `Failed to fetch daily metrics from semantic layer view: ${error.message}`,
    );
  }

  return (data as DailyMetricsRow[]) ?? [];
}

/**
 * Marketing Spend Aggregation Result
 */
export type MarketingSpendAggregation = {
  meta_spend: number;
  google_ads_spend: number;
  total_marketing_spend: number;
};

/**
 * Parameters for fetching marketing spend from the semantic layer view
 */
export type GetMarketingSpendFromViewParams = {
  tenantId: string;
  from: string; // 'YYYY-MM-DD'
  to: string;   // 'YYYY-MM-DD'
};

/**
 * Fetches aggregated marketing spend from the v_marketing_spend_daily semantic layer view.
 * 
 * This view aggregates:
 * - Meta Ads spend (from kpi_daily where source='meta')
 * - Google Ads spend (from kpi_daily where source='google_ads')
 * - Total marketing spend (sum of both)
 * 
 * @param params - Query parameters
 * @returns Aggregated marketing spend totals for the date range
 */
export async function getMarketingSpendFromView(
  params: GetMarketingSpendFromViewParams,
): Promise<MarketingSpendAggregation> {
  const client = getSupabaseServiceClient();

  const { data, error } = await client
    .from('v_marketing_spend_daily')
    .select('meta_spend, google_ads_spend, total_marketing_spend')
    .eq('tenant_id', params.tenantId)
    .gte('date', params.from)
    .lte('date', params.to);

  if (error) {
    throw new Error(
      `Failed to fetch marketing spend from semantic layer view: ${error.message}`,
    );
  }

  // Aggregate across all dates in the range
  const rows = (data as Array<{
    meta_spend: number | null;
    google_ads_spend: number | null;
    total_marketing_spend: number | null;
  }>) ?? [];

  const metaSpend = rows.reduce((sum, row) => sum + (row.meta_spend ?? 0), 0);
  const googleAdsSpend = rows.reduce((sum, row) => sum + (row.google_ads_spend ?? 0), 0);
  const totalMarketingSpend = rows.reduce((sum, row) => sum + (row.total_marketing_spend ?? 0), 0);

  return {
    meta_spend: metaSpend,
    google_ads_spend: googleAdsSpend,
    total_marketing_spend: totalMarketingSpend,
  };
}
