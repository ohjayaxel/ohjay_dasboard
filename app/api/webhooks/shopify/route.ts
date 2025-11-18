import { NextRequest, NextResponse } from 'next/server';

import { verifyShopifyWebhook } from '@/lib/integrations/shopify';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { logger, withRequestContext } from '@/lib/logger';
import { decryptSecret } from '@/lib/integrations/crypto';

const WEBHOOK_ENDPOINT = '/api/webhooks/shopify';

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
  refunds?: Array<unknown>;
  email?: string;
  financial_status?: string;
  fulfillment_status?: string;
};

function normalizeShopDomain(domain: string): string {
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function mapShopifyOrderToRow(tenantId: string, order: ShopifyOrder) {
  const processedAt = order.processed_at
    ? new Date(order.processed_at).toISOString().slice(0, 10)
    : null;

  const isRefund = Array.isArray(order.refunds) && order.refunds.length > 0;

  const totalPrice = parseFloat(order.total_price || '0');
  const subtotalPrice = parseFloat(order.subtotal_price || '0');
  const discountTotal = totalPrice - subtotalPrice;

  return {
    tenant_id: tenantId,
    order_id: order.id.toString(),
    processed_at: processedAt,
    total_price: totalPrice || null,
    discount_total: discountTotal || null,
    currency: order.currency || null,
    customer_id: order.customer?.id?.toString() || null,
    is_refund: isRefund,
  };
}

function aggregateKpis(rows: ReturnType<typeof mapShopifyOrderToRow>[]) {
  const byDate = new Map<string, { revenue: number; conversions: number }>();

  for (const row of rows) {
    if (!row.processed_at) continue;
    const existing = byDate.get(row.processed_at) ?? { revenue: 0, conversions: 0 };
    existing.revenue += row.total_price ?? 0;
    if (!row.is_refund) {
      existing.conversions += 1;
    } else {
      existing.revenue -= row.total_price ?? 0;
    }
    byDate.set(row.processed_at, existing);
  }

  return Array.from(byDate.entries()).map(([date, values]) => {
    const aov = values.conversions > 0 ? values.revenue / values.conversions : null;
    return {
      date,
      spend: 0,
      clicks: null,
      conversions: values.conversions || null,
      revenue: values.revenue || null,
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
) {
  const orderRow = mapShopifyOrderToRow(tenantId, order);

  // Upsert order
  const { error: upsertError } = await client.from('shopify_orders').upsert(orderRow, {
    onConflict: 'tenant_id,order_id',
  });

  if (upsertError) {
    throw new Error(`Failed to upsert order: ${upsertError.message}`);
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
    const allOrderRows = (allOrdersForDate || []).map((o) => ({
      processed_at: o.processed_at,
      total_price: o.total_price,
      is_refund: o.is_refund,
    }));

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

        await processWebhookOrder(client, tenantId, order);

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

