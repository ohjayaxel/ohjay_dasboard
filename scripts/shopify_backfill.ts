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
import { readFileSync } from 'fs';

// Load environment variables from .env.local or env file
function loadEnvFile() {
  // Try multiple possible locations (Next.js standard + custom)
  const possibleEnvFiles = [
    process.env.ENV_FILE,
    '.env.local',
    '.env.production.local',
    '.env.development.local',
    '.env',
    'env/local.prod.sh',
    '../env/local.prod.sh',
    '../../env/local.prod.sh',
  ].filter(Boolean) as string[];

  for (const envFile of possibleEnvFiles) {
    try {
      const content = readFileSync(envFile, 'utf-8');
      const envVars: Record<string, string> = {};
      content.split('\n').forEach((line) => {
        // Support both export KEY=value and KEY=value formats
        const exportMatch = line.match(/^export\s+(\w+)=(.+)$/);
        const directMatch = line.match(/^(\w+)=(.+)$/);
        const match = exportMatch || directMatch;
        if (match && !line.trim().startsWith('#')) {
          const [, key, value] = match;
          envVars[key] = value.replace(/^["']|["']$/g, '').trim();
        }
      });
      Object.assign(process.env, envVars);
      console.log(`[shopify_backfill] Loaded environment variables from ${envFile}`);
      return;
    } catch (error) {
      // Continue to next file
    }
  }
  
  // If no file found, check if env vars are already set
  if (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL) {
    console.log(`[shopify_backfill] Using existing environment variables`);
    return;
  }
  
  console.warn(`[shopify_backfill] Warning: Could not load env file. Make sure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.`);
}

loadEnvFile();

import { createClient } from '@supabase/supabase-js';
import { decryptSecret } from '@/lib/integrations/crypto';
import { getShopifyConnection, getShopifyAccessToken } from '@/lib/integrations/shopify';
import { resolveTenantId } from '@/lib/tenants/resolve-tenant';
import {
  calculateShopifyLikeSales,
  type ShopifyOrder as SalesShopifyOrder,
  calculateDailySales,
  type SalesMode,
  type OrderCustomerClassification,
} from '@/lib/shopify/sales';
import { fetchShopifyOrdersGraphQL, type GraphQLOrder } from '@/lib/integrations/shopify-graphql';
import { mapOrderToTransactions, type SalesTransaction } from '@/lib/shopify/transaction-mapper';
import { convertGraphQLOrderToShopifyOrder } from '@/lib/shopify/order-converter';

// Create Supabase client (same pattern as other scripts)
// Check if env vars are already set (from shell or other source)
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('\n❌ Error: Missing environment variables');
  console.error('   NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL');
  console.error('   SUPABASE_SERVICE_ROLE_KEY');
  console.error('\n💡 Tip: Export them in your shell or create .env.local file\n');
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

console.log(`[shopify_backfill] Using Supabase URL: ${supabaseUrl.substring(0, 20)}...`);

const supabaseClient = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  db: {
    schema: 'public',
  },
});

type ShopifyRefund = {
  id: number;
  created_at: string;
  total_refunded?: string;
  adjustments?: Array<{
    reason?: string | null;
    amount?: string | null;
    tax_amount?: string | null;
  }>;
  refund_line_items?: Array<{
    line_item_id: number | string;
    quantity: number;
    subtotal?: string;
    line_item?: {
      price: string;
    };
  }>;
  transactions?: Array<{
    id: string;
    kind: string;
    status: string;
    processed_at?: string | null;
    amount?: string;
    currency?: string;
  }>;
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
    tax?: string; // Total tax for this line item (across quantity)
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
  created_at: string | null;
  created_at_ts: string | null; // Full timestamp (ISO string) for deterministic classification
  total_sales: number | null; // Gross Sales + Tax (produkter före rabatter, inklusive skatt)
  tax: number | null; // Skatt på Gross Sales
  total_tax: number | null; // Total tax från Shopify API (tax på subtotal_price, dvs efter rabatter)
  revenue: number | null; // Omsättning: net_sales + tax + shipping_amount
  discount: number | null;
  refunds: number | null;
  currency: string | null;
  customer_id: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  source_name: string | null;
  is_refund: boolean;
  gross_sales: number | null; // Produkter före rabatter, exklusive skatt
  net_sales: number | null; // Net Sales exklusive skatt
  is_new_customer: boolean; // Deprecated - kept for backward compatibility
  country: string | null;
  shipping_amount: number | null;
  shipping_tax: number | null;
  duties_amount: number | null;
  additional_fees_amount: number | null;
  is_test: boolean;
  // New customer classification fields
  is_first_order_for_customer: boolean;
  customer_type_shopify_mode: 'FIRST_TIME' | 'RETURNING' | 'GUEST' | 'UNKNOWN' | null;
    // DEPRECATED: customer_type_financial_mode - kept for backward compatibility but not used
    customer_type_financial_mode?: 'NEW' | 'RETURNING' | 'GUEST' | 'UNKNOWN' | null;
};

type CustomerOrderInfo = {
  order_id: string;
  created_at: string;
  net_sales: number;
  is_cancelled: boolean;
  is_full_refunded: boolean;
  financial_status: string | null;
};

type CustomerHistory = {
  first_order_id_all_time: string;
  first_revenue_order_id: string | null; // First order with NetSales > 0 and not cancelled/full-refunded
  all_orders: CustomerOrderInfo[];
  is_first_order_for_customer: boolean;
  customer_type_shopify_mode: 'FIRST_TIME' | 'RETURNING' | 'GUEST' | 'UNKNOWN' | null;
    // DEPRECATED: customer_type_financial_mode - kept for backward compatibility but not used
    customer_type_financial_mode?: 'NEW' | 'RETURNING' | 'GUEST' | 'UNKNOWN' | null;
};

type CustomerOrderInfo = {
  order_id: string;
  created_at: string;
  net_sales: number;
  is_cancelled: boolean;
  is_full_refunded: boolean;
};

type CustomerHistory = {
  first_order_id_all_time: string;
  first_revenue_order_id: string | null; // First order with NetSales > 0 and not cancelled/full-refunded
  all_orders: CustomerOrderInfo[];
};

