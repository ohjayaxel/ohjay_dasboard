#!/usr/bin/env -S tsx

/**
 * Shopify backfill CLI
 *
 * Usage:
 *   source env/local.prod.sh
 *   pnpm tsx scripts/shopify_backfill.ts \
 *     --tenant orange-juice-demo \
 *     --since 2025-01-01
 *
 * Options:
 *   --tenant <slug>       (obligatorisk) Tenant slug
 *   --since <YYYY-MM-DD>  (obligatorisk) Start date for backfill
 *   --until <YYYY-MM-DD>  (optional) End date (defaults to today)
 *   --dry-run            (optional) Don't save to database, just fetch and display
 */

import { ArgumentParser } from 'argparse';
import { createClient } from '@supabase/supabase-js';

import { decryptSecret } from '@/lib/integrations/crypto';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

const supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

type ShopifyRefund = {
  id: number;
  created_at: string;
  refund_line_items?: Array<{ subtotal: string }>;
  transactions?: Array<{ amount: string }>;
};

type ShopifyOrder = {
  id: string;
  order_number: number;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
  total_price: string;
  subtotal_price: string;
  total_discounts: string;
  currency: string;
  customer?: { id: string };
  refunds?: Array<ShopifyRefund>;
  email?: string;
  financial_status?: string;
  fulfillment_status?: string;
};

type ShopifyOrderRow = {
  tenant_id: string;
  order_id: string;
  processed_at: string | null;
  total_price: number | null;
  discount_total: number | null;
  total_refunds: number | null;
  currency: string | null;
  customer_id: string | null;
  is_refund: boolean;
  gross_sales: number | null;
  net_sales: number | null;
  is_new_customer: boolean;
};

