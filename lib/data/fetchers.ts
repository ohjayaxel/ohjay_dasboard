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

export type SalesMode = 'shopify' | 'financial';

export type ShopifyDailySalesRow = {
  tenant_id: string;
  date: string;
  mode: SalesMode;
  net_sales_excl_tax: number;
  gross_sales_excl_tax: number | null;
  refunds_excl_tax: number | null;
  discounts_excl_tax: number | null;
  orders_count: number;
  currency: string | null;
  new_customer_net_sales: number | null;
  returning_customer_net_sales: number | null;
  guest_net_sales: number | null;
};

export type FetchShopifyDailySalesParams = {
  tenantId: string;
  from?: string;
  to?: string;
  mode?: SalesMode;
  limit?: number;
  order?: 'asc' | 'desc';
};

/**
 * Fetches daily Shopify sales aggregated by mode
 */
export async function fetchShopifyDailySales(
  params: FetchShopifyDailySalesParams,
): Promise<ShopifyDailySalesRow[]> {
  const client = getSupabaseServiceClient();

  let query = client
    .from('shopify_daily_sales')
    .select(
      'tenant_id, date, mode, net_sales_excl_tax, gross_sales_excl_tax, refunds_excl_tax, discounts_excl_tax, orders_count, currency, new_customer_net_sales, returning_customer_net_sales, guest_net_sales',
    )
    .eq('tenant_id', params.tenantId)
    .order('date', { ascending: params.order !== 'desc' });

  if (params.from) {
    query = query.gte('date', params.from);
  }

  if (params.to) {
    query = query.lte('date', params.to);
  }

  if (params.mode) {
    query = query.eq('mode', params.mode);
  }

  if (params.limit) {
    query = query.limit(params.limit);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch Shopify daily sales: ${error.message}`);
  }

  return (data || []) as ShopifyDailySalesRow[];
}

export async function fetchKpiDaily(params: FetchKpiDailyParams): Promise<KpiDailyRow[]> {
  const client = getSupabaseServiceClient();

  // Try to fetch with currency column first (for migrated databases)
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

  // If error is about missing currency column, retry without it (for non-migrated databases)
  if (error && error.message?.includes('currency') && error.message?.includes('does not exist')) {
    console.warn('Currency column not found in kpi_daily, fetching without it. Run migration 009_kpi_daily_currency.sql');
    
    let fallbackQuery = client
      .from('kpi_daily')
      .select('tenant_id, date, source, spend, clicks, conversions, revenue, aov, cos, roas, gross_sales, net_sales, new_customer_conversions, returning_customer_conversions, new_customer_net_sales, returning_customer_net_sales')
      .eq('tenant_id', params.tenantId)
      .order('date', { ascending: params.order !== 'desc' });
    
    if (params.from) {
      fallbackQuery = fallbackQuery.gte('date', params.from);
    }
    if (params.to) {
      fallbackQuery = fallbackQuery.lte('date', params.to);
    }
    if (params.source) {
      if (Array.isArray(params.source)) {
        fallbackQuery = fallbackQuery.in('source', params.source);
      } else if (params.source !== 'all') {
        fallbackQuery = fallbackQuery.eq('source', params.source);
      }
    }
    if (params.limit) {
      fallbackQuery = fallbackQuery.limit(params.limit);
    }
    
    const { data: fallbackData, error: fallbackError } = await fallbackQuery;
    
    if (fallbackError) {
      throw new Error(`Failed to fetch KPI daily data: ${fallbackError.message}`);
    }
    
    // Map results to include currency as null
    return ((fallbackData as KpiDailyRow[]) ?? []).map(row => ({
      ...row,
      currency: null,
    }));
  }

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

