import { revalidatePath } from 'next/cache';
import { cache } from 'react';

import { fetchKpiDaily, fetchLatestKpiRow, type KpiDailyRow, type KpiSource } from './fetchers';
import { getDailyMetricsFromView, getMarketingSpendFromView } from './daily-metrics';

export type KpiTotals = {
  spend: number;
  clicks: number;
  conversions: number;
  revenue: number;
  aov: number | null;
  cpa: number | null;
  roas: number | null;
  cos: number | null;
};

export type KpiSeriesPoint = {
  date: string;
  spend: number;
  clicks: number;
  conversions: number;
  revenue: number;
  aov: number | null;
  cpa: number | null;
  roas: number | null;
  cos: number | null;
};

export type KpiSeriesResult = {
  rows: KpiDailyRow[];
  totals: KpiTotals;
  series: KpiSeriesPoint[];
  currency: string | null;
};

function sum(values: Array<number | null | undefined>) {
  return values.reduce((acc, value) => acc + (value ?? 0), 0);
}

function deriveMetrics({
  spend,
  revenue,
  conversions,
  clicks,
}: {
  spend: number;
  revenue: number;
  conversions: number;
  clicks: number;
}): { aov: number | null; cos: number | null; roas: number | null; cpa: number | null } {
  const aov = conversions > 0 ? revenue / conversions : null;
  const cos = revenue > 0 ? spend / revenue : null;
  const roas = spend > 0 ? revenue / spend : null;
  const cpa = conversions > 0 ? spend / conversions : null;
  return { aov, cos, roas, cpa };
}

