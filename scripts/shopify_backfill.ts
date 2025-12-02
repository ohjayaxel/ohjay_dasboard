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
import {
  calculateShopifyLikeSales,
  type ShopifyOrder as SalesShopifyOrder,
} from '@/lib/shopify/sales';

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
  refund_line_items?: Array<{
    line_item_id: number | string;
    quantity: number;
    subtotal?: string;
    line_item?: {
      price: string;
    };
  }>;
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
  total_tax?: string; // Tax amount - should be excluded from gross sales
  currency: string;
  customer?: { id: string };
  line_items: Array<{
    id: number | string;
    price: string; // Price per unit (before discount), as string
    quantity: number;
    total_discount: string; // Discount on this line item, as string
  }>;
  refunds?: Array<ShopifyRefund>;
  email?: string;
  financial_status?: string;
  fulfillment_status?: string;
  source_name?: string; // e.g., "web", "pos", "shopify_draft_order"
  cancelled_at?: string | null;
  tags?: string; // Comma-separated tags, may include "test"
  test?: boolean; // Indicates if this is a test order
  billing_address?: {
    country_code?: string;
    country?: string;
  };
  shipping_address?: {
    country_code?: string;
    country?: string;
  };
};

type ShopifyOrderRow = {
  tenant_id: string;
  order_id: string;
  processed_at: string | null;
  total_price: number | null;
  total_tax: number | null;
  discount_total: number | null;
  total_refunds: number | null;
  currency: string | null;
  customer_id: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  source_name: string | null;
  is_refund: boolean;
  gross_sales: number | null;
  net_sales: number | null;
  is_new_customer: boolean;
  country: string | null;
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

  const parseAmount = (value: string | number | null | undefined) => {
    if (value === null || value === undefined || value === '') return 0;
    const num = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(num) ? num : 0;
  };

  const totalPrice = parseAmount(order.total_price);
  const totalTax = parseAmount(order.total_tax);
  const totalDiscounts = parseAmount(order.total_discounts);
  const subtotalPrice = parseAmount(order.subtotal_price);
  
  // Calculate refunds using Shopify-like calculation
  // Convert our ShopifyOrder to SalesShopifyOrder format for refund calculation
  const salesOrder: SalesShopifyOrder = {
    id: order.id,
    created_at: order.created_at,
    currency: order.currency,
    financial_status: order.financial_status || 'unknown',
    cancelled_at: order.cancelled_at || null,
    line_items: order.line_items || [],
    total_discounts: order.total_discounts,
    total_tax: order.total_tax,
    refunds: order.refunds?.map((refund) => ({
      id: refund.id,
      created_at: refund.created_at,
      refund_line_items: refund.refund_line_items || [],
    })) || [],
  };

  // Calculate refunds using Shopify-like calculation
  const salesResult = calculateShopifyLikeSales([salesOrder]);
  const orderSales = salesResult.perOrder[0];
  const totalRefunds = orderSales ? orderSales.returns : 0;

  // Shopify Gross Sales filtering logic:
  // Include order if:
  // - cancelled_at = null (not cancelled)
  // Exclude order if:
  // - order is cancelled (cancelled_at != null)
  // - order is a test order (test === true OR tags contains "test")
  // - order is a draft that is not "completed" (source_name === "shopify_draft_order" AND processed_at is null)
  // - order has 0 kr in order value (subtotal_price = 0)

  const isCancelled = order.cancelled_at !== null && order.cancelled_at !== '';
  const isTestOrder = order.test === true || (order.tags?.toLowerCase().includes('test') ?? false);
  const isDraftNotCompleted = order.source_name === 'shopify_draft_order' && processedAt === null;
  // Only exclude zero subtotal if there are no line_items
  // If there are line_items, even with discounts that make subtotal = 0, it should still count in Gross Sales
  const hasLineItems = order.line_items && order.line_items.length > 0;
  const hasZeroSubtotalNoItems = subtotalPrice === 0 && !hasLineItems;

  const shouldExclude = isCancelled || isTestOrder || isDraftNotCompleted || hasZeroSubtotalNoItems;

  // Calculate Gross Sales: SUM(line_item.price × line_item.quantity)
  // This is the product price × quantity, BEFORE discounts, tax, shipping
  let grossSales: number | null = null;
  let netSales: number | null = null;

  if (!shouldExclude) {
    const roundTo2Decimals = (num: number) => Math.round(num * 100) / 100;
    
    // Gross Sales = sum of (line_item.price × line_item.quantity)
    // Always calculate if there are line_items, even if the sum is 0
    // (discounts will be subtracted in Net Sales, not excluded from Gross Sales)
    let calculatedGrossSales = 0;
    const hasLineItems = order.line_items && order.line_items.length > 0;
    
    // Gross Sales should ALWAYS be set if order has total_price > 0
    // Don't require line_items - orders can have total_price without line_items being fetched
    // Gross Sales = total_price (Shopify's total_price, which is what should be used as gross_sales)
    // This matches what user expects: gross_sales should be the same as total_price
    if (totalPrice > 0) {
      grossSales = roundTo2Decimals(totalPrice);

      // Net Sales = Gross Sales - Discounts - Returns (to match file definition)
      // File: Nettoförsäljning = Bruttoförsäljning + Rabatter
      // Note: In file, Rabatter is NEGATIVE (-1584.32), so adding negative = subtracting
      // In our system, discount_total is POSITIVE (1980.51), so we subtract it
      // File does NOT subtract tax from net sales
      netSales = roundTo2Decimals(grossSales - totalDiscounts - totalRefunds);
    }
  }

  // Extract country from billing_address (preferred) or shipping_address
  // Shopify API can provide country_code (ISO 2-letter) or country (full name)
  // Prefer country_code if available, otherwise use country
  let country: string | null = null;
  if (order.billing_address?.country_code) {
    country = order.billing_address.country_code;
  } else if (order.billing_address?.country) {
    country = order.billing_address.country;
  } else if (order.shipping_address?.country_code) {
    country = order.shipping_address.country_code;
  } else if (order.shipping_address?.country) {
    country = order.shipping_address.country;
  }

  return {
    tenant_id: tenantId,
    order_id: order.id.toString(),
    processed_at: processedAt,
    total_price: totalPrice || null,
    total_tax: totalTax || null,
    discount_total: totalDiscounts || null,
    total_refunds: totalRefunds || null,
    currency: order.currency || null,
    customer_id: order.customer?.id?.toString() || null,
    financial_status: order.financial_status || null,
    fulfillment_status: order.fulfillment_status || null,
    source_name: order.source_name || null,
    is_refund: isRefund,
    gross_sales: grossSales,
    net_sales: netSales,
    is_new_customer: false, // Will be determined during batch processing
    country: country || null,
  };
}