function normalizeShopDomain(domain: string): string {
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

/**
 * Infer financial_status from GraphQL order transactions
 * Same logic as lib/shopify/order-converter.ts and Edge Function
 * This is critical - financial_status is required for calculateShopifyLikeSales to include orders
 * 
 * IMPORTANT: If order has no transactions but has line items and is not cancelled,
 * we default to 'paid' (most common case) to avoid filtering out valid orders.
 * This matches Shopify's behavior where orders in Analytics typically have financial_status='paid'
 * even if transactions are not available in GraphQL.
 */
function inferFinancialStatusFromTransactions(gqlOrder: GraphQLOrder): string {
  if (gqlOrder.cancelledAt) {
    return 'voided';
  }
  
  const transactions = gqlOrder.transactions || [];
  if (transactions.length === 0) {
    // No transactions available - default to 'paid' if order has line items
    // This ensures orders are included in calculations (matches Shopify Analytics behavior)
    // Only use 'pending' if we're certain it's not paid (e.g., draft orders have no line items)
    const hasLineItems = gqlOrder.lineItems?.edges?.length > 0;
    return hasLineItems ? 'paid' : 'pending';
  }
  
  const successfulSales = transactions.filter(
    (txn) => (txn.kind === 'SALE' || txn.kind === 'CAPTURE') && txn.status === 'SUCCESS'
  );
  const refunds = transactions.filter(
    (txn) => txn.kind === 'REFUND' && txn.status === 'SUCCESS'
  );
  
  if (refunds.length > 0 && successfulSales.length > 0) {
    return 'partially_refunded';
  } else if (successfulSales.length > 0) {
    return 'paid';
  } else {
    // No successful sales transactions - but if we have line items, assume 'paid'
    // (transactions might be missing from GraphQL but order is actually paid)
    const hasLineItems = gqlOrder.lineItems?.edges?.length > 0;
    return hasLineItems ? 'paid' : 'pending';
  }
}

function mapShopifyOrderToRow(tenantId: string, order: ShopifyOrder): ShopifyOrderRow {
  // IMPORTANT: Store dates in shop timezone (Europe/Stockholm) to match Shopify UI + Analytics "Dag".
  // Using UTC (toISOString) causes off-by-one day issues around midnight.
  const processedAt = order.processed_at
    ? new Date(order.processed_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' })
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
  
  // Calculate sales using Shopify-like calculation (NEW METHOD)
  // Convert our ShopifyOrder to SalesShopifyOrder format
  // This includes subtotal_price for the new calculation method
  // IMPORTANT: financial_status is required for calculateShopifyLikeSales to include the order
  // If missing, default to 'paid' (most common case) to avoid filtering out valid orders
  const salesOrder: SalesShopifyOrder = {
    id: order.id,
    created_at: order.created_at,
    currency: order.currency,
    financial_status: order.financial_status || 'paid', // Default to 'paid' if missing
    cancelled_at: order.cancelled_at || null,
    subtotal_price: order.subtotal_price, // NEW: Required for correct Net Sales calculation
    total_tax: order.total_tax, // NEW: Required for correct Net Sales calculation
    line_items: order.line_items || [],
    total_discounts: order.total_discounts,
    refunds: order.refunds?.map((refund) => ({
      id: refund.id,
      created_at: refund.created_at,
      total_refunded: refund.total_refunded,
      adjustments: refund.adjustments,
      refund_line_items: refund.refund_line_items || [],
      transactions: refund.transactions,
    })) || [],
  };
  
  // Add test flag if present
  if ('test' in order) {
    (salesOrder as any).test = order.test;
  }

  // Calculate sales using Shopify-like calculation
  // This now correctly converts Gross Sales and Discounts from INCL tax to EXCL tax
  const salesResult = calculateShopifyLikeSales([salesOrder]);
  const orderSales = salesResult.perOrder[0];
  const totalRefunds = orderSales ? orderSales.returns : 0;
  
  // Use discounts from orderSales (already converted to EXCL tax)
  const discountsExclTax = orderSales ? orderSales.discounts : 0;
  
  // Debug: Log if orderSales is missing
  if (!orderSales) {
    console.warn(`[shopify_backfill] WARNING: No orderSales for order ${order.id}`);
    console.warn(`  - salesResult.perOrder length: ${salesResult.perOrder?.length || 0}`);
    console.warn(`  - salesResult.errors:`, salesResult.errors);
    console.warn(`  - salesOrder.line_items length: ${salesOrder.line_items?.length || 0}`);
    console.warn(`  - salesOrder.id: ${salesOrder.id}`);
  }

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

  // Calculate Gross Sales: SUM(line_item.price × quantity) EXCL tax
  // Definition: Ungefärliga försäljningsintäkter, innan rabatter och returer räknas in över tid, exklusive skatt
  // Use the calculated values from calculateShopifyLikeSales (which uses SUM(line_item.price × quantity))
  let grossSales: number | null = null;
  let netSales: number | null = null;
  let tax: number | null = null;
  let totalSales: number | null = null;
  let revenue: number | null = null;

  if (!shouldExclude && totalPrice > 0) {
    const roundTo2Decimals = (num: number) => Math.round(num * 100) / 100;
    
    // Use grossSales and netSales from calculateShopifyLikeSales (correct calculation)
    grossSales = orderSales ? roundTo2Decimals(orderSales.grossSales) : null;
    netSales = orderSales ? roundTo2Decimals(orderSales.netSales) : null;
    
    // Tax = skatt på Gross Sales
    // Use total_tax directly (this is the tax on subtotal after discounts)
    // This is the correct tax value from Shopify API
    // We should NOT recalculate tax from gross_sales as that would be incorrect
    tax = totalTax > 0 ? roundTo2Decimals(totalTax) : null;
    
    // Total Sales = Gross Sales + Tax
    // Definition: Exakt som Gross Sales men inkluderar skatt
    totalSales = grossSales && tax !== null 
      ? roundTo2Decimals(grossSales + tax)
      : null;
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

  const createdAt = order.created_at
    ? new Date(order.created_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' })
    : null;
  
  const createdAtTimestamp = order.created_at
    ? new Date(order.created_at).toISOString()
    : null;

  // Extract shipping amount (will be null if not available in GraphQL order)
  // This should be populated from GraphQL order.totalShippingPriceSet if available
  const shippingAmount: number | null = null; // TODO: Extract from GraphQL order if available
  
  // Revenue (Omsättning) = net_sales + tax + shipping_amount
  if (netSales !== null && tax !== null) {
    const roundTo2Decimals = (num: number) => Math.round(num * 100) / 100;
    revenue = roundTo2Decimals(netSales + tax + (shippingAmount || 0));
  }

  return {
    tenant_id: tenantId,
    order_id: order.id.toString(),
    processed_at: processedAt,
    created_at: createdAt,
    created_at_ts: createdAtTimestamp,
    revenue: revenue,
    total_sales: totalSales,
    gross_sales: grossSales,
    net_sales: netSales,
    discount: discountsExclTax || null, // Use discounts EXCL tax from calculateShopifyLikeSales
    refunds: totalRefunds || null,
    tax: tax,
    shipping_amount: shippingAmount,
    currency: order.currency || null,
    total_tax: totalTax || null,
    customer_id: order.customer?.id?.toString() || null,
    financial_status: order.financial_status || null,
    fulfillment_status: order.fulfillment_status || null,
    source_name: order.source_name || null,
    is_refund: isRefund,
    is_new_customer: false, // Deprecated - kept for backward compatibility
    country: country || null,
    shipping_tax: null,
    duties_amount: null,
    additional_fees_amount: null,
    is_test: isTestOrder,
    // New fields - will be set later during customer history calculation
    is_first_order_for_customer: false,
    customer_type_shopify_mode: null,
    customer_type_financial_mode: null,
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

  // Get tenant ID from slug (direct lookup for scripts, not using React cache)
  console.log(`[shopify_backfill] Looking up tenant: ${args.tenant}...`);
  let tenantId: string;
  let tenantName: string;
  
  const { data: tenantData, error: tenantError } = await supabase
    .from('tenants')
    .select('id, slug, name')
    .eq('slug', args.tenant)
    .maybeSingle();

  if (tenantError) {
    console.error(`[shopify_backfill] Tenant lookup error:`, tenantError);
    // This might be a schema cache issue - Supabase sometimes needs a moment
    // Try with a simple query first to warm up the cache
    await supabase.from('tenants').select('id').limit(1);
    
    // Retry
    const { data: tenantDataRetry, error: tenantErrorRetry } = await supabase
      .from('tenants')
      .select('id, slug, name')
      .eq('slug', args.tenant)
      .maybeSingle();
    
    if (tenantErrorRetry || !tenantDataRetry) {
      throw new Error(`Failed to fetch tenant: ${tenantError.message}`);
    }
    
    tenantId = tenantDataRetry.id;
    tenantName = tenantDataRetry.name;
  } else if (!tenantData) {
    throw new Error(`Tenant not found: ${args.tenant}`);
  } else {
    tenantId = tenantData.id;
    tenantName = tenantData.name;
  }

  console.log(`[shopify_backfill] Found tenant: ${tenantName} (${tenantId})`);
  
  // Get Shopify connection - use direct lookup to avoid NEXT_PUBLIC_SUPABASE_URL requirement
  let shopDomain: string;
  let accessToken: string;
  
  try {
    // Try direct lookup first (works better for scripts)
    const { data: connectionData, error: connectionError } = await supabase
      .from('connections')
      .select('id, status, access_token_enc, meta')
      .eq('tenant_id', tenantId)
      .eq('source', 'shopify')
      .maybeSingle();

    if (connectionError) {
      throw new Error(`Failed to fetch Shopify connection: ${connectionError.message}`);
    }

    if (!connectionData) {
      throw new Error(`No Shopify connection found for tenant ${args.tenant}`);
    }

    shopDomain = connectionData.meta?.store_domain || connectionData.meta?.shop;
    if (!shopDomain || typeof shopDomain !== 'string') {
      throw new Error('No shop domain found in connection metadata');
    }

    accessToken = decryptSecret(connectionData.access_token_enc as any) || '';
    if (!accessToken) {
      throw new Error('Failed to decrypt access token');
    }
  } catch (error) {
    // Fallback: Direct lookup
    const { data: connectionData, error: connectionError } = await supabase
      .from('connections')
      .select('id, status, access_token_enc, meta')
      .eq('tenant_id', tenantId)
      .eq('source', 'shopify')
      .maybeSingle();

    if (connectionError) {
      throw new Error(`Failed to fetch Shopify connection: ${connectionError.message}`);
    }

    if (!connectionData) {
      throw new Error(`No Shopify connection found for tenant ${args.tenant}`);
    }

    shopDomain = connectionData.meta?.store_domain || connectionData.meta?.shop;
    if (!shopDomain || typeof shopDomain !== 'string') {
      throw new Error('No shop domain found in connection metadata');
    }

    accessToken = decryptSecret(connectionData.access_token_enc) || '';
    if (!accessToken) {
      throw new Error('Failed to decrypt access token');
    }
  }

  console.log(`[shopify_backfill] Shop domain: ${shopDomain}`);

  console.log(`[shopify_backfill] Access token retrieved successfully\n`);

  const startDate = new Date(since);
  const endDate = new Date(until);
  
  // Calculate number of days in range
  const daysDiff = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  
  console.log(`[shopify_backfill] Using GraphQL API with processed_at filter`);
  console.log(`[shopify_backfill] Target date range: ${since} to ${until} (${daysDiff} days)`);
  console.log(`[shopify_backfill] Filter: processed_at in [${since}, ${until}) (half-open interval)\n`);
  
  // Use GraphQL API with processed_at filter directly (no lookback needed)
  // This matches Shopify Analytics "Day" view which uses processed_at
  console.log(`[shopify_backfill] Fetching orders via GraphQL...`);
  
  // IMPORTANT:
  // Shopify Analytics "Dag" exports allocate:
  // - orders by order processed/created day
  // - refunds by refund created/processed day
  // To correctly capture refunds that occur in the period for orders processed earlier,
  // we need to include orders UPDATED in the period (refunds update the order).
  const [processedOrders, updatedOrders] = await Promise.all([
    fetchShopifyOrdersGraphQL({
      shopDomain,
      accessToken,
      since,
      until,
      filterBy: 'processed_at',
      excludeTest: false,
    }),
    fetchShopifyOrdersGraphQL({
      shopDomain,
      accessToken,
      since,
      until,
      filterBy: 'updated_at',
      excludeTest: false,
    }),
  ]);

  const graphQLOrdersRaw = [...processedOrders, ...updatedOrders];
  console.log(
    `[shopify_backfill] Fetched ${processedOrders.length} orders by processed_at and ${updatedOrders.length} by updated_at (raw total: ${graphQLOrdersRaw.length})\n`,
  );

  // Dedupe GraphQL orders (processed_at + updated_at fetch can overlap heavily)
  const uniqueGraphQLOrdersMap = new Map<string, GraphQLOrder>();
  for (const o of graphQLOrdersRaw) {
    const key = (o.legacyResourceId || o.id).toString();
    if (!uniqueGraphQLOrdersMap.has(key)) {
      uniqueGraphQLOrdersMap.set(key, o);
    }
  }
  const graphQLOrders = Array.from(uniqueGraphQLOrdersMap.values());
  console.log(`[shopify_backfill] Unique GraphQL orders after deduplication: ${graphQLOrders.length}\n`);
  
  // Store unique GraphQL orders for later use in customer classification
  const graphqlOrdersForClassification = graphQLOrders;
  
  // Convert GraphQL orders to REST format for compatibility with existing mapping logic
  // GraphQL format has slightly different structure, so we need to convert
  const allOrdersFetched: ShopifyOrder[] = graphQLOrders.map((gqlOrder) => {
    // Extract customer ID from Shopify GID format: "gid://shopify/Customer/8830907711831"
    let customerId: number | null = null;
    if (gqlOrder.customer?.id) {
      const gidMatch = gqlOrder.customer.id.match(/\/(\d+)$/);
      if (gidMatch) {
        customerId = parseInt(gidMatch[1]);
      }
    }
    
    // Convert GraphQL order to REST API format
    const restOrder: ShopifyOrder = {
      id: parseInt(gqlOrder.legacyResourceId || gqlOrder.id),
      order_number: parseInt(gqlOrder.name.replace('#', '')),
      processed_at: gqlOrder.processedAt || null,
      created_at: gqlOrder.createdAt,
      updated_at: gqlOrder.updatedAt || null,
      cancelled_at: gqlOrder.cancelledAt || null,
      total_price: gqlOrder.totalPriceSet?.shopMoney?.amount || '0',
      subtotal_price: gqlOrder.subtotalPriceSet?.shopMoney?.amount || '0',
      total_discounts: gqlOrder.totalDiscountsSet?.shopMoney?.amount || '0',
      total_tax: gqlOrder.totalTaxSet?.shopMoney?.amount || '0',
      currency: gqlOrder.currencyCode,
      test: gqlOrder.test,
      customer: gqlOrder.customer && customerId ? {
        id: customerId,
        email: gqlOrder.customer.email || null,
        first_name: null,
        last_name: null,
      } : null,
      line_items: gqlOrder.lineItems.edges.map((edge) => {
        const item = edge.node;
        // Extract line item ID from GID format: "gid://shopify/LineItem/123456"
        let lineItemId: number | null = null;
        const gidMatch = item.id.match(/\/(\d+)$/);
        if (gidMatch) {
          lineItemId = parseInt(gidMatch[1]);
        }

        // Sum discount allocations for this line item
        let totalDiscount = 0;
        for (const allocation of item.discountAllocations || []) {
          totalDiscount += parseFloat(allocation.allocatedAmountSet.shopMoney.amount || '0');
        }

        // Sum tax lines for this line item (needed for mixed VAT and refund tax estimation)
        let totalTax = 0;
        for (const taxLine of item.taxLines || []) {
          totalTax += parseFloat(taxLine.priceSet.shopMoney.amount || '0');
        }

        return {
          id: lineItemId || 0,
          sku: item.sku || null,
          name: item.name,
          quantity: item.quantity,
          price: item.originalUnitPriceSet.shopMoney.amount,
          total_discount: totalDiscount.toFixed(2),
          tax: totalTax.toFixed(2),
        };
      }),
      refunds: gqlOrder.refunds.map((refund) => ({
        id: parseInt(refund.id.match(/\/(\d+)$/)?.[1] || '0'),
        created_at: refund.createdAt,
        total_refunded: refund.totalRefundedSet?.shopMoney?.amount,
        adjustments: (refund.orderAdjustments?.edges || []).map((e) => ({
          reason: e.node.reason ?? null,
          amount: e.node.amountSet?.shopMoney?.amount ?? null,
          tax_amount: e.node.taxAmountSet?.shopMoney?.amount ?? null,
        })),
        refund_line_items: refund.refundLineItems.edges.map((edge) => ({
          quantity: edge.node.quantity,
          // Keep line_item_id aligned with our numeric line_items[].id (used by refunded-tax estimation)
          line_item_id: parseInt(edge.node.lineItem.id.match(/\/(\d+)$/)?.[1] || '0'),
          subtotal: edge.node.subtotalSet?.shopMoney?.amount || '0',
          line_item: {
            id: parseInt(edge.node.lineItem.id.match(/\/(\d+)$/)?.[1] || '0'),
            sku: edge.node.lineItem.sku || null,
            name: edge.node.lineItem.name,
            price: edge.node.lineItem.originalUnitPriceSet.shopMoney.amount,
          },
        })),
        transactions: (refund.transactions?.edges || []).map((te) => ({
          id: te.node.id,
          kind: te.node.kind,
          status: te.node.status,
          processed_at: te.node.processedAt || null,
          amount: te.node.amountSet?.shopMoney?.amount,
          currency: te.node.amountSet?.shopMoney?.currencyCode,
        })),
      })),
      email: gqlOrder.customer?.email || null,
      // Infer financial_status from transactions (same logic as order-converter.ts and Edge Function)
      financial_status: inferFinancialStatusFromTransactions(gqlOrder),
      fulfillment_status: null, // Not available in GraphQL order type we're using
      source_name: null, // Not available in GraphQL order type we're using
      tags: null, // Not available in GraphQL order type we're using
      billing_address: gqlOrder.billingAddress ? {
        country_code: gqlOrder.billingAddress.countryCode || null,
        country: gqlOrder.billingAddress.country || null,
      } : null,
      shipping_address: gqlOrder.shippingAddress ? {
        country_code: gqlOrder.shippingAddress.countryCode || null,
        country: gqlOrder.shippingAddress.country || null,
      } : null,
    };
    return restOrder;
  });
  
  console.log(`[shopify_backfill] Converted ${allOrdersFetched.length} GraphQL orders to REST format\n`);
  
  // No need for additional filtering since GraphQL already filtered on processed_at
  // But we'll still deduplicate in case of any edge cases
  const uniqueOrdersMap = new Map<string, ShopifyOrder>();
  for (const order of allOrdersFetched) {
    const orderId = order.id.toString();
    if (!uniqueOrdersMap.has(orderId)) {
      uniqueOrdersMap.set(orderId, order);
    }
  }
  const shopifyOrders = Array.from(uniqueOrdersMap.values());
  
  console.log(`[shopify_backfill] Using ${shopifyOrders.length} unique orders after deduplication\n`);


  // Map to database rows. IMPORTANT: keep processed_at as the order's processed day (shop timezone).
  // Refunds are allocated to their own day in daily aggregations; we should not "move" the order to the refund day.
  let orderRows: ShopifyOrderRow[] = shopifyOrders.map((order) =>
    mapShopifyOrderToRow(tenantId, order),
  );

  // Calculate stable customer history for all customers in this batch
  console.log(`\n[shopify_backfill] Calculating customer history for classification...`);
  
  // Get all unique customer IDs from this batch
  const customerIdsInBatch = new Set<string>();
  orderRows.forEach((row) => {
    if (row.customer_id) {
      customerIdsInBatch.add(row.customer_id);
    }
  });

  console.log(`[shopify_backfill] Found ${customerIdsInBatch.size} unique customers in batch`);

  // Fetch ALL orders for these customers from database (for stable history calculation)
  const customerHistories = new Map<string, CustomerHistory>();
  
  if (customerIdsInBatch.size > 0) {
    console.log(`[shopify_backfill] Fetching all historical orders for customers...`);
    const { data: allCustomerOrders, error: lookupError } = await supabase
      .from('shopify_orders')
      .select('order_id, customer_id, created_at, processed_at, net_sales, gross_sales, financial_status, refunds')
      .eq('tenant_id', tenantId)
      .in('customer_id', Array.from(customerIdsInBatch))
      .not('customer_id', 'is', null)
      .not('created_at', 'is', null)
      .order('created_at', { ascending: true });

    if (lookupError) {
      console.warn(`[shopify_backfill] Failed to lookup existing orders: ${lookupError.message}`);
    } else if (allCustomerOrders) {
      // Group orders by customer
      const ordersByCustomer = new Map<string, CustomerOrderInfo[]>();
      
      for (const dbOrder of allCustomerOrders) {
        const customerId = dbOrder.customer_id as string;
        if (!ordersByCustomer.has(customerId)) {
          ordersByCustomer.set(customerId, []);
        }
        
        const netSales = parseFloat((dbOrder.net_sales || 0).toString()) || 0;
        const totalRefunds = parseFloat((dbOrder.refunds || 0).toString()) || 0;
        // Check if cancelled based on financial_status (voided typically means cancelled)
        const financialStatus = (dbOrder.financial_status as string) || '';
        const isCancelled = financialStatus === 'voided' || financialStatus.toLowerCase().includes('cancelled');
        const isFullRefunded = !isCancelled && netSales > 0 && Math.abs(totalRefunds) >= Math.abs(netSales);
        
        ordersByCustomer.get(customerId)!.push({
          order_id: dbOrder.order_id as string,
          created_at: dbOrder.created_at as string,
          net_sales: netSales,
          is_cancelled: isCancelled,
          is_full_refunded: isFullRefunded,
          financial_status: dbOrder.financial_status as string | null,
        });
      }
      
      // Add orders from current batch to history
      for (const row of orderRows) {
        if (row.customer_id && row.created_at) {
          if (!ordersByCustomer.has(row.customer_id)) {
            ordersByCustomer.set(row.customer_id, []);
          }
          
          const netSales = row.net_sales || 0;
          const totalRefunds = Math.abs(row.refunds || 0);
          const isCancelled = false; // Will be checked from order data
          const isFullRefunded = netSales > 0 && totalRefunds >= netSales;
          
          // Only add if not already in history
          const existing = ordersByCustomer.get(row.customer_id)!;
          if (!existing.find(o => o.order_id === row.order_id)) {
            existing.push({
              order_id: row.order_id,
              created_at: row.created_at,
              net_sales: netSales,
              is_cancelled: isCancelled,
              is_full_refunded: isFullRefunded,
              financial_status: row.financial_status,
            });
          }
        }
      }
      
      // Calculate customer history for each customer
      for (const [customerId, orders] of ordersByCustomer.entries()) {
        // Sort by created_at ascending
        const sortedOrders = [...orders].sort((a, b) => a.created_at.localeCompare(b.created_at));
        
        if (sortedOrders.length === 0) continue;
        
        const firstOrderAllTime = sortedOrders[0];
        
        // Find first revenue-generating order (NetSales > 0 and not cancelled/full-refunded)
        let firstRevenueOrder: CustomerOrderInfo | null = null;
        for (const order of sortedOrders) {
          if (order.net_sales > 0 && !order.is_cancelled && !order.is_full_refunded) {
            firstRevenueOrder = order;
            break;
          }
        }
        
        customerHistories.set(customerId, {
          first_order_id_all_time: firstOrderAllTime.order_id,
          first_revenue_order_id: firstRevenueOrder?.order_id || null,
          all_orders: sortedOrders,
        });
      }
    }
  }

  console.log(`[shopify_backfill] Calculated history for ${customerHistories.size} customers`);

  // Classify each order based on customer history
  // We also need customer.createdAt from GraphQL - will fetch that next
  // For now, set preliminary classifications
  orderRows = orderRows.map((row) => {
    if (!row.customer_id) {
      // Guest checkout
      return {
        ...row,
        is_first_order_for_customer: false,
        customer_type_shopify_mode: 'GUEST' as const,
        customer_type_financial_mode: 'GUEST' as const,
        is_new_customer: false,
      };
    }
    
    const history = customerHistories.get(row.customer_id);
    if (!history) {
      // No history found - this might be a new customer
      // Will be determined more accurately after GraphQL fetch
      return {
        ...row,
        is_first_order_for_customer: true, // Preliminary - might be updated
        customer_type_shopify_mode: null,
        customer_type_financial_mode: null,
        is_new_customer: false,
      };
    }
    
    const isFirstOrderAllTime = row.order_id === history.first_order_id_all_time;
    const isFirstRevenueOrder = history.first_revenue_order_id && row.order_id === history.first_revenue_order_id;
    
    // DEPRECATED: Financial mode classification removed - kept null for backward compatibility
    return {
      ...row,
      is_first_order_for_customer: isFirstOrderAllTime,
      customer_type_financial_mode: null, // DEPRECATED - not used anymore
      // Shopify mode will be set after GraphQL fetch (needs customer.createdAt)
      customer_type_shopify_mode: null,
      is_new_customer: false, // Deprecated
    };
  });

  console.log(`\n[shopify_backfill] Mapped ${orderRows.length} orders to database rows`);

  if (args.dry_run) {
    console.log('\n[shopify_backfill] DRY RUN - Not saving to database');
    console.log('\n[shopify_backfill] Sample order:');
    console.log(JSON.stringify(orderRows[0], null, 2));
    return;
  }

  // Helper function for retry with exponential backoff
  async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelayMs: number = 1000,
    description: string = 'operation'
  ): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
          console.warn(
            `[shopify_backfill] ${description} failed (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError || new Error(`Failed ${description} after ${maxRetries} attempts`);
  }

  // Save orders to database in batches to avoid timeout
  console.log(`\n[shopify_backfill] Upserting orders to shopify_orders table...`);
  const ORDER_BATCH_SIZE = 500; // Reduced from 1000 for better stability
  let savedOrderCount = 0;
  const failedBatches: number[] = [];
  
  for (let i = 0; i < orderRows.length; i += ORDER_BATCH_SIZE) {
    const batch = orderRows.slice(i, i + ORDER_BATCH_SIZE);
    const batchNum = Math.floor(i / ORDER_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(orderRows.length / ORDER_BATCH_SIZE);
    console.log(`[shopify_backfill] Upserting order batch ${batchNum}/${totalBatches} (${batch.length} orders)...`);
    
    try {
      await retryWithBackoff(
        async () => {
          const { error: upsertError } = await supabase.from('shopify_orders').upsert(batch, {
            onConflict: 'tenant_id,order_id',
          });
          if (upsertError) {
            throw new Error(upsertError.message);
          }
        },
        3,
        2000,
        `Order batch ${batchNum}/${totalBatches} upsert`,
      );
      
      savedOrderCount += batch.length;
      console.log(`[shopify_backfill] ✓ Successfully saved batch ${batchNum}/${totalBatches} (${savedOrderCount}/${orderRows.length} total)`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[shopify_backfill] ✗ Failed to upsert order batch ${batchNum} after retries: ${errorMessage}`);
      failedBatches.push(batchNum);
      
      // Continue with next batch instead of crashing entire process
      console.warn(`[shopify_backfill] Continuing with remaining batches...`);
    }
  }

  if (failedBatches.length > 0) {
    console.error(`\n[shopify_backfill] ⚠️  WARNING: ${failedBatches.length} batches failed to save: ${failedBatches.join(', ')}`);
    console.error(`[shopify_backfill] Consider re-running the backfill to retry failed batches`);
  }

  console.log(`[shopify_backfill] Successfully saved ${savedOrderCount}/${orderRows.length} orders`);

  // Save transactions for 100% matching
  //
  // IMPORTANT: We must include orders UPDATED in the period, not only orders CREATED in the period.
  // Shopify Analytics "Dag" attributes returns by refund date; refunds update the order.
  // We already fetched a union of:
  // - processed_at in [since, until]
  // - updated_at in [since, until]
  // earlier in this script (graphqlOrdersForClassification). Reuse that dataset here so
  // RETURN transactions are generated for refunds that happened in the period even if the
  // original order was outside the period.
  console.log(`\n[shopify_backfill] Mapping transactions from GraphQL orders...`);
  let graphqlOrders: GraphQLOrder[] = [];
  try {
    graphqlOrders = graphqlOrdersForClassification;
    console.log(`[shopify_backfill] Using ${graphqlOrders.length} GraphQL orders (processed_at + updated_at union) for transaction mapping`);

    // Map GraphQL orders to transactions
    const allTransactions: SalesTransaction[] = [];
    for (const graphqlOrder of graphqlOrders) {
      const transactions = mapOrderToTransactions(graphqlOrder, 'Europe/Stockholm');
      allTransactions.push(...transactions);
    }
    console.log(`[shopify_backfill] Mapped to ${allTransactions.length} transactions`);

    // Convert transactions to database format
    const transactionRowsRaw = allTransactions.map((t) => ({
      tenant_id: tenantId,
      shopify_order_id: t.shopify_order_id,
      shopify_order_name: t.shopify_order_name,
      shopify_order_number: t.shopify_order_number,
      shopify_refund_id: t.shopify_refund_id,
      shopify_line_item_id: t.shopify_line_item_id,
      event_type: t.event_type,
      event_date: t.event_date,
      currency: t.currency,
      product_sku: t.product_sku,
      product_title: t.product_title,
      variant_title: t.variant_title,
      quantity: t.quantity,
      gross_sales: t.gross_sales,
      discounts: t.discounts,
      returns: t.returns,
      shipping: t.shipping,
      tax: t.tax,
    }));

    // Deduplicate transactions based on unique constraint key
    // Unique constraint: tenant_id,shopify_order_id,shopify_line_item_id,event_type,event_date,shopify_refund_id
    const transactionMap = new Map<string, typeof transactionRowsRaw[0]>();
    for (const row of transactionRowsRaw) {
      const key = `${row.tenant_id}|${row.shopify_order_id}|${row.shopify_line_item_id}|${row.event_type}|${row.event_date}|${row.shopify_refund_id || ''}`;
      if (!transactionMap.has(key)) {
        transactionMap.set(key, row);
      }
    }
    const transactionRows = Array.from(transactionMap.values());

    if (transactionRows.length < transactionRowsRaw.length) {
      console.log(`[shopify_backfill] Removed ${transactionRowsRaw.length - transactionRows.length} duplicate transactions`);
    }

    // Save transactions to database in batches to avoid conflicts
    console.log(`[shopify_backfill] Upserting ${transactionRows.length} transactions to shopify_sales_transactions table...`);
    const TRANSACTION_BATCH_SIZE = 500; // Reduced from 1000 for better stability
    let savedCount = 0;
    const failedTransactionBatches: number[] = [];
    
    for (let i = 0; i < transactionRows.length; i += TRANSACTION_BATCH_SIZE) {
      const batch = transactionRows.slice(i, i + TRANSACTION_BATCH_SIZE);
      const batchNum = Math.floor(i / TRANSACTION_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(transactionRows.length / TRANSACTION_BATCH_SIZE);
      
      try {
        await retryWithBackoff(
          async () => {
            const { error: transactionError } = await supabase
              .from('shopify_sales_transactions')
              .upsert(batch, {
                onConflict: 'tenant_id,shopify_order_id,shopify_line_item_id,event_type,event_date,shopify_refund_id',
              });
            if (transactionError) {
              throw new Error(transactionError.message);
            }
          },
          3,
          2000,
          `Transaction batch ${batchNum}/${totalBatches} upsert`,
        );
        
        savedCount += batch.length;
        if (batchNum % 10 === 0 || batchNum === totalBatches) {
          console.log(`[shopify_backfill] ✓ Saved transaction batch ${batchNum}/${totalBatches} (${savedCount}/${transactionRows.length} total)`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[shopify_backfill] ✗ Failed to upsert transaction batch ${batchNum} after retries: ${errorMessage}`);
        failedTransactionBatches.push(batchNum);
        // Continue with next batch
      }
    }

    if (failedTransactionBatches.length > 0) {
      console.warn(`[shopify_backfill] ⚠️  WARNING: ${failedTransactionBatches.length} transaction batches failed: ${failedTransactionBatches.slice(0, 10).join(', ')}${failedTransactionBatches.length > 10 ? '...' : ''}`);
    }

    if (savedCount > 0) {
      console.log(`[shopify_backfill] Successfully saved ${savedCount}/${transactionRows.length} transactions`);
    } else {
      console.warn(`[shopify_backfill] No transactions were saved. Continuing with KPI aggregation using shopify_orders...`);
    }
  } catch (error) {
    console.warn(`[shopify_backfill] Failed to fetch/save transactions via GraphQL: ${error instanceof Error ? error.message : String(error)}`);
    console.warn(`[shopify_backfill] Continuing with KPI aggregation using shopify_orders...`);
  }

  // Aggregate KPIs
  const aggregates = aggregateKpis(orderRows);
  const kpiRows = aggregates.map((row) => ({
    tenant_id: tenantId,
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

  // Save KPIs to database in batches
  console.log(`[shopify_backfill] Upserting KPIs to kpi_daily table...`);
  const KPI_BATCH_SIZE = 500;
  let savedKpiCount = 0;
  const failedKpiBatches: number[] = [];
  
  for (let i = 0; i < kpiRows.length; i += KPI_BATCH_SIZE) {
    const batch = kpiRows.slice(i, i + KPI_BATCH_SIZE);
    const batchNum = Math.floor(i / KPI_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(kpiRows.length / KPI_BATCH_SIZE);
    
    try {
      await retryWithBackoff(
        async () => {
          const { error: kpiError } = await supabase.from('kpi_daily').upsert(batch, {
            onConflict: 'tenant_id,date,source',
          });
          if (kpiError) {
            throw new Error(kpiError.message);
          }
        },
        3,
        2000,
        `KPI batch ${batchNum}/${totalBatches} upsert`,
      );
      
      savedKpiCount += batch.length;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[shopify_backfill] ✗ Failed to upsert KPI batch ${batchNum} after retries: ${errorMessage}`);
      failedKpiBatches.push(batchNum);
    }
  }
  
  if (failedKpiBatches.length > 0) {
    console.warn(`[shopify_backfill] ⚠️  WARNING: ${failedKpiBatches.length} KPI batches failed: ${failedKpiBatches.join(', ')}`);
  }
  
  console.log(`[shopify_backfill] Successfully saved ${savedKpiCount}/${kpiRows.length} KPI rows`);

  // Calculate and save daily sales for both modes
  if (graphqlOrdersForClassification.length > 0) {
    console.log(`\n[shopify_backfill] Calculating daily sales for both modes...`);
    
    // Build orderCustomerClassification map from GraphQL data and orderRows
    console.log(`[shopify_backfill] Building customer classification map from GraphQL data...`);
    const orderCustomerClassification = new Map<string, OrderCustomerClassification>();
    const fromDateObj = new Date(`${since}T00:00:00`);
    const toDateObj = new Date(`${until}T23:59:59`);
    
    for (const graphqlOrder of graphqlOrdersForClassification) {
      const orderId = (graphqlOrder.legacyResourceId || graphqlOrder.id).toString();
      const orderRow = orderRows.find(r => r.order_id === orderId);
      
      if (!orderRow) continue;
      
      if (!graphqlOrder.customer) {
        // Guest checkout
        orderCustomerClassification.set(orderId, {
          shopifyMode: 'GUEST',
          financialMode: 'GUEST', // DEPRECATED - kept for backward compatibility
          customerCreatedAt: null,
          isFirstOrderForCustomer: false,
        });
      } else {
        const customerCreatedAt = graphqlOrder.customer.createdAt || null;
        const numberOfOrders = parseInt(graphqlOrder.customer.numberOfOrders || '0', 10);
        let shopifyMode: 'FIRST_TIME' | 'RETURNING' | 'GUEST' | 'UNKNOWN' = 'UNKNOWN';
        
        // Shopify Mode classification: Def 6 - Customer created in period OR (numberOfOrders === 1)
        // Use GraphQL order.createdAt (original, not modified)
        // CRITICAL: We only classify orders as NEW/FIRST_TIME if order.createdAt (from GraphQL) is in the reporting period
        // Orders that are included via refunds or processed_at (but created_at outside period) should be RETURNING
        const graphqlOrderCreatedAt = graphqlOrder.createdAt;
        const orderCreatedAtDate = graphqlOrderCreatedAt 
          ? new Date(graphqlOrderCreatedAt).toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' })
          : null;
        const orderCreatedInPeriod = orderCreatedAtDate && orderCreatedAtDate >= since && orderCreatedAtDate <= until;
        
        if (orderCreatedInPeriod) {
          // Order was created in period - check if customer is new using numberOfOrders
          // IMPORTANT: For full backfills, we should ONLY use numberOfOrders, not customerCreatedInPeriod
          // because customerCreatedInPeriod will be true for almost all customers in a large date range
          // numberOfOrders === 1 means this is their first order ever
          // numberOfOrders > 1 means this is a returning customer's order
          if (numberOfOrders === 1) {
            shopifyMode = 'FIRST_TIME';
          } else if (numberOfOrders > 1) {
            shopifyMode = 'RETURNING';
          } else {
            // numberOfOrders is 0 or invalid - default to RETURNING (safer assumption)
            shopifyMode = 'RETURNING';
          }
        } else {
          // Order was NOT created in period (included via refund or processed_at) - always RETURNING
          shopifyMode = 'RETURNING';
        }
        
        // DEPRECATED: Financial mode removed - set to RETURNING for backward compatibility
        orderCustomerClassification.set(orderId, {
          shopifyMode,
          financialMode: 'RETURNING' as 'NEW' | 'RETURNING' | 'GUEST' | 'UNKNOWN', // DEPRECATED - not used
          customerCreatedAt,
          isFirstOrderForCustomer: orderRow.is_first_order_for_customer,
        });
      }
    }
    
    // Update orderRows with Shopify Mode classification (if not already set)
    const updatedOrderRows = orderRows.map((row) => {
      const classification = orderCustomerClassification.get(row.order_id);
      if (classification && !row.customer_type_shopify_mode) {
        // Determine is_first_order_for_customer based on numberOfOrders
        // If numberOfOrders === 1, this is their first order
        const isFirstOrder = classification.shopifyMode === 'FIRST_TIME';
        return {
          ...row,
          customer_type_shopify_mode: classification.shopifyMode,
          is_first_order_for_customer: isFirstOrder,
          is_new_customer: classification.shopifyMode === 'FIRST_TIME', // Deprecated field
        };
      }
      return row;
    });
    
    orderRows = updatedOrderRows;
    
    // Log classification summary (Shopify Mode only)
    const shopifyNew = orderRows.filter(r => r.customer_type_shopify_mode === 'FIRST_TIME').length;
    const shopifyReturning = orderRows.filter(r => r.customer_type_shopify_mode === 'RETURNING').length;
    const shopifyGuest = orderRows.filter(r => r.customer_type_shopify_mode === 'GUEST').length;
    
    console.log(`[shopify_backfill] Customer classification summary (Shopify Mode):`);
    console.log(`[shopify_backfill]   FIRST_TIME: ${shopifyNew}, RETURNING: ${shopifyReturning}, GUEST: ${shopifyGuest}`);
    
    // IMPORTANT: Update database with correct customer_type_shopify_mode and is_first_order_for_customer
    // This ensures the classification persists in the database
    console.log(`\n[shopify_backfill] Updating customer classification in database...`);
    const ordersToUpdate = orderRows.filter(row => {
      const classification = orderCustomerClassification.get(row.order_id);
      return classification && classification.shopifyMode;
    });
    
    if (ordersToUpdate.length > 0) {
      const UPDATE_BATCH_SIZE = 500;
      let updatedCount = 0;
      
      for (let i = 0; i < ordersToUpdate.length; i += UPDATE_BATCH_SIZE) {
        const batch = ordersToUpdate.slice(i, i + UPDATE_BATCH_SIZE);
        const batchNum = Math.floor(i / UPDATE_BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(ordersToUpdate.length / UPDATE_BATCH_SIZE);
        
        try {
          await retryWithBackoff(
            async () => {
              // Update each order individually (Supabase doesn't support batch updates with different values easily)
              const updates = batch.map((row) => {
                const classification = orderCustomerClassification.get(row.order_id)!;
                const isFirstOrder = classification.shopifyMode === 'FIRST_TIME';
                return supabase
                  .from('shopify_orders')
                  .update({
                    customer_type_shopify_mode: classification.shopifyMode,
                    is_first_order_for_customer: isFirstOrder,
                  })
                  .eq('tenant_id', tenantId)
                  .eq('order_id', row.order_id);
              });
              
              await Promise.all(updates);
            },
            3,
            2000,
            `Customer classification batch ${batchNum}/${totalBatches}`,
          );
          
          updatedCount += batch.length;
          console.log(`[shopify_backfill] ✓ Updated classification for batch ${batchNum}/${totalBatches} (${updatedCount}/${ordersToUpdate.length} total)`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[shopify_backfill] ✗ Failed to update classification batch ${batchNum}: ${errorMessage}`);
        }
      }
      
      console.log(`[shopify_backfill] ✓ Customer classification updated in database`);
    }
    
    // Convert GraphQL orders to ShopifyOrderWithTransactions format
    const shopifyOrdersWithTransactions = graphqlOrdersForClassification
      .filter((order) => !order.test) // Exclude test orders
      .map(convertGraphQLOrderToShopifyOrder);

    // For Shopify Mode: Use the same orders we already fetched (no need to fetch again)
    // These are already filtered by processed_at which is what we want
    const shopifyModeGraphQLOrders = graphqlOrdersForClassification;
    
    const shopifyModeOrdersWithTransactions = shopifyModeGraphQLOrders
      .filter((order) => !order.test)
      .map(convertGraphQLOrderToShopifyOrder);
    
    // Build classification map for Shopify Mode orders (subset of full dataset)
    // Note: We need to ensure these orders are in our orderCustomerClassification map
    // If not, we'll use the same classification logic but only for orders created in period
    const shopifyModeClassification = new Map<string, OrderCustomerClassification>();
    for (const graphqlOrder of shopifyModeGraphQLOrders) {
      const orderId = (graphqlOrder.legacyResourceId || graphqlOrder.id).toString();
      const existingClassification = orderCustomerClassification.get(orderId);
      if (existingClassification) {
        shopifyModeClassification.set(orderId, existingClassification);
      } else {
        // Fallback: classify on the fly if not in main map
        if (!graphqlOrder.customer) {
          shopifyModeClassification.set(orderId, {
            shopifyMode: 'GUEST',
            financialMode: 'GUEST',
            customerCreatedAt: null,
            isFirstOrderForCustomer: false,
          });
        } else {
          const customerCreatedAt = graphqlOrder.customer.createdAt || null;
          const numberOfOrders = parseInt(graphqlOrder.customer.numberOfOrders || '0', 10);
          
          // Use numberOfOrders to determine if this is customer's first order
          // numberOfOrders === 1 means this is their first order ever
          // numberOfOrders > 1 means this is a returning customer's order
          let shopifyMode: 'FIRST_TIME' | 'RETURNING' | 'GUEST' | 'UNKNOWN' = 'RETURNING';
          if (numberOfOrders === 1) {
            shopifyMode = 'FIRST_TIME';
          } else if (numberOfOrders > 1) {
            shopifyMode = 'RETURNING';
          }
          
          shopifyModeClassification.set(orderId, {
            shopifyMode,
            financialMode: 'RETURNING' as const, // DEPRECATED - not used
            customerCreatedAt,
            isFirstOrderForCustomer: numberOfOrders === 1,
          });
        }
      }
    }

    // Calculate daily sales for Shopify Mode only
    const shopifyModeDailyAll = calculateDailySales(
      shopifyModeOrdersWithTransactions, // Only orders created in period for Shopify Mode
      'shopify', 
      'Europe/Stockholm', 
      undefined, // Legacy orderCustomerMap - not used
      shopifyModeClassification, // Classification map for Shopify Mode orders only
      since, // Reporting period start for customer.createdAt check
      until, // Reporting period end
    );

    // Only persist daily rows for the requested reporting period to avoid overwriting historical days
    // when we include older orders (via updated_at) to capture refunds within the period.
    const shopifyModeDaily = shopifyModeDailyAll.filter(
      (row) => (!since || row.date >= since) && (!until || row.date <= until),
    );

    console.log(`[shopify_backfill] Shopify mode: ${shopifyModeDaily.length} daily rows`);

    // Prepare rows for database (Shopify Mode only)
    const dailySalesRows = shopifyModeDaily.map((row) => ({
      tenant_id: tenantId,
      date: row.date,
      mode: 'shopify' as SalesMode,
      net_sales_excl_tax: row.netSalesExclTax,
      gross_sales_excl_tax: row.grossSalesExclTax || null,
      refunds_excl_tax: row.refundsExclTax || null,
      discounts_excl_tax: row.discountsExclTax || null,
      orders_count: row.ordersCount,
      currency: row.currency || null,
      new_customer_net_sales: row.newCustomerNetSales || 0,
      returning_customer_net_sales: row.returningCustomerNetSales || 0,
      guest_net_sales: row.guestNetSales || 0,
    }));

    // Save daily sales to database in batches
    console.log(`[shopify_backfill] Upserting ${dailySalesRows.length} daily sales rows...`);
    const DAILY_SALES_BATCH_SIZE = 500;
    let savedDailySalesCount = 0;
    const failedDailySalesBatches: number[] = [];
    
    for (let i = 0; i < dailySalesRows.length; i += DAILY_SALES_BATCH_SIZE) {
      const batch = dailySalesRows.slice(i, i + DAILY_SALES_BATCH_SIZE);
      const batchNum = Math.floor(i / DAILY_SALES_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(dailySalesRows.length / DAILY_SALES_BATCH_SIZE);
      
      try {
        await retryWithBackoff(
          async () => {
            const { error: dailySalesError } = await supabase
              .from('shopify_daily_sales')
              .upsert(batch, {
                onConflict: 'tenant_id,date,mode',
              });
            if (dailySalesError) {
              throw new Error(dailySalesError.message);
            }
          },
          3,
          2000,
          `Daily sales batch ${batchNum}/${totalBatches} upsert`,
        );
        
        savedDailySalesCount += batch.length;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[shopify_backfill] ✗ Failed to upsert daily sales batch ${batchNum} after retries: ${errorMessage}`);
        failedDailySalesBatches.push(batchNum);
      }
    }
    
    if (failedDailySalesBatches.length > 0) {
      console.warn(`[shopify_backfill] ⚠️  WARNING: ${failedDailySalesBatches.length} daily sales batches failed: ${failedDailySalesBatches.join(', ')}`);
    }
    
    if (savedDailySalesCount > 0) {
      console.log(`[shopify_backfill] Successfully saved ${savedDailySalesCount}/${dailySalesRows.length} daily sales rows`);
    } else {
      console.warn(`[shopify_backfill] No daily sales rows were saved.`);
    }
  }

  // Clear backfill flag if it exists (need to fetch connection again to check)
  const { data: connectionCheck } = await supabaseClient
    .from('connections')
    .select('meta')
    .eq('tenant_id', tenantId)
    .eq('source', 'shopify')
    .maybeSingle();

  if (connectionCheck?.meta?.backfill_since) {
    const clearedMeta = {
      ...(connectionCheck.meta ?? {}),
      backfill_since: null,
    };

    const { error: clearError } = await supabaseClient
      .from('connections')
      .update({
        meta: clearedMeta,
        updated_at: new Date().toISOString(),
      })
      .eq('tenant_id', tenantId)
      .eq('source', 'shopify');

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
  console.log(`  - GraphQL orders fetched: ${graphqlOrdersForClassification?.length || 0}`);
  console.log(`  - Date range: ${since} to ${until}`);
}

main().catch((error) => {
  console.error('\n[shopify_backfill] ❌ Error:', error);
  process.exit(1);
});