function buildSeries(rows: KpiDailyRow[]): KpiSeriesPoint[] {
  const byDate = new Map<string, KpiSeriesPoint>();

  for (const row of rows) {
    const existing = byDate.get(row.date) ?? {
      date: row.date,
      spend: 0,
      clicks: 0,
      conversions: 0,
      revenue: 0,
      aov: null,
      cos: null,
      roas: null,
      cpa: null,
    };

    existing.spend += row.spend ?? 0;
    existing.clicks += row.clicks ?? 0;
    existing.conversions += row.conversions ?? 0;
    existing.revenue += row.revenue ?? 0;
    byDate.set(row.date, existing);
  }

  return Array.from(byDate.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((point) => {
      const metrics = deriveMetrics({
        spend: point.spend,
        revenue: point.revenue,
        conversions: point.conversions,
        clicks: point.clicks,
      });
      return {
        ...point,
        aov: metrics.aov,
        cos: metrics.cos,
        roas: metrics.roas,
        cpa: metrics.cpa,
      };
    });
}

function buildTotals(rows: KpiDailyRow[]): KpiTotals {
  const spend = sum(rows.map((row) => row.spend));
  const clicks = sum(rows.map((row) => row.clicks));
  const conversions = sum(rows.map((row) => row.conversions));
  const revenue = sum(rows.map((row) => row.revenue));

  return {
    spend,
    clicks,
    conversions,
    revenue,
    ...deriveMetrics({ spend, revenue, conversions, clicks }),
  };
}

type GetKpiDailyParams = {
  tenantId: string;
  from?: string;
  to?: string;
  source?: KpiSource | KpiSource[];
};

export async function getKpiDaily(params: GetKpiDailyParams): Promise<KpiSeriesResult> {
  const rows = await fetchKpiDaily({
    tenantId: params.tenantId,
    from: params.from,
    to: params.to,
    source: params.source,
  });

  const series = buildSeries(rows);
  const totals = buildTotals(rows);
  const currency = rows.find((row) => row.currency)?.currency ?? null;

  return { rows, series, totals, currency };
}

export const getLatestKpiSummary = cache(async (params: {
  tenantId: string;
  source?: KpiSource | KpiSource[];
}) => {
  const row = await fetchLatestKpiRow(params);

  if (!row) {
    return null;
  }

  const totals = buildTotals([row]);

  return {
    date: row.date,
    source: row.source,
    metrics: totals,
    currency: row.currency ?? null,
  };
});

export type OverviewDataPoint = {
  date: string;
  gross_sales: number;
  net_sales: number;
  new_customer_net_sales: number;
  marketing_spend: number;
  amer: number | null;
  orders: number;
  aov: number | null;
};

export type OverviewTotals = {
  gross_sales: number;
  net_sales: number;
  new_customer_net_sales: number;
  marketing_spend: number;
  amer: number | null;
  orders: number;
  aov: number | null;
};

export type OverviewResult = {
  series: OverviewDataPoint[];
  totals: OverviewTotals;
  currency: string | null;
};

export async function getOverviewData(params: {
  tenantId: string;
  from?: string;
  to?: string;
}): Promise<OverviewResult> {
  // Overview aggregation:
  // This implementation now uses our semantic layer views:
  // - v_marketing_spend_daily
  // - v_daily_metrics
  // as the primary source of daily metrics (net sales, new customer net sales,
  // total marketing spend from Meta + Google Ads, and aMER).
  // These values have been validated to match the legacy aggregation logic
  // via compareDailyMetricsLayers() for multiple periods.

  try {
    const { getDailyMetricsFromView } = await import('./daily-metrics');

    // Fetch daily metrics from semantic layer view
    const rows = await getDailyMetricsFromView({
      tenantId: params.tenantId,
      from: params.from ?? '1970-01-01',
      to: params.to ?? '2100-01-01',
    });

    // Fill in all dates in the range to ensure complete series
    const allDates = new Set<string>();
    const startDate = new Date(params.from ?? '1970-01-01');
    const endDate = new Date(params.to ?? '2100-01-01');

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      allDates.add(dateStr);
    }

    // Build map by date from semantic layer rows
    const byDate = new Map<string, OverviewDataPoint>();

    for (const row of rows) {
      const existing = byDate.get(row.date) ?? {
        date: row.date,
        gross_sales: 0,
        net_sales: 0,
        new_customer_net_sales: 0,
        marketing_spend: 0,
        amer: null,
        orders: 0,
        aov: null,
      };

      // Map semantic layer columns to OverviewDataPoint
      existing.gross_sales += row.gross_sales ?? 0;
      existing.net_sales += row.net_sales ?? 0;
      existing.new_customer_net_sales += row.new_customer_net_sales ?? 0;
      existing.marketing_spend += row.total_marketing_spend ?? 0;
      existing.orders += row.orders ?? 0;

      // aMER is already calculated in the view, but we can also compute it here for consistency
      // However, we'll use the view's value as the primary source since it's already computed in SQL
      existing.amer = row.amer;

      byDate.set(row.date, existing);
    }

    // Initialize missing dates in range with zeros
    for (const dateStr of Array.from(allDates)) {
      if (!byDate.has(dateStr)) {
        byDate.set(dateStr, {
          date: dateStr,
          gross_sales: 0,
          net_sales: 0,
          new_customer_net_sales: 0,
          marketing_spend: 0,
          amer: null,
          orders: 0,
          aov: null,
        });
      }
    }

    // Build series with calculated AOV and ensure aMER consistency
    const series = Array.from(byDate.values())
      .filter((point) => allDates.has(point.date)) // Only include dates in the requested range
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((point) => {
        // Calculate AOV (Average Order Value) locally
        const aov = point.orders > 0 ? point.net_sales / point.orders : null;

        // Ensure aMER is calculated if not present (shouldn't happen, but for safety)
        const amer =
          point.amer !== null
            ? point.amer
            : point.marketing_spend > 0
              ? point.new_customer_net_sales / point.marketing_spend
              : null;

        return {
          ...point,
          amer,
          aov,
        };
      });

    // Calculate totals
    const totalGrossSales = sum(series.map((p) => p.gross_sales));
    const totalNetSales = sum(series.map((p) => p.net_sales));
    const totalNewCustomerNetSales = sum(series.map((p) => p.new_customer_net_sales));
    const totalMarketingSpend = sum(series.map((p) => p.marketing_spend));
    const totalOrders = sum(series.map((p) => p.orders));

    const totals: OverviewTotals = {
      gross_sales: totalGrossSales,
      net_sales: totalNetSales,
      new_customer_net_sales: totalNewCustomerNetSales,
      marketing_spend: totalMarketingSpend,
      amer: totalMarketingSpend > 0 ? totalNewCustomerNetSales / totalMarketingSpend : null,
      orders: totalOrders,
      aov: totalOrders > 0 ? totalNetSales / totalOrders : null,
    };

    // Get currency from semantic layer rows
    const currency =
      rows.length > 0 ? rows.find((row) => row.currency)?.currency ?? null : null;

    return { series, totals, currency };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to load overview data', {
      tenantId: params.tenantId,
      from: params.from,
      to: params.to,
      error: message,
    });
    throw new Error(`Failed to load overview data: ${message}`);
  }
}