function normalizeShopDomain(domain: string): string {
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function mapShopifyOrderToRow(tenantId: string, order: ShopifyOrder): ShopifyOrderRow {
  const processedAt = order.processed_at
    ? new Date(order.processed_at).toISOString().slice(0, 10)
    : null;

  const isRefund = Array.isArray(order.refunds) && order.refunds.length > 0;

  const totalPrice = parseFloat(order.total_price || '0');
  const subtotalPrice = parseFloat(order.subtotal_price || '0');
  const totalDiscounts = parseFloat(order.total_discounts || '0');
  
  // Calculate total refunds amount
  // Note: subtotal_price from Shopify already reflects value AFTER refunds
  let totalRefunds = 0;
  if (Array.isArray(order.refunds) && order.refunds.length > 0) {
    for (const refund of order.refunds) {
      // Try to get refund amount from transactions first (most accurate)
      if (refund.transactions && Array.isArray(refund.transactions)) {
        for (const transaction of refund.transactions) {
          totalRefunds += parseFloat(transaction.amount || '0');
        }
      } else if (refund.refund_line_items && Array.isArray(refund.refund_line_items)) {
        // Fallback to refund_line_items subtotal
        for (const item of refund.refund_line_items) {
          totalRefunds += parseFloat(item.subtotal || '0');
        }
      }
    }
  }
  
  // gross_sales = (subtotal_price after refunds) + total_discounts + total_refunds
  // This gives us the original gross sales before discounts and refunds
  // net_sales = subtotal_price (already includes refunds, after discounts, excluding shipping/tax)
  const grossSales = (subtotalPrice + totalDiscounts + totalRefunds) > 0 
    ? subtotalPrice + totalDiscounts + totalRefunds 
    : null;
  const netSales = subtotalPrice > 0 ? subtotalPrice : null;
  
  // Calculate discount_total for backward compatibility
  const discountTotal = totalDiscounts || 0;

  return {
    tenant_id: tenantId,
    order_id: order.id.toString(),
    processed_at: processedAt,
    total_price: totalPrice || null,
    discount_total: discountTotal || null,
    total_refunds: totalRefunds || null,
    currency: order.currency || null,
    customer_id: order.customer?.id?.toString() || null,
    is_refund: isRefund,
    gross_sales: grossSales,
    net_sales: netSales,
    is_new_customer: false, // Will be determined during batch processing
  };
}

function aggregateKpis(rows: ShopifyOrderRow[]) {
  const byDate = new Map<
    string,
    {
      revenue: number;
      gross_sales: number;
      net_sales: number;
      conversions: number;
      new_customer_conversions: number;
      returning_customer_conversions: number;
      currencies: Map<string, number>; // Track currency frequency
    }
  >();

  for (const row of rows) {
    if (!row.processed_at) continue;
    const existing = byDate.get(row.processed_at) ?? {
      revenue: 0,
      gross_sales: 0,
      net_sales: 0,
      conversions: 0,
      new_customer_conversions: 0,
      returning_customer_conversions: 0,
      currencies: new Map<string, number>(),
    };

    if (!row.is_refund) {
      existing.revenue += row.total_price ?? 0;
      existing.gross_sales += row.gross_sales ?? 0;
      existing.net_sales += row.net_sales ?? 0;
      existing.conversions += 1;
      
      // Track currency frequency (use most common currency for the day)
      if (row.currency) {
        const count = existing.currencies.get(row.currency) ?? 0;
        existing.currencies.set(row.currency, count + 1);
      }
      
      if (row.is_new_customer) {
        existing.new_customer_conversions += 1;
      } else {
        existing.returning_customer_conversions += 1;
      }
    } else {
      // For refunds, subtract from revenue and sales
      existing.revenue -= row.total_price ?? 0;
      existing.gross_sales -= row.gross_sales ?? 0;
      existing.net_sales -= row.net_sales ?? 0;
    }
    byDate.set(row.processed_at, existing);
  }

  return Array.from(byDate.entries()).map(([date, values]) => {
    const aov = values.conversions > 0 ? values.revenue / values.conversions : null;
    
    // Find most common currency for this date
    let mostCommonCurrency: string | null = null;
    let maxCount = 0;
    for (const [currency, count] of values.currencies.entries()) {
      if (count > maxCount) {
        maxCount = count;
        mostCommonCurrency = currency;
      }
    }
    
    return {
      date,
      spend: 0,
      clicks: null,
      conversions: values.conversions || null,
      revenue: values.revenue || null,
      gross_sales: values.gross_sales || null,
      net_sales: values.net_sales || null,
      new_customer_conversions: values.new_customer_conversions || null,
      returning_customer_conversions: values.returning_customer_conversions || null,
      currency: mostCommonCurrency,
      aov,
      cos: null,
      roas: null,
    };
  });
}

async function fetchShopifyOrdersWithPagination(params: {
  shopDomain: string;
  accessToken: string;
  since?: string;
  until?: string;
}): Promise<ShopifyOrder[]> {
  const normalizedShop = normalizeShopDomain(params.shopDomain);
  const allOrders: ShopifyOrder[] = [];
  let pageInfo: string | null = null;
  let page = 1;

  console.log(`\n[shopify_backfill] Fetching orders from ${params.since || 'all time'}...`);

  while (true) {
    const url = new URL(`https://${normalizedShop}/admin/api/2023-10/orders.json`);
    url.searchParams.set('limit', '250'); // Max limit per page

    if (pageInfo) {
      // When using page_info, we can only set page_info and limit
      url.searchParams.set('page_info', pageInfo);
    } else {
      // On first page, we can set status and date filters
      url.searchParams.set('status', 'any');
      if (params.since) {
        url.searchParams.set('created_at_min', params.since);
      }
      if (params.until) {
        url.searchParams.set('created_at_max', params.until);
      }
    }

    console.log(`[shopify_backfill] Fetching page ${page}${pageInfo ? ' (pagination)' : ''}...`);

    const res = await fetch(url.toString(), {
      headers: {
        'X-Shopify-Access-Token': params.accessToken,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify orders fetch failed: ${res.status} ${body}`);
    }

    const body = await res.json();
    const orders = (body.orders ?? []) as ShopifyOrder[];

    allOrders.push(...orders);
    console.log(`[shopify_backfill] Fetched ${orders.length} orders (total: ${allOrders.length})`);

    // Check for next page via Link header
    const linkHeader = res.headers.get('link');
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const nextMatch = linkHeader.match(/<([^>]+)>; rel="next"/);
      if (nextMatch) {
        const nextUrl = new URL(nextMatch[1]);
        pageInfo = nextUrl.searchParams.get('page_info');
        if (!pageInfo) {
          break;
        }
        page++;
      } else {
        break;
      }
    } else {
      // No next page
      break;
    }
  }

  console.log(`[shopify_backfill] Total orders fetched: ${allOrders.length}`);
  return allOrders;
}

async function main() {
  const parser = new ArgumentParser({
    description: 'Shopify backfill CLI',
  });

  parser.add_argument('--tenant', {
    required: true,
    help: 'Tenant slug (e.g., orange-juice-demo)',
  });

  parser.add_argument('--since', {
    required: true,
    help: 'Start date (YYYY-MM-DD)',
  });

  parser.add_argument('--until', {
    required: false,
    help: 'End date (YYYY-MM-DD, defaults to today)',
  });

  parser.add_argument('--dry-run', {
    action: 'store_true',
    help: "Don't save to database, just fetch and display",
  });

  const args = parser.parse_args();

  const sinceDate = new Date(args.since);
  if (Number.isNaN(sinceDate.getTime())) {
    throw new Error(`Invalid --since date: ${args.since}`);
  }

  const untilDate = args.until ? new Date(args.until) : new Date();
  if (Number.isNaN(untilDate.getTime())) {
    throw new Error(`Invalid --until date: ${args.until}`);
  }

  const since = args.since;
  const until = untilDate.toISOString().slice(0, 10);

  console.log(`\n[shopify_backfill] Starting backfill for tenant: ${args.tenant}`);
  console.log(`[shopify_backfill] Period: ${since} to ${until}`);
  console.log(`[shopify_backfill] Dry run: ${args.dry_run ? 'YES' : 'NO'}\n`);

  const supabase = supabaseClient;

  // Get tenant ID from slug
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, name, slug')
    .eq('slug', args.tenant)
    .maybeSingle();

  if (tenantError) {
    throw new Error(`Failed to fetch tenant: ${tenantError.message}`);
  }

  if (!tenant) {
    throw new Error(`Tenant not found: ${args.tenant}`);
  }

  console.log(`[shopify_backfill] Found tenant: ${tenant.name} (${tenant.id})`);

  // Get Shopify connection
  const { data: connection, error: connectionError } = await supabase
    .from('connections')
    .select('id, status, access_token_enc, meta')
    .eq('tenant_id', tenant.id)
    .eq('source', 'shopify')
    .maybeSingle();

  if (connectionError) {
    throw new Error(`Failed to fetch Shopify connection: ${connectionError.message}`);
  }

  if (!connection) {
    throw new Error(`No Shopify connection found for tenant ${args.tenant}`);
  }

  if (connection.status !== 'connected') {
    throw new Error(`Shopify connection is not connected (status: ${connection.status})`);
  }

  const shopDomain = connection.meta?.store_domain || connection.meta?.shop;
  if (!shopDomain || typeof shopDomain !== 'string') {
    throw new Error('No shop domain found in connection metadata');
  }

  console.log(`[shopify_backfill] Shop domain: ${shopDomain}`);

  // Decrypt access token
  const accessToken = decryptSecret(connection.access_token_enc);
  if (!accessToken) {
    throw new Error('Failed to decrypt access token');
  }

  console.log(`[shopify_backfill] Access token decrypted successfully\n`);

  // Fetch orders
  const shopifyOrders = await fetchShopifyOrdersWithPagination({
    shopDomain,
    accessToken,
    since,
    until,
  });

  if (shopifyOrders.length === 0) {
    console.log('\n[shopify_backfill] No orders found for the specified period.');
    return;
  }

  // Map to database rows
  let orderRows = shopifyOrders.map((order) => mapShopifyOrderToRow(tenant.id, order));

  // Determine if customers are new or returning
  // Sort orders by processed_at (oldest first) to process chronologically
  orderRows.sort((a, b) => {
    if (!a.processed_at) return 1;
    if (!b.processed_at) return -1;
    return a.processed_at.localeCompare(b.processed_at);
  });

  // Get all unique customer IDs from this batch
  const customerIdsInBatch = new Set<string>();
  orderRows.forEach((row) => {
    if (row.customer_id) {
      customerIdsInBatch.add(row.customer_id);
    }
  });

  // Bulk check: Get earliest processed_at for each customer from database
  const customerEarliestOrder = new Map<string, string | null>();
  if (customerIdsInBatch.size > 0) {
    const { data: existingOrders, error: lookupError } = await supabase
      .from('shopify_orders')
      .select('customer_id, processed_at')
      .eq('tenant_id', tenant.id)
      .in('customer_id', Array.from(customerIdsInBatch))
      .not('customer_id', 'is', null)
      .not('processed_at', 'is', null);

    if (lookupError) {
      console.warn(`[shopify_backfill] Failed to lookup existing orders: ${lookupError.message}`);
    } else if (existingOrders) {
      for (const order of existingOrders) {
        const customerId = order.customer_id as string;
        const processedAt = order.processed_at as string;
        const currentEarliest = customerEarliestOrder.get(customerId);
        if (!currentEarliest || (processedAt && processedAt < currentEarliest)) {
          customerEarliestOrder.set(customerId, processedAt);
        }
      }
    }
  }

  // Track customers seen in this batch chronologically
  const customersSeenInBatch = new Map<string, string>();

  // Determine is_new_customer for each order
  orderRows = orderRows.map((row) => {
    if (!row.customer_id || !row.processed_at) {
      return { ...row, is_new_customer: false };
    }

    // Check if we've seen this customer earlier in this batch
    const seenInBatchAt = customersSeenInBatch.get(row.customer_id);
    if (seenInBatchAt && seenInBatchAt < row.processed_at) {
      customersSeenInBatch.set(row.customer_id, seenInBatchAt);
      return { ...row, is_new_customer: false };
    }

    // Check if customer exists in database with earlier order
    const earliestInDb = customerEarliestOrder.get(row.customer_id);
    if (earliestInDb && earliestInDb < row.processed_at) {
      customersSeenInBatch.set(row.customer_id, earliestInDb);
      return { ...row, is_new_customer: false };
    }

    // This is a new customer (first order in batch and no earlier order in DB)
    if (!seenInBatchAt) {
      customersSeenInBatch.set(row.customer_id, row.processed_at);
    }
    return { ...row, is_new_customer: true };
  });

  console.log(`\n[shopify_backfill] Mapped ${orderRows.length} orders to database rows`);

  if (args.dry_run) {
    console.log('\n[shopify_backfill] DRY RUN - Not saving to database');
    console.log('\n[shopify_backfill] Sample order:');
    console.log(JSON.stringify(orderRows[0], null, 2));
    return;
  }

  // Save orders to database
  console.log(`\n[shopify_backfill] Upserting orders to shopify_orders table...`);
  const { error: upsertError } = await supabase.from('shopify_orders').upsert(orderRows, {
    onConflict: 'tenant_id,order_id',
  });

  if (upsertError) {
    throw new Error(`Failed to upsert orders: ${upsertError.message}`);
  }

  console.log(`[shopify_backfill] Successfully saved ${orderRows.length} orders`);

  // Aggregate KPIs
  const aggregates = aggregateKpis(orderRows);
  const kpiRows = aggregates.map((row) => ({
    tenant_id: tenant.id,
    date: row.date,
    source: 'shopify',
    spend: row.spend,
    clicks: row.clicks,
    conversions: row.conversions,
    revenue: row.revenue,
    gross_sales: row.gross_sales,
    net_sales: row.net_sales,
    new_customer_conversions: row.new_customer_conversions,
    returning_customer_conversions: row.returning_customer_conversions,
    currency: row.currency,
    aov: row.aov,
    cos: row.cos,
    roas: row.roas,
  }));

  console.log(`\n[shopify_backfill] Aggregated ${kpiRows.length} KPI rows`);

  // Save KPIs to database
  console.log(`[shopify_backfill] Upserting KPIs to kpi_daily table...`);
  const { error: kpiError } = await supabase.from('kpi_daily').upsert(kpiRows, {
    onConflict: 'tenant_id,date,source',
  });

  if (kpiError) {
    throw new Error(`Failed to upsert KPIs: ${kpiError.message}`);
  }

  console.log(`[shopify_backfill] Successfully saved ${kpiRows.length} KPI rows`);

  // Clear backfill flag if it exists
  if (connection.meta?.backfill_since) {
    const clearedMeta = {
      ...(connection.meta ?? {}),
      backfill_since: null,
    };

    const { error: clearError } = await supabase
      .from('connections')
      .update({
        meta: clearedMeta,
        updated_at: new Date().toISOString(),
      })
      .eq('id', connection.id);

    if (clearError) {
      console.warn(`[shopify_backfill] Failed to clear backfill flag: ${clearError.message}`);
    } else {
      console.log(`[shopify_backfill] Cleared backfill_since flag`);
    }
  }

  console.log('\n[shopify_backfill] ✅ Backfill completed successfully!');
  console.log(`\n[shopify_backfill] Summary:`);
  console.log(`  - Orders processed: ${orderRows.length}`);
  console.log(`  - KPI rows created: ${kpiRows.length}`);
  console.log(`  - Date range: ${since} to ${until}`);
}

main().catch((error) => {
  console.error('\n[shopify_backfill] ❌ Error:', error);
  process.exit(1);
});

