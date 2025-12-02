/**
 * Aggregation queries for shopify_sales_transactions table
 * 
 * Provides functions to aggregate daily and monthly sales from the
 * shopify_sales_transactions table for 100% matching with Shopify Sales reports.
 */

import { getSupabaseServiceClient } from '@/lib/supabase/server';

export type DailySalesAggregation = {
  date: string;
  gross_sales: number;
  discounts: number;
  returns: number;
  net_sales: number;
  transaction_count: number;
};

export type MonthlySalesAggregation = {
  year: number;
  month: number;
  gross_sales: number;
  discounts: number;
  returns: number;
  net_sales: number;
  transaction_count: number;
};

/**
 * Aggregates daily sales from shopify_sales_transactions table
 */
export async function aggregateDailySales(
  tenantId: string,
  from: string,
  to: string,
): Promise<DailySalesAggregation[]> {
  const client = getSupabaseServiceClient();

  const { data, error } = await client.rpc('aggregate_shopify_daily_sales', {
    p_tenant_id: tenantId,
    p_from_date: from,
    p_to_date: to,
  });

  if (error) {
    // If RPC function doesn't exist, fall back to direct query
    const { data: directData, error: directError } = await client
      .from('shopify_sales_transactions')
      .select('event_date')
      .eq('tenant_id', tenantId)
      .gte('event_date', from)
      .lte('event_date', to);

    if (directError) {
      throw new Error(`Failed to aggregate daily sales: ${directError.message}`);
    }

    // Group by date manually
    const byDate = new Map<string, DailySalesAggregation>();

    if (directData) {
      for (const row of directData) {
        const date = row.event_date as string;
        if (!byDate.has(date)) {
          byDate.set(date, {
            date,
            gross_sales: 0,
            discounts: 0,
            returns: 0,
            net_sales: 0,
            transaction_count: 0,
          });
        }
      }
    }

    // Fetch all transactions for aggregation
    const { data: transactions, error: transactionsError } = await client
      .from('shopify_sales_transactions')
      .select('event_date, gross_sales, discounts, returns')
      .eq('tenant_id', tenantId)
      .gte('event_date', from)
      .lte('event_date', to);

    if (transactionsError) {
      throw new Error(`Failed to fetch transactions: ${transactionsError.message}`);
    }

    // Aggregate manually
    for (const transaction of transactions || []) {
      const date = transaction.event_date as string;
      const grossSales = parseFloat((transaction.gross_sales || 0).toString());
      const discounts = parseFloat((transaction.discounts || 0).toString());
      const returns = parseFloat((transaction.returns || 0).toString());

      const existing = byDate.get(date) || {
        date,
        gross_sales: 0,
        discounts: 0,
        returns: 0,
        net_sales: 0,
        transaction_count: 0,
      };

      existing.gross_sales += grossSales;
      existing.discounts += discounts;
      existing.returns += returns;
      existing.net_sales += grossSales - discounts - returns;
      existing.transaction_count += 1;

      byDate.set(date, existing);
    }

    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  return (data || []) as DailySalesAggregation[];
}

/**
 * Aggregates monthly sales from shopify_sales_transactions table
 */
export async function aggregateMonthlySales(
  tenantId: string,
  from: string,
  to: string,
): Promise<MonthlySalesAggregation[]> {
  const client = getSupabaseServiceClient();

  const { data, error } = await client.rpc('aggregate_shopify_monthly_sales', {
    p_tenant_id: tenantId,
    p_from_date: from,
    p_to_date: to,
  });

  if (error) {
    // If RPC function doesn't exist, fall back to direct query with manual aggregation
    const { data: transactions, error: transactionsError } = await client
      .from('shopify_sales_transactions')
      .select('event_date, gross_sales, discounts, returns')
      .eq('tenant_id', tenantId)
      .gte('event_date', from)
      .lte('event_date', to);

    if (transactionsError) {
      throw new Error(`Failed to fetch transactions: ${transactionsError.message}`);
    }

    // Group by year-month
    const byMonth = new Map<string, MonthlySalesAggregation>();

    for (const transaction of transactions || []) {
      const date = new Date(transaction.event_date as string);
      const year = date.getFullYear();
      const month = date.getMonth() + 1; // 1-12
      const key = `${year}-${month.toString().padStart(2, '0')}`;

      const existing = byMonth.get(key) || {
        year,
        month,
        gross_sales: 0,
        discounts: 0,
        returns: 0,
        net_sales: 0,
        transaction_count: 0,
      };

      const grossSales = parseFloat((transaction.gross_sales || 0).toString());
      const discounts = parseFloat((transaction.discounts || 0).toString());
      const returns = parseFloat((transaction.returns || 0).toString());

      existing.gross_sales += grossSales;
      existing.discounts += discounts;
      existing.returns += returns;
      existing.net_sales += grossSales - discounts - returns;
      existing.transaction_count += 1;

      byMonth.set(key, existing);
    }

    return Array.from(byMonth.values()).sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return a.month - b.month;
    });
  }

  return (data || []) as MonthlySalesAggregation[];
}

/**
 * Gets transaction-level detail for a specific date range
 */
export async function getTransactionDetails(
  tenantId: string,
  from: string,
  to: string,
  limit?: number,
) {
  const client = getSupabaseServiceClient();

  let query = client
    .from('shopify_sales_transactions')
    .select('*')
    .eq('tenant_id', tenantId)
    .gte('event_date', from)
    .lte('event_date', to)
    .order('event_date', { ascending: false });

  if (limit) {
    query = query.limit(limit);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch transaction details: ${error.message}`);
  }

  return data || [];
}

