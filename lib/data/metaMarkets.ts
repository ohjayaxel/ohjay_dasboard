import { cache } from 'react';

import { getSupabaseServiceClient } from '@/lib/supabase/server';

type MetaMarketsParams = {
  tenantId: string;
  from: string;
  to: string;
};

export type MetaMarketMetrics = {
  country: string;
  spend: number;
  linkClicks: number;
  clicks: number;
  conversions: number;
  revenue: number;
  roas: number | null;
  cpa: number | null;
  currency: string | null;
};

const COUNTRY_PRIORITY_ORDER = ['DE', 'SE', 'NO', 'FI', 'OTHER'] as const;

function deriveMetrics({
  spend,
  revenue,
  conversions,
}: {
  spend: number;
  revenue: number;
  conversions: number;
}) {
  const roas = spend > 0 ? revenue / spend : null;
  const cpa = conversions > 0 ? spend / conversions : null;
  return { roas, cpa };
}

export const getMetaMarkets = cache(async ({ tenantId, from, to }: MetaMarketsParams) => {
  const client = getSupabaseServiceClient();

  const { data, error } = await client
    .from('meta_insights_daily')
    .select(
      [
        'date',
        'spend',
        'clicks',
        'inline_link_clicks',
        'conversions',
        'revenue',
        'currency',
        'breakdowns',
      ].join(','),
    )
    .eq('tenant_id', tenantId)
    .eq('level', 'account')
    .eq('action_report_time', 'conversion')
    .eq('attribution_window', '1d_click')
    .eq('breakdowns_key', 'country_priority')
    .gte('date', from)
    .lte('date', to);

  if (error) {
    throw new Error(`Failed to fetch meta markets: ${error.message}`);
  }

  const aggregates = new Map<string, MetaMarketMetrics>();

  for (const row of data ?? []) {
    const breakdowns = row.breakdowns as Record<string, string | null> | null;
    const country = (breakdowns?.country ?? 'OTHER') as string;
    const key = country || 'OTHER';

    if (!aggregates.has(key)) {
      aggregates.set(key, {
        country: key,
        spend: 0,
        clicks: 0,
        linkClicks: 0,
        conversions: 0,
        revenue: 0,
        roas: null,
        cpa: null,
        currency: row.currency ?? null,
      });
    }

    const target = aggregates.get(key)!;
    target.spend += row.spend ?? 0;
    target.clicks += row.clicks ?? 0;
    target.linkClicks += row.inline_link_clicks ?? 0;
    target.conversions += row.conversions ?? 0;
    target.revenue += row.revenue ?? 0;
  }

  const results: MetaMarketMetrics[] = Array.from(aggregates.values()).map((entry) => ({
    ...entry,
    ...deriveMetrics({
      spend: entry.spend,
      revenue: entry.revenue,
      conversions: entry.conversions,
    }),
  }));

  const priority = new Map(COUNTRY_PRIORITY_ORDER.map((country, index) => [country, index]));

  results.sort((a, b) => {
    const aRank = priority.has(a.country) ? priority.get(a.country)! : COUNTRY_PRIORITY_ORDER.length + 1;
    const bRank = priority.has(b.country) ? priority.get(b.country)! : COUNTRY_PRIORITY_ORDER.length + 1;

    if (aRank !== bRank) {
      return aRank - bRank;
    }

    return a.country.localeCompare(b.country);
  });

  const totals = results.reduce<MetaMarketMetrics>(
    (acc, row) => ({
      country: 'Total',
      spend: acc.spend + row.spend,
      clicks: acc.clicks + row.clicks,
      linkClicks: acc.linkClicks + row.linkClicks,
      conversions: acc.conversions + row.conversions,
      revenue: acc.revenue + row.revenue,
      roas: null,
      cpa: null,
      currency: acc.currency ?? row.currency,
    }),
    {
      country: 'Total',
      spend: 0,
      clicks: 0,
      linkClicks: 0,
      conversions: 0,
      revenue: 0,
      roas: null,
      cpa: null,
      currency: null,
    },
  );

  if (results.length > 0) {
    const metrics = deriveMetrics({
      spend: totals.spend,
      revenue: totals.revenue,
      conversions: totals.conversions,
    });
    totals.roas = metrics.roas;
    totals.cpa = metrics.cpa;
    results.push(totals);
  }

  return results;
});


