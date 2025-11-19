import { getSupabaseServiceClient } from '@/lib/supabase/server';

export type KpiSource = 'meta' | 'google_ads' | 'shopify' | 'all';

export type KpiDailyRow = {
  tenant_id: string;
  date: string;
  source: KpiSource;
  spend: number | null;
  clicks: number | null;
  conversions: number | null;
  revenue: number | null;
  aov: number | null;
  cos: number | null;
  roas: number | null;
  currency: string | null;
  gross_sales: number | null;
  net_sales: number | null;
  new_customer_conversions: number | null;
  returning_customer_conversions: number | null;
  new_customer_net_sales: number | null;
  returning_customer_net_sales: number | null;
};

type FetchKpiDailyParams = {
  tenantId: string;
  from?: string;
  to?: string;
  source?: KpiSource | KpiSource[];
  limit?: number;
  order?: 'asc' | 'desc';
};

export async function fetchKpiDaily(params: FetchKpiDailyParams): Promise<KpiDailyRow[]> {
  const client = getSupabaseServiceClient();

  let query = client
    .from('kpi_daily')
    .select('tenant_id, date, source, spend, clicks, conversions, revenue, aov, cos, roas, currency, gross_sales, net_sales, new_customer_conversions, returning_customer_conversions, new_customer_net_sales, returning_customer_net_sales')
    .eq('tenant_id', params.tenantId)
    .order('date', { ascending: params.order !== 'desc' });

  if (params.from) {
    query = query.gte('date', params.from);
  }

  if (params.to) {
    query = query.lte('date', params.to);
  }

  if (params.source) {
    if (Array.isArray(params.source)) {
      query = query.in('source', params.source);
    } else if (params.source !== 'all') {
      query = query.eq('source', params.source);
    }
  }

  if (params.limit) {
    query = query.limit(params.limit);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch KPI daily data: ${error.message}`);
  }

  return (data as KpiDailyRow[]) ?? [];
}

export async function fetchLatestKpiRow(params: {
  tenantId: string;
  source?: KpiSource | KpiSource[];
}): Promise<KpiDailyRow | null> {
  const rows = await fetchKpiDaily({
    tenantId: params.tenantId,
    source: params.source,
    limit: 1,
    order: 'desc',
  });

  return rows[0] ?? null;
}