function aggregateKpis(rows: ShopifyOrderRow[]) {
  const byDate = new Map<
    string,
    {
      revenue: number;
      total_sales: number; // Total Sales (SUM(line_item.price × quantity)) - stored in gross_sales column
      total_tax: number; // Total tax aggregated
      net_sales: number;
      conversions: number;
      new_customer_conversions: number;
      returning_customer_conversions: number;
      new_customer_net_sales: number;
      returning_customer_net_sales: number;
      currencies: Map<string, number>; // Track currency frequency
    }
  >();

  for (const row of rows) {
    if (!row.processed_at) continue;
    
    // Filter out orders with gross_sales = null or <= 0 (match Orders page logic)
    // Orders page filters: includedOrders = orders.filter((o) => parseFloat((o.gross_sales || 0).toString()) > 0)
    // Include all orders (both regular orders and refunds) with gross_sales > 0
    const grossSalesValue = row.gross_sales ?? 0;
    if (grossSalesValue <= 0) continue;
    
    const existing = byDate.get(row.processed_at) ?? {
      revenue: 0,
      total_sales: 0,
      total_tax: 0,
      net_sales: 0,
      conversions: 0,
      new_customer_conversions: 0,
      returning_customer_conversions: 0,
      new_customer_net_sales: 0,
      returning_customer_net_sales: 0,
      currencies: new Map<string, number>(),
    };

    // Add all orders (both regular orders and refunds) to totals
    existing.revenue += row.total_price ?? 0;
    // Total Sales = total_price + tax (the actual total sales including tax)
    const totalSales = (row.total_price ?? 0) + (row.total_tax ?? 0);
    existing.total_sales += totalSales;
    existing.total_tax += row.total_tax ?? 0;
    const netValue = row.net_sales ?? 0;
    existing.net_sales += netValue;
    
    // Only count conversions for non-refund orders
    if (!row.is_refund) {
      existing.conversions += 1;
      
      // Track currency frequency (use most common currency for the day)
      if (row.currency) {
        const count = existing.currencies.get(row.currency) ?? 0;
        existing.currencies.set(row.currency, count + 1);
      }
      
      if (row.is_new_customer) {
        existing.new_customer_conversions += 1;
        existing.new_customer_net_sales += netValue;
      } else {
        existing.returning_customer_conversions += 1;
        existing.returning_customer_net_sales += netValue;
      }
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
    
    // Gross Sales = sum of gross_sales from shopify_orders (which is now total_price)
    // This is the same as revenue, but kept separate for clarity
    const grossSales = values.revenue;
    
    return {
      date,
      spend: 0,
      clicks: null,
      conversions: values.conversions || null,
      revenue: values.revenue || null,
      gross_sales: grossSales || null,
      net_sales: values.net_sales || null,
      new_customer_conversions: values.new_customer_conversions || null,
      returning_customer_conversions: values.returning_customer_conversions || null,
      new_customer_net_sales: values.new_customer_net_sales || null,
      returning_customer_net_sales: values.returning_customer_net_sales || null,
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
  sinceId?: number; // For continuing after API limit
  skipLocalFilter?: boolean; // Skip local date filtering (for wider fetches)
}): Promise<ShopifyOrder[]> {
  const normalizedShop = normalizeShopDomain(params.shopDomain);
  const allOrders: ShopifyOrder[] = [];
  let pageInfo: string | null = null;
  let page = 1;
  let currentSinceId: number | undefined = params.sinceId;

  console.log(`\n[shopify_backfill] Fetching orders from ${params.since || 'all time'} to ${params.until || 'now'}...`);
  
  // Store date objects for local filtering if needed (only if not skipping filter)
  const sinceDateObj = params.skipLocalFilter ? null : (params.since ? new Date(`${params.since}T00:00:00`) : null);
  const untilDateObj = params.skipLocalFilter ? null : (params.until ? new Date(`${params.until}T23:59:59`) : null);

  while (true) {
    const url = new URL(`https://${normalizedShop}/admin/api/2023-10/orders.json`);
    url.searchParams.set('limit', '250'); // Max limit per page
    // Ensure we fetch total_tax and billing/shipping addresses for country
    url.searchParams.set('fields', 'id,order_number,processed_at,created_at,updated_at,total_price,subtotal_price,total_discounts,total_tax,currency,customer,line_items,refunds,email,financial_status,fulfillment_status,source_name,cancelled_at,tags,test,billing_address,shipping_address');

    if (pageInfo) {
      // When using page_info, we can only set page_info and limit
      // Date filters from first request are preserved by Shopify API
      url.searchParams.set('page_info', pageInfo);
    } else if (currentSinceId) {
      // Use since_id to continue after hitting API limit
      url.searchParams.set('status', 'any');
      url.searchParams.set('since_id', currentSinceId.toString());
      if (params.since) {
        url.searchParams.set('created_at_min', params.since);
      }
      if (params.until) {
        url.searchParams.set('created_at_max', params.until);
      }
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

    console.log(`[shopify_backfill] Fetching page ${page}${pageInfo ? ' (pagination)' : currentSinceId ? ` (since_id: ${currentSinceId})` : ''}...`);

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

    if (orders.length === 0) {
      break;
    }

    // Filter orders by date locally to ensure we get all orders in the range
    // This is important because Shopify API pagination may not respect date filters fully
    let filteredOrders = orders;
    if (sinceDateObj || untilDateObj) {
      filteredOrders = orders.filter((order) => {
        // Check both created_at and processed_at
        const created = order.created_at ? new Date(order.created_at) : null;
        const processed = order.processed_at ? new Date(order.processed_at) : null;
        
        // Order matches if either created_at or processed_at is in range
        const matchesSince = !sinceDateObj || 
          (created && created >= sinceDateObj) || 
          (processed && processed >= sinceDateObj);
        const matchesUntil = !untilDateObj || 
          (created && created <= untilDateObj) || 
          (processed && processed <= untilDateObj);
        
        return matchesSince && matchesUntil;
      });
    }

    allOrders.push(...filteredOrders);
    console.log(`[shopify_backfill] Fetched ${orders.length} orders (${filteredOrders.length} in date range, total: ${allOrders.length})`);

    // Check for next page via Link header
    const linkHeader = res.headers.get('link');
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const nextMatch = linkHeader.match(/<([^>]+)>; rel="next"/);
      if (nextMatch) {
        const nextUrl = new URL(nextMatch[1]);
        pageInfo = nextUrl.searchParams.get('page_info');
        if (!pageInfo) {
          // If no page_info but we got orders, try using since_id with last order ID
          const lastOrderId = parseInt(orders[orders.length - 1].id.toString());
          if (!Number.isNaN(lastOrderId) && lastOrderId > (currentSinceId || 0)) {
            currentSinceId = lastOrderId;
            pageInfo = null; // Reset to use since_id
            page++;
            continue;
          }
          break;
        }
        page++;
      } else {
        break;
      }
    } else {
      // No next page link, but check if we might have hit API limit
      // Shopify API limit is ~50 pages (12,500 orders)
      if (page >= 49 && orders.length === 250) {
        // Likely hit API limit, try using since_id
        const lastOrderId = parseInt(orders[orders.length - 1].id.toString());
        if (!Number.isNaN(lastOrderId) && lastOrderId > (currentSinceId || 0)) {
          console.log(`[shopify_backfill] Possible API limit reached, switching to since_id pagination...`);
          currentSinceId = lastOrderId;
          pageInfo = null; // Reset to use since_id
          page++;
          continue;
        }
      }
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

  const startDate = new Date(since);
  const endDate = new Date(until);
  
  // Calculate number of days in range
  const daysDiff = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  
  // For small date ranges (< 7 days), we need to fetch a wider range because Shopify API
  // filters on created_at, but we need orders with processed_at in the target range.
  // Orders can be created earlier but processed later, so we fetch from 30 days before
  // to ensure we get all orders that might have processed_at in our target range.
  const fetchDaysBefore = daysDiff <= 7 ? 30 : 0;
  const fetchStartDate = new Date(startDate);
  fetchStartDate.setDate(fetchStartDate.getDate() - fetchDaysBefore);
  
  if (fetchDaysBefore > 0) {
    console.log(`[shopify_backfill] Small date range detected (${daysDiff} days).`);
    console.log(`[shopify_backfill] Fetching from ${fetchStartDate.toISOString().slice(0, 10)} to ${until} to capture orders created earlier but processed in target range.\n`);
  } else {
    console.log(`[shopify_backfill] Using monthly date chunks to fetch orders...\n`);
  }
  
  // Create monthly chunks for the fetch range (may be wider than target range)
  const dateChunks: Array<{ since: string; until: string; targetSince: string; targetUntil: string }> = [];
  let currentStart = new Date(fetchStartDate);
  const actualEndDate = new Date(endDate);
  
  while (currentStart <= actualEndDate) {
    const currentEnd = new Date(currentStart);
    currentEnd.setMonth(currentEnd.getMonth() + 1);
    currentEnd.setDate(0); // Last day of currentStart month
    
    if (currentEnd > actualEndDate) {
      currentEnd.setTime(actualEndDate.getTime());
    }
    
    const sinceStr = currentStart.toISOString().slice(0, 10);
    const untilStr = currentEnd.toISOString().slice(0, 10);
    
    dateChunks.push({
      since: sinceStr, // Fetch range (may be wider)
      until: untilStr,
      targetSince: since, // Target range (what we actually want)
      targetUntil: until,
    });
    
    currentStart = new Date(currentEnd);
    currentStart.setDate(currentStart.getDate() + 1); // Start of next month
  }

  console.log(`[shopify_backfill] Processing ${dateChunks.length} monthly chunks...\n`);

  // Fetch orders in chunks
  const allOrdersFetched: ShopifyOrder[] = [];
  for (let i = 0; i < dateChunks.length; i++) {
    const chunk = dateChunks[i];
    console.log(`[shopify_backfill] Processing chunk ${i + 1}/${dateChunks.length}: ${chunk.since} to ${chunk.until}`);
    
    // For small ranges, skip local filtering in fetch function since we'll filter after
    const skipLocalFilter = fetchDaysBefore > 0;
    const chunkOrders = await fetchShopifyOrdersWithPagination({
      shopDomain,
      accessToken,
      since: chunk.since,
      until: chunk.until,
      skipLocalFilter,
    });
    
    console.log(`[shopify_backfill] Chunk ${i + 1} completed: ${chunkOrders.length} orders`);
    allOrdersFetched.push(...chunkOrders);
    
    // Add small delay to avoid rate limiting
    if (i < dateChunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  
  console.log(`[shopify_backfill] Fetched ${allOrdersFetched.length} total orders from API\n`);
  
  // Filter orders to target date range based on processed_at (not created_at)
  // This is important because orders can be created earlier but processed later
  // ALSO: Include orders with refunds created on target date, even if processed_at is different
  // (This matches how files group orders by refund date)
  const targetSinceDate = new Date(`${since}T00:00:00`);
  const targetUntilDate = new Date(`${until}T23:59:59`);
  
  const allOrdersWithDateFilter = allOrdersFetched.filter((order) => {
    // Match file behavior: Include orders based on created_at OR processed_at OR refund.created_at
    // Parse dates in local timezone (Stockholm/EU) to match Shopify's date display
    const processedDateStr = order.processed_at 
      ? new Date(order.processed_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' })
      : null;
    const createdDateStr = order.created_at
      ? new Date(order.created_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' })
      : null;
    
    const processed = processedDateStr ? new Date(processedDateStr + 'T00:00:00') : null;
    const created = createdDateStr ? new Date(createdDateStr + 'T00:00:00') : null;
    
    // Order matches if created_at OR processed_at is in target range
    const matchesCreatedDate = created ? created >= targetSinceDate && created <= targetUntilDate : false;
    const matchesProcessedDate = processed ? processed >= targetSinceDate && processed <= targetUntilDate : false;
    
    // ALSO: Include if order has refunds created on target date
    // This matches file behavior where refunds are grouped by refund creation date
    let hasRefundOnTargetDate = false;
    if (order.refunds && Array.isArray(order.refunds) && order.refunds.length > 0) {
      for (const refund of order.refunds) {
        if (refund.created_at) {
          const refundDateStr = new Date(refund.created_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' });
          const refundDate = new Date(refundDateStr + 'T00:00:00');
          if (refundDate >= targetSinceDate && refundDate <= targetUntilDate) {
            hasRefundOnTargetDate = true;
            break;
          }
        }
      }
    }
    
    return matchesCreatedDate || matchesProcessedDate || hasRefundOnTargetDate;
  });
  
  console.log(`[shopify_backfill] Filtered to ${allOrdersWithDateFilter.length} orders with processed_at in range ${since} to ${until}\n`);
  
  // Deduplicate orders by order_id (in case chunks overlap)
  const uniqueOrdersMap = new Map<string, ShopifyOrder>();
  for (const order of allOrdersWithDateFilter) {
    const orderId = order.id.toString();
    if (!uniqueOrdersMap.has(orderId)) {
      uniqueOrdersMap.set(orderId, order);
    }
  }
  const shopifyOrders = Array.from(uniqueOrdersMap.values());
  
  if (shopifyOrders.length < allOrdersWithDateFilter.length) {
    console.log(`[shopify_backfill] Removed ${allOrdersWithDateFilter.length - shopifyOrders.length} duplicate orders from chunk overlap`);
  }
  
  console.log(`[shopify_backfill] Using ${shopifyOrders.length} unique orders after deduplication\n`);


  // Map to database rows
  // For orders with refunds created on target date but processed_at on different date,
  // update processed_at to refund.created_at to match file behavior
  // (File groups refunds by refund creation date, not original order processed_at)
  let orderRows: ShopifyOrderRow[] = [];
  
  for (const order of shopifyOrders) {
    let row = mapShopifyOrderToRow(tenant.id, order);
    const originalProcessedAt = row.processed_at;
    
    // Match file behavior for date assignment:
    // 1. If order has refunds created on target date, use refund.created_at as processed_at
    // 2. If order was created on target date (but processed_at is different), use created_at as processed_at
    // 3. Otherwise, use processed_at as-is
    
    // Parse dates in local timezone (not UTC) to match Shopify's date display
    // Shopify dates like "2025-11-28T00:55:21+01:00" should be treated as 2025-11-28, not 2025-11-27 (UTC)
    const orderCreatedAt = order.created_at 
      ? new Date(order.created_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' })
      : null;
    const orderProcessedAt = originalProcessedAt;
    
    let targetDate: string | null = null;
    
    // Priority 1: Check for refunds created on target date
    if (order.refunds && Array.isArray(order.refunds) && order.refunds.length > 0) {
      for (const refund of order.refunds) {
        if (refund.created_at) {
          const refundDate = new Date(refund.created_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' });
          if (refundDate >= since && refundDate <= until) {
            targetDate = refundDate;
            console.log(`[shopify_backfill] Order ${order.id}: Using refund.created_at=${refundDate} (was processed_at=${orderProcessedAt})`);
            break; // Use first refund on target date
          }
        }
      }
    }
    
    // Priority 2: If created_at is on target date, use created_at (file behavior)
    // File groups orders by created_at when it differs from processed_at
    if (!targetDate && orderCreatedAt && orderCreatedAt >= since && orderCreatedAt <= until) {
      targetDate = orderCreatedAt;
      if (orderProcessedAt !== orderCreatedAt) {
        console.log(`[shopify_backfill] Order ${order.id}: Using created_at=${orderCreatedAt} (was processed_at=${orderProcessedAt})`);
      }
    }
    
    // Priority 3: Use processed_at if it's on target date AND created_at is NOT on target date
    // (If created_at is on target date, we already used it above)
    if (!targetDate && orderProcessedAt && orderProcessedAt >= since && orderProcessedAt <= until) {
      // Only use processed_at if created_at is not on target date
      if (!orderCreatedAt || (orderCreatedAt < since || orderCreatedAt > until)) {
        targetDate = orderProcessedAt;
      }
    }
    
    // Only include orders that matched target date (via refund, created_at, or processed_at)
    if (targetDate) {
      // Update processed_at if we found a different date
      if (targetDate !== originalProcessedAt) {
        row = {
          ...row,
          processed_at: targetDate,
        };
      }
      orderRows.push(row);
    }
  }

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
    new_customer_net_sales: row.new_customer_net_sales,
    returning_customer_net_sales: row.returning_customer_net_sales,
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

