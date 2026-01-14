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

/**
 * Normalize country code to uppercase format
 * Returns uppercase country code, or null if empty/invalid
 */
function normalizeCountry(country: string | null | undefined): string | null {
  if (!country || typeof country !== 'string') return null;
  const trimmed = country.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : null;
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
    const pageSize = 1000;

    // Fetch global marketing spend totals from semantic layer
    // This ensures consistency with Overview page totals
    const globalMarketingSpend = await getMarketingSpendFromView({
      tenantId: params.tenantId,
      from: fromDate,
      to: toDate,
    });

    // IMPORTANT:
    // `shopify_sales_transactions` is line-item granularity. Summing SALE rows will often overstate
    // order totals (and can drift due to taxes/duplication nuances). For Markets we want the same
    // semantics as `shopify_daily_sales`:
    // - Gross/Discounts/New-customer are based on `shopify_orders` by order.created_at day
    // - Returns are attributed by refund.createdAt day via RETURN events in `shopify_sales_transactions`

    // 1) Fetch orders in the date range (order.created_at) for sales-side metrics.
    const ordersInRange: Array<{
      order_id: string;
      created_at: string;
      country: string | null;
      gross_sales: number | string | null;
      discount: number | string | null;
      net_sales: number | string | null;
      refunds: number | string | null;
      is_refund: boolean | null;
      is_test: boolean | null;
      financial_status: string | null;
      is_first_order_for_customer: boolean | null;
      customer_type_shopify_mode: string | null;
      currency: string | null;
    }> = [];

    for (let offset = 0; ; offset += pageSize) {
      const { data: page, error } = await supabase
        .from('shopify_orders')
        .select(
          'order_id, created_at, country, gross_sales, discount, net_sales, refunds, is_refund, is_test, financial_status, is_first_order_for_customer, customer_type_shopify_mode, currency',
        )
        .eq('tenant_id', params.tenantId)
        .gte('created_at', fromDate)
        .lte('created_at', toDate)
        .gt('gross_sales', 0)
        .range(offset, offset + pageSize - 1);

      if (error) {
        throw new Error(`Failed to fetch Shopify orders for Markets: ${error.message}`);
      }

      if (page && page.length > 0) {
        ordersInRange.push(...(page as typeof ordersInRange));
      }

      if (!page || page.length < pageSize) break;
    }

    // Fetch marketing spend with country breakdown from Meta insights if available
    // This is used ONLY for per-country breakdown; global totals come from semantic layer
    // Only fetch insights with country breakdown
    const metaInsightsWithCountry: Array<{
      date: string;
      spend: number | string | null;
      breakdowns: unknown;
      breakdowns_key: string | null;
    }> = [];

    for (let offset = 0; ; offset += pageSize) {
      const { data: page, error } = await supabase
        .from('meta_insights_daily')
        .select('date, spend, breakdowns, breakdowns_key')
        .eq('tenant_id', params.tenantId)
        .gte('date', fromDate)
        .lte('date', toDate)
        .eq('action_report_time', 'impression')
        .eq('attribution_window', '1d_click')
        .eq('breakdowns_key', 'country')
        .not('spend', 'is', null)
        .gt('spend', 0)
        .not('breakdowns', 'is', null)
        .range(offset, offset + pageSize - 1);

      if (error) {
        throw new Error(`Failed to fetch Meta insights with country: ${error.message}`);
      }

      if (page && page.length > 0) {
        metaInsightsWithCountry.push(...(page as typeof metaInsightsWithCountry));
      }

      if (!page || page.length < pageSize) {
        break;
      }
    }

    // Fetch marketing spend with country breakdown from Google Ads geographic data
    const googleAdsGeographic: Array<{
      date: string;
      country_code: string | null;
      cost_micros: number | string | null;
    }> = [];

    for (let offset = 0; ; offset += pageSize) {
      const { data: page, error } = await supabase
        .from('google_ads_geographic_daily')
        .select('date, country_code, cost_micros')
        .eq('tenant_id', params.tenantId)
        .gte('date', fromDate)
        .lte('date', toDate)
        .eq('location_type', 'LOCATION_OF_PRESENCE')
        .not('country_code', 'is', null)
        .not('cost_micros', 'is', null)
        .range(offset, offset + pageSize - 1);

      // google_ads_geographic_daily may not exist in all environments
      if (error) {
        console.warn(`Failed to fetch Google Ads geographic daily: ${error.message}`);
        break;
      }

      if (page && page.length > 0) {
        googleAdsGeographic.push(...(page as typeof googleAdsGeographic));
      }

      if (!page || page.length < pageSize) {
        break;
      }
    }

    // Aggregate Meta spend by country if we have country breakdown data
    // This is used for per-country marketing spend allocation
    const metaSpendByCountry = new Map<string, number>();
    let totalMetaSpendWithCountry = 0;

    if (metaInsightsWithCountry.length > 0) {
      for (const insight of metaInsightsWithCountry) {
        const spend = Number(insight.spend) || 0;

        // Check if this insight has country breakdown
        if (insight.breakdowns && typeof insight.breakdowns === 'object') {
          const breakdowns = insight.breakdowns as Record<string, unknown>;
          const rawCountry = breakdowns.country as string | undefined;

          if (rawCountry) {
            // Normalize country to uppercase format
            const country = normalizeCountry(rawCountry);
            if (country) {
              const existing = metaSpendByCountry.get(country) ?? 0;
              metaSpendByCountry.set(country, existing + spend);
              totalMetaSpendWithCountry += spend;
            }
          }
        }
      }
    }

    // Aggregate Google Ads spend by country
    const googleAdsSpendByCountry = new Map<string, number>();
    let totalGoogleAdsSpendWithCountry = 0;

    if (googleAdsGeographic.length > 0) {
      for (const row of googleAdsGeographic) {
        // Convert cost_micros to spend (divide by 1,000,000)
        const spend = (Number(row.cost_micros) || 0) / 1_000_000;
        const country = normalizeCountry(row.country_code);
        if (country) {
          const existing = googleAdsSpendByCountry.get(country) ?? 0;
          googleAdsSpendByCountry.set(country, existing + spend);
          totalGoogleAdsSpendWithCountry += spend;
        }
      }
    }

    // Use semantic layer values for global totals (ensures consistency with Overview)
    const totalMetaSpend = globalMarketingSpend.meta_spend;
    const totalGoogleSpend = globalMarketingSpend.google_ads_spend;
    const totalMarketingSpend = globalMarketingSpend.total_marketing_spend;

    // Aggregate orders by country (sales-side metrics)
    const byCountry = new Map<string, MarketsDataPoint>();
    const ordersByCountry = new Map<string, Set<string>>(); // Track unique order IDs per country

    for (const order of ordersInRange) {
      const country = normalizeCountry(order.country);
      if (!country) continue;

      const gross = parseFloat((order.gross_sales || 0).toString());
      if (!Number.isFinite(gross) || gross <= 0) continue;

      const disc = parseFloat((order.discount || 0).toString());
      const net = parseFloat((order.net_sales || 0).toString());
      const ref = parseFloat((order.refunds || 0).toString());
      const netBeforeReturns = (Number.isFinite(net) ? net : 0) + (Number.isFinite(ref) ? ref : 0);

      const existing = byCountry.get(country) ?? {
        country,
        gross_sales: 0,
        net_sales: 0, // we'll subtract refund-dated RETURN events later
        new_customer_net_sales: 0, // idem
        marketing_spend: 0,
        amer: null,
        orders: 0,
        aov: null,
      };

      existing.gross_sales += gross;
      existing.net_sales += netBeforeReturns;

      const isFirst =
        order.is_first_order_for_customer === true ||
        order.customer_type_shopify_mode === 'FIRST_TIME';

      if (isFirst && order.is_refund !== true) {
        existing.new_customer_net_sales += netBeforeReturns;
      }

      if (!ordersByCountry.has(country)) ordersByCountry.set(country, new Set());
      ordersByCountry.get(country)!.add(String(order.order_id));

      byCountry.set(country, existing);
    }

    // 2) Subtract refund-dated returns (RETURN events) by the refunded order's country.
    const returnEvents: Array<{ shopify_order_id: string | null; returns: number | string | null }> = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data: page, error } = await supabase
        .from('shopify_sales_transactions')
        .select('shopify_order_id, returns')
        .eq('tenant_id', params.tenantId)
        .eq('event_type', 'RETURN')
        .gte('event_date', fromDate)
        .lte('event_date', toDate)
        .range(offset, offset + pageSize - 1);

      if (error) {
        throw new Error(`Failed to fetch RETURN events for Markets: ${error.message}`);
      }

      if (page && page.length > 0) {
        returnEvents.push(...(page as typeof returnEvents));
      }

      if (!page || page.length < pageSize) break;
    }

    const returnsByOrderId = new Map<string, number>();
    for (const ev of returnEvents) {
      const gid = (ev.shopify_order_id || '').toString();
      const numericId = gid.includes('/') ? gid.split('/').pop() : gid;
      if (!numericId) continue;
      const amt = parseFloat((ev.returns || 0).toString());
      if (!Number.isFinite(amt) || amt <= 0) continue;
      returnsByOrderId.set(numericId, (returnsByOrderId.get(numericId) || 0) + amt);
    }

    if (returnsByOrderId.size > 0) {
      const refundOrderIds = Array.from(returnsByOrderId.keys());
      const refundOrders: Array<{
        order_id: string;
        country: string | null;
        is_first_order_for_customer: boolean | null;
        customer_type_shopify_mode: string | null;
      }> = [];

      for (let i = 0; i < refundOrderIds.length; i += 1000) {
        const batch = refundOrderIds.slice(i, i + 1000);
        const { data: page, error } = await supabase
          .from('shopify_orders')
          .select('order_id, country, is_first_order_for_customer, customer_type_shopify_mode')
          .eq('tenant_id', params.tenantId)
          .in('order_id', batch);

        if (error) {
          console.warn(`Failed to fetch refund order countries batch: ${error.message}`);
          continue;
        }
        if (page && page.length > 0) {
          refundOrders.push(...(page as typeof refundOrders));
        }
      }

      const refundOrderMap = new Map<string, typeof refundOrders[number]>();
      for (const ro of refundOrders) refundOrderMap.set(String(ro.order_id), ro);

      for (const [orderId, amt] of returnsByOrderId.entries()) {
        const ro = refundOrderMap.get(orderId);
        if (!ro) continue;
        const country = normalizeCountry(ro.country);
        if (!country) continue;

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

        existing.net_sales -= amt;

        const isFirst =
          ro.is_first_order_for_customer === true || ro.customer_type_shopify_mode === 'FIRST_TIME';
        if (isFirst) {
          existing.new_customer_net_sales -= amt;
        }

        byCountry.set(country, existing);
      }
    }

    // Set order counts
    for (const [country, orderSet] of Array.from(ordersByCountry.entries())) {
      const existing = byCountry.get(country);
      if (existing) {
        existing.orders = orderSet.size;
      }
    }

    // Assign marketing spend per country
    // Use country breakdown from Meta and Google Ads if available, otherwise distribute proportionally based on net_sales
    // Note: Global totals (used in Markets summary) come from semantic layer, not from summing per-country values
    const totalNetSalesForDistribution = sum(Array.from(byCountry.values()).map((p) => p.net_sales));
    const hasCountryBreakdown = metaSpendByCountry.size > 0 || googleAdsSpendByCountry.size > 0;
    
    const series = Array.from(byCountry.values())
      .map((point) => {
        let marketingSpend = 0;

        // Get country-level spend from Meta and Google Ads if available
        const metaSpendForCountry = metaSpendByCountry.get(point.country) ?? 0;
        const googleAdsSpendForCountry = googleAdsSpendByCountry.get(point.country) ?? 0;
        
        if (hasCountryBreakdown) {
          // We have country breakdown from at least one source
          // Use actual country spend from Meta/Google Ads, and distribute the remainder proportionally
          let directSpend = metaSpendForCountry + googleAdsSpendForCountry;
          
          // If we have partial breakdown (only one source), distribute the other source proportionally
          if (metaSpendByCountry.size > 0 && googleAdsSpendByCountry.size === 0) {
            // We have Meta breakdown but not Google Ads: distribute Google Ads proportionally
            const googleSpendProportion = totalNetSalesForDistribution > 0 
              ? point.net_sales / totalNetSalesForDistribution 
              : 0;
            marketingSpend = directSpend + (googleSpendProportion * totalGoogleSpend);
          } else if (metaSpendByCountry.size === 0 && googleAdsSpendByCountry.size > 0) {
            // We have Google Ads breakdown but not Meta: distribute Meta proportionally
            const metaSpendProportion = totalNetSalesForDistribution > 0 
              ? point.net_sales / totalNetSalesForDistribution 
              : 0;
            marketingSpend = directSpend + (metaSpendProportion * totalMetaSpend);
          } else {
            // We have both Meta and Google Ads breakdown: use direct spend
            marketingSpend = directSpend;
          }
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
        // Sort by gross_sales descending, then alphabetically by country code
        if (Math.abs(b.gross_sales - a.gross_sales) > 0.01) {
          return b.gross_sales - a.gross_sales;
        }
        return a.country.localeCompare(b.country);
      });

    // Calculate totals
    // IMPORTANT: Use shopify_daily_sales(mode='shopify') for global sales totals to stay consistent
    // with Overview/v_daily_metrics. Per-country breakdown still comes from per-order country.
    let totalGrossSalesCalculated = sum(series.map((p) => p.gross_sales));
    let totalNetSales = sum(series.map((p) => p.net_sales));
    let totalNewCustomerNetSales = sum(series.map((p) => p.new_customer_net_sales));
    let totalOrders = sum(series.map((p) => p.orders));
    let currencyFromSales: string | null = null;

    try {
      const { data: dailySales, error: dailySalesError } = await supabase
        .from('shopify_daily_sales')
        .select('gross_sales_excl_tax, net_sales_excl_tax, new_customer_net_sales, orders_count, currency')
        .eq('tenant_id', params.tenantId)
        .eq('mode', 'shopify')
        .gte('date', fromDate)
        .lte('date', toDate);

      if (!dailySalesError && dailySales) {
        totalGrossSalesCalculated = sum(dailySales.map((r: any) => Number(r.gross_sales_excl_tax) || 0));
        totalNetSales = sum(dailySales.map((r: any) => Number(r.net_sales_excl_tax) || 0));
        totalNewCustomerNetSales = sum(dailySales.map((r: any) => Number(r.new_customer_net_sales) || 0));
        totalOrders = sum(dailySales.map((r: any) => Number(r.orders_count) || 0));
        currencyFromSales = (dailySales.find((r: any) => r.currency)?.currency as string) ?? null;
      }
    } catch (e) {
      // Ignore schema issues; fall back to per-country sums
    }

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

    // Get currency: prefer sales table, fallback to any order currency we saw
    const currency =
      currencyFromSales ?? ordersInRange.find((o) => o.currency)?.currency ?? null;

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