export type MarketsDataPoint = {
  country: string;
  gross_sales: number;
  net_sales: number;
  new_customer_net_sales: number;
  marketing_spend: number;
  amer: number | null;
  orders: number;
  aov: number | null;
};

export type MarketsTotals = {
  gross_sales: number;
  net_sales: number;
  new_customer_net_sales: number;
  marketing_spend: number;
  amer: number | null;
  orders: number;
  aov: number | null;
};

export type MarketsResult = {
  series: MarketsDataPoint[];
  totals: MarketsTotals;
  currency: string | null;
};

// Country priority mapping: DE, SE, NO, FI are kept as-is, all others become OTHER
const COUNTRY_PRIORITY_CODES = new Set(['DE', 'SE', 'NO', 'FI']);
const COUNTRY_PRIORITY_ORDER = ['DE', 'SE', 'NO', 'FI', 'OTHER'] as const;

/**
 * Normalize country code to country_priority format
 * DE, SE, NO, FI are kept as-is, all others become OTHER
 */
function normalizeCountryToPriority(country: string | null | undefined): string {
  if (!country) return 'OTHER';
  
  const upperCountry = country.toUpperCase();
  return COUNTRY_PRIORITY_CODES.has(upperCountry) ? upperCountry : 'OTHER';
}

/**
 * NOTE: Markets (country-level) still uses a hybrid approach:
 * - Global totals (marketing spend, aMER) come from the semantic layer (views).
 * - Per-market breakdown still reads directly from shopify_orders and
 *   meta_insights_daily because country-level semantic views are not yet implemented.
 * This is the only remaining exception and can be migrated later when we add
 * v_marketing_spend_daily_by_country, etc.
 */
