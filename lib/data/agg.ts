import { cache } from 'react';

import { revalidatePath } from 'next/cache';

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

export const getKpiDaily = cache(async (params: GetKpiDailyParams): Promise<KpiSeriesResult> => {
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
});

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

export async function revalidateKpiForTenant(tenantSlug: string) {
  const routes = [
    `/t/${tenantSlug}`,
    `/t/${tenantSlug}/meta`,
    `/t/${tenantSlug}/google`,
    `/t/${tenantSlug}/shopify`,
  ];

  for (const route of routes) {
    revalidatePath(route, 'page');
  }
}

