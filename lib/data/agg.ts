import { revalidatePath } from 'next/cache';
import { cache } from 'react';

import { fetchKpiDaily, fetchLatestKpiRow, type KpiDailyRow, type KpiSource } from './fetchers';

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
  // Fetch data from all sources
  const [shopifyRows, metaRows, googleRows] = await Promise.all([
    fetchKpiDaily({
      tenantId: params.tenantId,
      from: params.from,
      to: params.to,
      source: 'shopify',
    }),
    fetchKpiDaily({
      tenantId: params.tenantId,
      from: params.from,
      to: params.to,
      source: 'meta',
    }),
    fetchKpiDaily({
      tenantId: params.tenantId,
      from: params.from,
      to: params.to,
      source: 'google_ads',
    }),
  ]);

  // Aggregate by date
  const byDate = new Map<string, OverviewDataPoint>();

  // Process Shopify data
  for (const row of shopifyRows) {
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

    existing.gross_sales += row.gross_sales ?? 0;
    existing.net_sales += row.net_sales ?? 0;
    existing.orders += row.conversions ?? 0;
    
    let newCustomerNet = row.new_customer_net_sales ?? null;
    if (
      newCustomerNet === null &&
      row.new_customer_conversions &&
      row.conversions &&
      row.conversions > 0 &&
      row.net_sales
    ) {
      const newCustomerRatio = row.new_customer_conversions / row.conversions;
      newCustomerNet = row.net_sales * newCustomerRatio;
    }
    if (newCustomerNet !== null) {
      existing.new_customer_net_sales += newCustomerNet;
    }

    byDate.set(row.date, existing);
  }

  // Process Meta and Google Ads for marketing spend
  for (const row of [...metaRows, ...googleRows]) {
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

    existing.marketing_spend += row.spend ?? 0;
    byDate.set(row.date, existing);
  }

  // Calculate aMER and AOV for each date
  const series = Array.from(byDate.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((point) => {
      const amer = point.marketing_spend > 0 
        ? point.new_customer_net_sales / point.marketing_spend 
        : null;
      const aov = point.orders > 0 
        ? point.net_sales / point.orders 
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

  const currency = shopifyRows.find((row) => row.currency)?.currency ?? null;

  return { series, totals, currency };
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

export async function getMarketsData(params: {
  tenantId: string;
  from?: string;
  to?: string;
}): Promise<MarketsResult> {
  const { getSupabaseServiceClient } = await import('@/lib/supabase/server');
  const supabase = getSupabaseServiceClient();

  // Fetch Shopify orders with country - paginate to get all orders
  const orders: Array<{
    country: string;
    gross_sales: number | null;
    net_sales: number | null;
    is_new_customer: boolean | null;
    is_refund: boolean | null;
    processed_at: string | null;
    currency: string | null;
  }> = [];

  let offset = 0;
  const limit = 1000;
  let hasMore = true;

  while (hasMore) {
    let ordersQuery = supabase
      .from('shopify_orders')
      .select('country, gross_sales, net_sales, is_new_customer, is_refund, processed_at, currency')
      .eq('tenant_id', params.tenantId)
      .not('country', 'is', null)
      .not('gross_sales', 'is', null)
      .gt('gross_sales', 0)
      .range(offset, offset + limit - 1)
      .order('processed_at', { ascending: false });

    if (params.from) {
      ordersQuery = ordersQuery.gte('processed_at', params.from);
    }

    if (params.to) {
      ordersQuery = ordersQuery.lte('processed_at', params.to);
    }

    const { data: batch, error: ordersError } = await ordersQuery;

    if (ordersError) {
      throw new Error(`Failed to fetch Shopify orders: ${ordersError.message}`);
    }

    if (!batch || batch.length === 0) {
      hasMore = false;
    } else {
      orders.push(...batch);
      offset += limit;
      
      // If we got fewer than limit, we've reached the end
      if (batch.length < limit) {
        hasMore = false;
      }
    }
  }

  // Fetch marketing spend with country breakdown from Meta insights if available
  // Otherwise fall back to aggregating total spend and distributing proportionally
  // Only fetch insights with country breakdown (country_priority or country breakdown keys)
  const { data: metaInsightsWithCountry } = await supabase
    .from('meta_insights_daily')
    .select('date, spend, breakdowns, breakdowns_key')
    .eq('tenant_id', params.tenantId)
    .gte('date', params.from ?? '1970-01-01')
    .lte('date', params.to ?? '2100-01-01')
    .eq('action_report_time', 'impression')
    .eq('attribution_window', '1d_click')
    .in('breakdowns_key', ['country_priority', 'country'])
    .not('spend', 'is', null)
    .gt('spend', 0)
    .not('breakdowns', 'is', null);

  // Try to fetch Google Ads spend (no country breakdown available currently)
  const googleRows = await fetchKpiDaily({
    tenantId: params.tenantId,
    from: params.from,
    to: params.to,
    source: 'google_ads',
  });

  const totalGoogleSpend = sum(googleRows.map((row) => row.spend ?? 0));

  // Aggregate Meta spend by country if we have country breakdown data
  const metaSpendByCountry = new Map<string, number>();
  let totalMetaSpend = 0;

  if (metaInsightsWithCountry && metaInsightsWithCountry.length > 0) {
    for (const insight of metaInsightsWithCountry) {
      const spend = Number(insight.spend) || 0;
      totalMetaSpend += spend;

      // Check if this insight has country breakdown
      if (insight.breakdowns && typeof insight.breakdowns === 'object') {
        const breakdowns = insight.breakdowns as Record<string, unknown>;
        const country = breakdowns.country as string | undefined;

        if (country) {
          const existing = metaSpendByCountry.get(country) ?? 0;
          metaSpendByCountry.set(country, existing + spend);
        }
      }
    }
  }

  // If we don't have country breakdown data, fetch aggregated Meta spend
  if (metaSpendByCountry.size === 0) {
    const metaRows = await fetchKpiDaily({
      tenantId: params.tenantId,
      from: params.from,
      to: params.to,
      source: 'meta',
    });
    totalMetaSpend = sum(metaRows.map((row) => row.spend ?? 0));
  }

  // Aggregate Shopify orders by country
  const byCountry = new Map<string, MarketsDataPoint>();

  for (const order of orders ?? []) {
    const country = order.country as string;
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

    const grossSales = Number(order.gross_sales) || 0;
    const netSales = Number(order.net_sales) || 0;
    const isNewCustomer = order.is_new_customer === true;
    const isRefund = order.is_refund === true;

    existing.gross_sales += grossSales;
    existing.net_sales += netSales;

    // Only count orders (not refunds) for order count
    if (!isRefund) {
      existing.orders += 1;
    }

    // Calculate new customer net sales
    if (isNewCustomer && !isRefund) {
      existing.new_customer_net_sales += netSales;
    }

    byCountry.set(country, existing);
  }

  // Assign marketing spend per country
  // If we have Meta country breakdown, use it. Otherwise distribute proportionally based on net_sales
  const totalNetSales = sum(Array.from(byCountry.values()).map((p) => p.net_sales));
  const totalMarketingSpend = totalMetaSpend + totalGoogleSpend;
  
  const series = Array.from(byCountry.values())
    .map((point) => {
      let marketingSpend = 0;

      // Use Meta country breakdown if available
      const metaSpendForCountry = metaSpendByCountry.get(point.country) ?? 0;
      
      if (metaSpendByCountry.size > 0) {
        // We have country breakdown: use Meta spend per country + distribute Google spend proportionally
        const googleSpendProportion = totalNetSales > 0 
          ? point.net_sales / totalNetSales 
          : 0;
        marketingSpend = metaSpendForCountry + (googleSpendProportion * totalGoogleSpend);
      } else {
        // No country breakdown: distribute total marketing spend proportionally based on net_sales
        marketingSpend = totalNetSales > 0 
          ? (point.net_sales / totalNetSales) * totalMarketingSpend
          : 0;
      }

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
    .sort((a, b) => b.gross_sales - a.gross_sales); // Sort by gross_sales descending

  // Calculate totals
  const totalGrossSalesCalculated = sum(series.map((p) => p.gross_sales));
  const totalNetSales = sum(series.map((p) => p.net_sales));
  const totalNewCustomerNetSales = sum(series.map((p) => p.new_customer_net_sales));
  const totalOrders = sum(series.map((p) => p.orders));

  const totals: MarketsTotals = {
    gross_sales: totalGrossSalesCalculated,
    net_sales: totalNetSales,
    new_customer_net_sales: totalNewCustomerNetSales,
    marketing_spend: totalMarketingSpend,
    amer: totalMarketingSpend > 0 ? totalNewCustomerNetSales / totalMarketingSpend : null,
    orders: totalOrders,
    aov: totalOrders > 0 ? totalNetSales / totalOrders : null,
  };

  const currency = orders?.find((order) => order.currency)?.currency ?? null;

  return { series, totals, currency };
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

