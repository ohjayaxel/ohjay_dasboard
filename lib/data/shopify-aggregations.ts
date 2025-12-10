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
  orders?: number;
  new_customer_net_sales?: number;
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
 * Includes orders count and new customer metrics by joining with shopify_orders
 */
export async function aggregateDailySales(
  tenantId: string,
  from: string,
  to: string,
): Promise<DailySalesAggregation[]> {
  const client = getSupabaseServiceClient();

  // Fetch all transactions for the date range
  // Note: Supabase has a default limit of 1000 rows, so we need to fetch in batches
  // or use a higher limit. For daily aggregations, we'll fetch in batches.
  const TRANSACTION_BATCH_SIZE = 10000;
  let allTransactions: any[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: batch, error: transactionsError } = await client
      .from('shopify_sales_transactions')
      .select('event_date, gross_sales, discounts, returns, shopify_order_id, event_type')
      .eq('tenant_id', tenantId)
      .gte('event_date', from)
      .lte('event_date', to)
      .range(offset, offset + TRANSACTION_BATCH_SIZE - 1)
      .order('event_date', { ascending: true });

    if (transactionsError) {
      throw new Error(`Failed to fetch transactions: ${transactionsError.message}`);
    }

    if (batch && batch.length > 0) {
      allTransactions.push(...batch);
      offset += TRANSACTION_BATCH_SIZE;
      hasMore = batch.length === TRANSACTION_BATCH_SIZE;
    } else {
      hasMore = false;
    }
  }

  const transactions = allTransactions;

  // Get unique order IDs per date (only SALE events count as orders)
  const orderIdsByDate = new Map<string, Set<string>>();
  for (const txn of transactions) {
    if (txn.event_type === 'SALE') {
      const date = txn.event_date as string;
      const orderId = txn.shopify_order_id as string;
      if (!orderIdsByDate.has(date)) {
        orderIdsByDate.set(date, new Set());
      }
      orderIdsByDate.get(date)!.add(orderId);
    }
  }

  // Fetch shopify_orders for new customer data
  const orderIds = new Set<string>();
  for (const orderSet of orderIdsByDate.values()) {
    for (const orderId of orderSet) {
      orderIds.add(orderId);
    }
  }

  let ordersData: Array<{
    order_id: string;
    processed_at: string | null;
    is_new_customer: boolean | null;
    net_sales: number | null;
  }> = [];

  if (orderIds.size > 0) {
    // Fetch in batches of 1000
    const orderIdArray = Array.from(orderIds);
    for (let i = 0; i < orderIdArray.length; i += 1000) {
      const batch = orderIdArray.slice(i, i + 1000);
      const { data: batchData, error: ordersError } = await client
        .from('shopify_orders')
        .select('order_id, processed_at, is_new_customer, net_sales')
        .eq('tenant_id', tenantId)
        .in('order_id', batch);

      if (ordersError) {
        console.warn(`Failed to fetch orders batch: ${ordersError.message}`);
      } else if (batchData) {
        ordersData.push(...batchData);
      }
    }
  }

  // Create a map of order_id -> order data
  const ordersMap = new Map(
    ordersData.map((o) => [o.order_id, o])
  );

  // Aggregate by date
  const byDate = new Map<string, DailySalesAggregation>();

  for (const transaction of transactions) {
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
      orders: 0,
      new_customer_net_sales: 0,
    };

    existing.gross_sales += grossSales;
    existing.discounts += discounts;
    existing.returns += returns;
    existing.net_sales += grossSales - discounts - returns;
    existing.transaction_count += 1;

    byDate.set(date, existing);
  }

  // Add orders count and new customer net sales
  for (const [date, orderSet] of orderIdsByDate.entries()) {
    const existing = byDate.get(date);
    if (existing) {
      existing.orders = orderSet.size;

      // Calculate new customer net sales for this date
      // Use transactions on this date that belong to new customer orders
      let newCustomerNetSales = 0;
      for (const orderId of orderSet) {
        const order = ordersMap.get(orderId);
        if (order && order.is_new_customer === true) {
          // Get net sales from transactions for this order on this date (SALE events only)
          const orderTransactions = transactions.filter(
            (t) => t.shopify_order_id === orderId && t.event_date === date && t.event_type === 'SALE'
          );
          const orderNetSales = orderTransactions.reduce((sum, t) => {
            const gross = parseFloat((t.gross_sales || 0).toString());
            const disc = parseFloat((t.discounts || 0).toString());
            const ret = parseFloat((t.returns || 0).toString());
            return sum + (gross - disc - ret);
          }, 0);
          newCustomerNetSales += orderNetSales;
        }
      }
      existing.new_customer_net_sales = newCustomerNetSales;
    }
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
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

