import { NextRequest, NextResponse } from 'next/server';

import { verifyShopifyWebhook } from '@/lib/integrations/shopify';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { logger, withRequestContext } from '@/lib/logger';
import { decryptSecret } from '@/lib/integrations/crypto';

const WEBHOOK_ENDPOINT = '/api/webhooks/shopify';

import {
  calculateShopifyLikeSales,
  type ShopifyOrder as SalesShopifyOrder,
} from '@/lib/shopify/sales';
import { fetchShopifyOrderGraphQL, type GraphQLOrder } from '@/lib/integrations/shopify-graphql';
import { mapOrderToTransactions, type SalesTransaction } from '@/lib/shopify/transaction-mapper';
import { getShopifyAccessToken } from '@/lib/integrations/shopify';

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

function normalizeShopDomain(domain: string): string {
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

// Helper function to parse date in Stockholm timezone (not UTC)
// This matches file behavior where dates are grouped by local date, not UTC date
function parseDateInStockholmTimezone(dateStr: string | null): string | null {
  if (!dateStr) return null;
  try {
    const date = new Date(dateStr);
    // Use toLocaleDateString with Stockholm timezone to get correct date
    // 'en-CA' format gives us YYYY-MM-DD
    return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' });
  } catch {
    return null;
  }
}

function mapShopifyOrderToRow(tenantId: string, order: ShopifyOrder) {
  // Extract date from processed_at using Stockholm timezone (matches file behavior)
  // For webhooks: Determine the correct processed_at based on same logic as backfill:
  // 1. If order has refunds created today, use refund.created_at
  // 2. If created_at is today, use created_at (file behavior)
  // 3. Otherwise, use processed_at
  const processedAtRaw = order.processed_at
    ? parseDateInStockholmTimezone(order.processed_at)
    : null;
  
  const orderCreatedAt = order.created_at
    ? parseDateInStockholmTimezone(order.created_at)
    : null;
  
  let processedAt: string | null = processedAtRaw;
  
  // Get today's date in Stockholm timezone for comparison
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' });
  
  // Priority 1: Check for refunds created today
  if (order.refunds && Array.isArray(order.refunds) && order.refunds.length > 0) {
    for (const refund of order.refunds) {
      if (refund.created_at) {
        const refundDate = parseDateInStockholmTimezone(refund.created_at);
        if (refundDate === today) {
          processedAt = refundDate;
          break;
        }
      }
    }
  }
  
  // Priority 2: If created_at is today, use created_at (file behavior)
  if (orderCreatedAt === today) {
    processedAt = orderCreatedAt;
  }
  
  // Priority 3: Use processed_at if available (already set above)

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
    
    // Gross Sales should ALWAYS be set if order has total_price
    // Even if line_items are missing (they might not have been fetched in older data)
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
    is_new_customer: false, // Will be determined below
    country: country || null,
  };
}