export async function getMarketsData(params: {
  tenantId: string;
  from?: string;
  to?: string;
}): Promise<MarketsResult> {
  try {
    const { getSupabaseServiceClient } = await import('@/lib/supabase/server');
    const supabase = getSupabaseServiceClient();

    const fromDate = params.from ?? '1970-01-01';
    const toDate = params.to ?? '2100-01-01';

    // Fetch global marketing spend totals from semantic layer
    // This ensures consistency with Overview page totals
    const globalMarketingSpend = await getMarketingSpendFromView({
      tenantId: params.tenantId,
      from: fromDate,
      to: toDate,
    });

    // Fetch transactions for the date range (using transactions table for 100% Shopify matching)
    const { data: transactions, error: transactionsError } = await supabase
      .from('shopify_sales_transactions')
      .select('event_date, gross_sales, discounts, returns, shopify_order_id, event_type, currency')
      .eq('tenant_id', params.tenantId)
      .gte('event_date', fromDate)
      .lte('event_date', toDate);

    if (transactionsError) {
      throw new Error(`Failed to fetch Shopify transactions: ${transactionsError.message}`);
    }

    // Get unique order IDs from transactions
    // Normalize order_id format: shopify_sales_transactions uses gid://shopify/Order/1234567890
    // but shopify_orders uses just 1234567890, so extract numeric ID from gid format
    const orderIds = new Set<string>();
    const orderIdMapping = new Map<string, string>(); // Maps normalized ID -> original gid format
    
    for (const txn of transactions || []) {
      if (txn.shopify_order_id) {
        const originalId = txn.shopify_order_id as string;
        // Extract numeric ID from gid://shopify/Order/1234567890 format
        const normalizedId = originalId.includes('/') 
          ? originalId.split('/').pop() || originalId
          : originalId;
        orderIds.add(normalizedId);
        orderIdMapping.set(normalizedId, originalId);
      }
    }

    // Fetch shopify_orders for country and new customer data
    const ordersMap = new Map<string, {
      country: string | null;
      is_new_customer: boolean | null;
      is_refund: boolean | null;
      processed_at: string | null;
    }>();

    if (orderIds.size > 0) {
      // Fetch in batches of 1000
      const orderIdArray = Array.from(orderIds);
      for (let i = 0; i < orderIdArray.length; i += 1000) {
        const batch = orderIdArray.slice(i, i + 1000);
        const { data: batchOrders, error: ordersError } = await supabase
          .from('shopify_orders')
          .select('order_id, country, is_new_customer, is_refund, processed_at')
          .eq('tenant_id', params.tenantId)
          .in('order_id', batch);

        if (ordersError) {
          console.warn(`Failed to fetch orders batch: ${ordersError.message}`);
        } else if (batchOrders) {
          for (const order of batchOrders) {
            ordersMap.set(order.order_id as string, {
              country: order.country as string | null,
              is_new_customer: order.is_new_customer as boolean | null,
              is_refund: order.is_refund as boolean | null,
              processed_at: order.processed_at as string | null,
            });
          }
        }
      }
    }

    // Fetch marketing spend with country breakdown from Meta insights if available
    // This is used ONLY for per-country breakdown; global totals come from semantic layer
    // Only fetch insights with country breakdown (country_priority or country breakdown keys)
    const { data: metaInsightsWithCountry } = await supabase
      .from('meta_insights_daily')
      .select('date, spend, breakdowns, breakdowns_key')
      .eq('tenant_id', params.tenantId)
      .gte('date', fromDate)
      .lte('date', toDate)
      .eq('action_report_time', 'impression')
      .eq('attribution_window', '1d_click')
      .in('breakdowns_key', ['country_priority', 'country'])
      .not('spend', 'is', null)
      .gt('spend', 0)
      .not('breakdowns', 'is', null);

    // Aggregate Meta spend by country if we have country breakdown data
    // This is used for per-country marketing spend allocation
    const metaSpendByCountry = new Map<string, number>();
    let totalMetaSpendWithCountry = 0;

    if (metaInsightsWithCountry && metaInsightsWithCountry.length > 0) {
      for (const insight of metaInsightsWithCountry) {
        const spend = Number(insight.spend) || 0;

        // Check if this insight has country breakdown
        if (insight.breakdowns && typeof insight.breakdowns === 'object') {
          const breakdowns = insight.breakdowns as Record<string, unknown>;
          const rawCountry = breakdowns.country as string | undefined;

          if (rawCountry) {
            // Normalize country to country_priority format (DE, SE, NO, FI, or OTHER)
            const country = normalizeCountryToPriority(rawCountry);
            const existing = metaSpendByCountry.get(country) ?? 0;
            metaSpendByCountry.set(country, existing + spend);
            totalMetaSpendWithCountry += spend;
          }
        }
      }
    }

    // Use semantic layer values for global totals (ensures consistency with Overview)
    const totalMetaSpend = globalMarketingSpend.meta_spend;
    const totalGoogleSpend = globalMarketingSpend.google_ads_spend;
    const totalMarketingSpend = globalMarketingSpend.total_marketing_spend;

    // Aggregate transactions by country (normalized to country_priority format)
    const byCountry = new Map<string, MarketsDataPoint>();
    const ordersByCountry = new Map<string, Set<string>>(); // Track unique order IDs per country

    for (const transaction of transactions || []) {
      const originalOrderId = transaction.shopify_order_id as string;
      // Normalize order_id: extract numeric ID from gid://shopify/Order/1234567890 format
      const normalizedOrderId = originalOrderId.includes('/') 
        ? originalOrderId.split('/').pop() || originalOrderId
        : originalOrderId;
      const order = ordersMap.get(normalizedOrderId);
      if (!order || !order.country) continue;

      // Normalize country to country_priority format (DE, SE, NO, FI, or OTHER)
      const country = normalizeCountryToPriority(order.country);

      const existing = byCountry.get(country) ?? {
        country,
        gross_sales: 0,
        net_sales: 0,
        new_customer_net_sales: 0,
        marketing_spend: 0,
        amer: null,
        orders: 0,
        aov: null,
      };

      const grossSales = parseFloat((transaction.gross_sales || 0).toString());
      const discounts = parseFloat((transaction.discounts || 0).toString());
      const returns = parseFloat((transaction.returns || 0).toString());
      const netSales = grossSales - discounts - returns;

      existing.gross_sales += grossSales;
      existing.net_sales += netSales;

      // Track orders per country (only SALE events, not refunds)
      if (transaction.event_type === 'SALE' && !order.is_refund) {
        if (!ordersByCountry.has(country)) {
          ordersByCountry.set(country, new Set());
        }
        ordersByCountry.get(country)!.add(normalizedOrderId);

        // Calculate new customer net sales (only for SALE events)
        if (order.is_new_customer === true) {
          existing.new_customer_net_sales += netSales;
        }
      }

      byCountry.set(country, existing);
    }

    // Set order counts
    for (const [country, orderSet] of Array.from(ordersByCountry.entries())) {
      const existing = byCountry.get(country);
      if (existing) {
        existing.orders = orderSet.size;
      }
    }

    // Assign marketing spend per country
    // If we have Meta country breakdown, use it. Otherwise distribute proportionally based on net_sales
    // Note: Global totals (used in Markets summary) come from semantic layer, not from summing per-country values
    const totalNetSalesForDistribution = sum(Array.from(byCountry.values()).map((p) => p.net_sales));
    
    const series = Array.from(byCountry.values())
      .map((point) => {
        let marketingSpend = 0;

        // Use Meta country breakdown if available
        const metaSpendForCountry = metaSpendByCountry.get(point.country) ?? 0;
        
        if (metaSpendByCountry.size > 0) {
          // We have country breakdown: use Meta spend per country + distribute Google spend proportionally
          const googleSpendProportion = totalNetSalesForDistribution > 0 
            ? point.net_sales / totalNetSalesForDistribution 
            : 0;
          marketingSpend = metaSpendForCountry + (googleSpendProportion * totalGoogleSpend);
        } else {
          // No country breakdown: distribute total marketing spend proportionally based on net_sales
          marketingSpend = totalNetSalesForDistribution > 0 
            ? (point.net_sales / totalNetSalesForDistribution) * totalMarketingSpend
            : 0;
        }

        // Per-market aMER: calculate locally for consistency
        // Formula matches semantic layer: new_customer_net_sales / marketing_spend
        const amer = marketingSpend > 0 
          ? point.new_customer_net_sales / marketingSpend 
          : null;
        const aov = point.orders > 0 
          ? point.net_sales / point.orders 
          : null;

        return {
          ...point,
          marketing_spend: marketingSpend,
          amer,
          aov,
        };
      })
      .sort((a, b) => {
        // Sort by country_priority order first (DE, SE, NO, FI, OTHER), then by gross_sales descending
        const priority = new Map(COUNTRY_PRIORITY_ORDER.map((country, index) => [country, index]));
        const aRank = priority.has(a.country) ? priority.get(a.country)! : COUNTRY_PRIORITY_ORDER.length + 1;
        const bRank = priority.has(b.country) ? priority.get(b.country)! : COUNTRY_PRIORITY_ORDER.length + 1;

        if (aRank !== bRank) {
          return aRank - bRank;
        }

        // If same priority, sort by gross_sales descending
        return b.gross_sales - a.gross_sales;
      });

    // Calculate totals
    // Note: marketing_spend total comes from semantic layer (not summed from per-country values)
    // to ensure consistency with Overview page
    const totalGrossSalesCalculated = sum(series.map((p) => p.gross_sales));
    const totalNetSales = sum(series.map((p) => p.net_sales));
    const totalNewCustomerNetSales = sum(series.map((p) => p.new_customer_net_sales));
    const totalOrders = sum(series.map((p) => p.orders));

    // Use semantic layer marketing spend for global total (ensures consistency with Overview)
    const totalMarketingSpendForTotals = totalMarketingSpend;

    // Global aMER: use semantic layer formula (matches v_daily_metrics)
    // amer = new_customer_net_sales / total_marketing_spend
    const globalAmer = totalMarketingSpendForTotals > 0 
      ? totalNewCustomerNetSales / totalMarketingSpendForTotals 
      : null;

    const totals: MarketsTotals = {
      gross_sales: totalGrossSalesCalculated,
      net_sales: totalNetSales,
      new_customer_net_sales: totalNewCustomerNetSales,
      marketing_spend: totalMarketingSpendForTotals,
      amer: globalAmer,
      orders: totalOrders,
      aov: totalOrders > 0 ? totalNetSales / totalOrders : null,
    };

    // Get currency from transactions
    const currency = transactions?.find((txn) => txn.currency)?.currency ?? null;

    return { series, totals, currency };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to load markets data', {
      tenantId: params.tenantId,
      from: params.from,
      to: params.to,
      error: message,
    });
    throw new Error(`Failed to load markets data: ${message}`);
  }
}

export async function revalidateKpiForTenant(tenantSlug: string) {
  const routes = [
    `/t/${tenantSlug}`,
    `/t/${tenantSlug}/meta`,
    `/t/${tenantSlug}/google`,
    `/t/${tenantSlug}/shopify`,
    `/t/${tenantSlug}/markets`,
  ];

  for (const route of routes) {
    revalidatePath(route, 'page');
  }
}