function aggregateKpis(rows: ReturnType<typeof mapShopifyOrderToRow>[]) {
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
    const netValue = row.net_sales ?? 0;
    existing.total_sales += row.gross_sales ?? 0; // gross_sales in shopify_orders is Total Sales
    existing.total_tax += row.total_tax ?? 0;
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
    
    // Calculate Gross Sales as Total Sales - Tax (to match Orders page)
    const grossSales = values.total_sales - values.total_tax;
    
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

async function processWebhookOrder(
  client: ReturnType<typeof getSupabaseServiceClient>,
  tenantId: string,
  order: ShopifyOrder,
  shopDomain: string,
) {
  let orderRow = mapShopifyOrderToRow(tenantId, order);

  // Determine if customer is new or returning
  if (orderRow.customer_id && orderRow.processed_at) {
    // Check if there's an earlier order for this customer
    const { data: earlierOrders, error: lookupError } = await client
      .from('shopify_orders')
      .select('processed_at')
      .eq('tenant_id', tenantId)
      .eq('customer_id', orderRow.customer_id)
      .not('processed_at', 'is', null)
      .lt('processed_at', orderRow.processed_at)
      .limit(1);

    if (lookupError) {
      logger.warn(
        {
          route: 'shopify_webhook',
          action: 'lookup_customer',
          tenantId,
          orderId: order.id,
          customerId: orderRow.customer_id,
          error_message: lookupError.message,
        },
        'Failed to lookup customer order history',
      );
      // Default to false if lookup fails
      orderRow.is_new_customer = false;
    } else {
      // If no earlier orders found, this is a new customer
      orderRow.is_new_customer = !earlierOrders || earlierOrders.length === 0;
    }
  } else {
    orderRow.is_new_customer = false;
  }

  // Upsert order
  const { error: upsertError } = await client.from('shopify_orders').upsert(orderRow, {
    onConflict: 'tenant_id,order_id',
  });

  if (upsertError) {
    throw new Error(`Failed to upsert order: ${upsertError.message}`);
  }

  // Fetch full order via GraphQL and create transactions for 100% matching
  try {
    if (shopDomain) {
      const graphqlOrder = await fetchShopifyOrderGraphQL({
        tenantId,
        shopDomain,
        orderId: order.id.toString(),
      });

      if (graphqlOrder && !graphqlOrder.test) {
        // Map to transactions
        const transactions = mapOrderToTransactions(graphqlOrder, 'Europe/Stockholm');

        // Convert to database format
        const transactionRows = transactions.map((t) => ({
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

        // Upsert transactions
        const { error: transactionError } = await client
          .from('shopify_sales_transactions')
          .upsert(transactionRows, {
            onConflict: 'tenant_id,shopify_order_id,shopify_line_item_id,event_type,event_date,shopify_refund_id',
          });

        if (transactionError) {
          logger.warn(
            {
              route: 'shopify_webhook',
              action: 'upsert_transactions',
              tenantId,
              orderId: order.id,
              error_message: transactionError.message,
            },
            'Failed to upsert transactions for webhook order',
          );
        } else {
          logger.info(
            {
              route: 'shopify_webhook',
              action: 'upsert_transactions',
              tenantId,
              orderId: order.id,
              transactionCount: transactionRows.length,
            },
            'Successfully created transactions for webhook order',
          );
        }
      }
    }
  } catch (error) {
    // Don't fail webhook if transaction creation fails - log and continue
    logger.warn(
      {
        route: 'shopify_webhook',
        action: 'create_transactions',
        tenantId,
        orderId: order.id,
        error_message: error instanceof Error ? error.message : String(error),
      },
      'Failed to create transactions for webhook order (continuing anyway)',
    );
  }

  // Recalculate KPIs for this order's date based on all orders for that date
  // This ensures accuracy when orders are updated
  if (orderRow.processed_at) {
    const { data: allOrdersForDate, error: fetchError } = await client
      .from('shopify_orders')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('processed_at', orderRow.processed_at);

    if (fetchError) {
      logger.warn(
        {
          route: 'shopify_webhook',
          action: 'fetch_orders_for_date',
          tenantId,
          orderId: order.id,
          date: orderRow.processed_at,
          error_message: fetchError.message,
        },
        'Failed to fetch orders for KPI recalculation',
      );
      return;
    }

    // Aggregate all orders for this date
    // Use stored values if available, otherwise calculate from refunds data
    const allOrderRows = (allOrdersForDate || []).map((o) => {
      // If we have stored gross_sales and net_sales, use them (already includes refunds calculation)
      // Otherwise, we'll need to recalculate - but for webhook updates, we should have the values
      return {
        processed_at: o.processed_at,
        total_price: o.total_price,
        gross_sales: o.gross_sales,
        net_sales: o.net_sales,
        total_refunds: o.total_refunds ?? 0,
        currency: o.currency,
        is_refund: o.is_refund,
        is_new_customer: o.is_new_customer ?? false,
      };
    });

    const aggregates = aggregateKpis(allOrderRows);
    if (aggregates.length > 0) {
      const kpiRow = aggregates[0];
      const kpiDbRow = {
        tenant_id: tenantId,
        date: kpiRow.date,
        source: 'shopify',
        spend: kpiRow.spend,
        clicks: kpiRow.clicks,
        conversions: kpiRow.conversions,
        revenue: kpiRow.revenue,
        gross_sales: kpiRow.gross_sales,
        net_sales: kpiRow.net_sales,
        new_customer_conversions: kpiRow.new_customer_conversions,
        returning_customer_conversions: kpiRow.returning_customer_conversions,
        new_customer_net_sales: kpiRow.new_customer_net_sales,
        returning_customer_net_sales: kpiRow.returning_customer_net_sales,
        currency: kpiRow.currency,
        aov: kpiRow.aov,
        cos: kpiRow.cos,
        roas: kpiRow.roas,
      };

      const { error: upsertError } = await client.from('kpi_daily').upsert(kpiDbRow, {
        onConflict: 'tenant_id,date,source',
      });

      if (upsertError) {
        logger.warn(
          {
            route: 'shopify_webhook',
            action: 'upsert_kpi',
            tenantId,
            orderId: order.id,
            date: orderRow.processed_at,
            error_message: upsertError.message,
          },
          'Failed to upsert KPI for webhook order',
        );
      }
    }
  }
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? undefined;

  return withRequestContext(async () => {
    // 1. Verify HMAC signature
    const hmacHeader = request.headers.get('x-shopify-hmac-sha256');
    const body = await request.text();

    const isValid = await verifyShopifyWebhook(body, hmacHeader);
    if (!isValid) {
      logger.error(
        {
          route: 'shopify_webhook',
          action: 'verify_hmac',
          endpoint: WEBHOOK_ENDPOINT,
          error_message: 'Invalid HMAC signature',
        },
        'Shopify webhook HMAC verification failed',
      );
      return NextResponse.json({ error: 'Invalid HMAC signature' }, { status: 401 });
    }

    // 2. Extract shop domain from header
    const shopDomain = request.headers.get('x-shopify-shop-domain');
    if (!shopDomain) {
      logger.error(
        {
          route: 'shopify_webhook',
          action: 'validate_headers',
          endpoint: WEBHOOK_ENDPOINT,
          error_message: 'Missing shop domain header',
        },
        'Shopify webhook missing shop domain',
      );
      return NextResponse.json({ error: 'Missing shop domain' }, { status: 400 });
    }

    const normalizedShop = normalizeShopDomain(shopDomain);
    const webhookTopic = request.headers.get('x-shopify-topic');

    // 3. Find tenant via shop domain
    const client = getSupabaseServiceClient();
    const { data: connection, error: connectionError } = await client
      .from('connections')
      .select('tenant_id, status, meta, access_token_enc')
      .eq('source', 'shopify')
      .eq('status', 'connected')
      .eq('meta->>store_domain', normalizedShop)
      .maybeSingle();

    if (connectionError) {
      logger.error(
        {
          route: 'shopify_webhook',
          action: 'lookup_connection',
          endpoint: WEBHOOK_ENDPOINT,
          shopDomain: normalizedShop,
          error_message: connectionError.message,
        },
        'Shopify webhook failed to lookup connection',
      );
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    if (!connection) {
      logger.warn(
        {
          route: 'shopify_webhook',
          action: 'connection_not_found',
          endpoint: WEBHOOK_ENDPOINT,
          shopDomain: normalizedShop,
          webhookTopic,
        },
        'Shopify webhook received for unknown shop',
      );
      // Return 200 so Shopify doesn't retry
      return NextResponse.json({ message: 'Shop not found' }, { status: 200 });
    }

    const tenantId = connection.tenant_id as string;

    // 4. Process webhook based on topic
    try {
      const webhookData = JSON.parse(body);

      if (webhookTopic === 'orders/create' || webhookTopic === 'orders/updated') {
        const order = webhookData as ShopifyOrder;

        await processWebhookOrder(client, tenantId, order, normalizedShop);

        logger.info(
          {
            route: 'shopify_webhook',
            action: 'process_order',
            endpoint: WEBHOOK_ENDPOINT,
            tenantId,
            shopDomain: normalizedShop,
            orderId: order.id,
            webhookTopic,
          },
          'Shopify webhook order processed successfully',
        );
      } else {
        logger.info(
          {
            route: 'shopify_webhook',
            action: 'ignored_topic',
            endpoint: WEBHOOK_ENDPOINT,
            tenantId,
            shopDomain: normalizedShop,
            webhookTopic,
          },
          `Shopify webhook received for unhandled topic: ${webhookTopic}`,
        );
      }

      return NextResponse.json({ status: 'ok' }, { status: 200 });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          route: 'shopify_webhook',
          action: 'process_webhook',
          endpoint: WEBHOOK_ENDPOINT,
          tenantId,
          shopDomain: normalizedShop,
          webhookTopic,
          error_message: errorMessage,
        },
        'Shopify webhook processing failed',
      );

      // Return 200 for now to prevent Shopify retries on processing errors
      // TODO: Implement proper retry logic with dead letter queue
      return NextResponse.json({ error: 'Processing failed' }, { status: 200 });
    }
  }, requestId);
}

