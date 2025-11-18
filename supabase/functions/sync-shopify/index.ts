// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type SupabaseClient = ReturnType<typeof createClient<any, any, any>>;

const SOURCE = 'shopify';

function getEnvVar(key: string) {
  const value = Deno.env.get(key);
  if (!value) {
    throw new Error(`Missing ${key} environment variable.`);
  }
  return value;
}

function createSupabaseClient(): SupabaseClient {
  // Try secrets first, then fall back to automatic Supabase environment variables
  const url = Deno.env.get('SUPABASE_URL') || 
              Deno.env.get('SUPABASE_PROJECT_URL') || 
              getEnvVar('SUPABASE_URL');
  
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || 
                      Deno.env.get('SUPABASE_ANON_KEY') || 
                      getEnvVar('SUPABASE_SERVICE_ROLE_KEY');

  return createClient(url, serviceRole, {
    auth: { persistSession: false },
  });
}

type BufferJson = {
  type: 'Buffer'
  data: number[]
}

type ShopifyConnection = {
  id: string
  tenant_id: string;
  access_token_enc: Uint8Array | string | null;
  meta: Record<string, any> | null;
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
};

type JobResult = {
  tenantId: string;
  status: 'succeeded' | 'failed';
  error?: string;
  inserted?: number;
};

// Note: calculateShopifyLikeSales is not available in Edge Functions due to import restrictions
// We'll implement the calculation inline here

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
  id: number;
  order_number: number;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
  total_price: string;
  subtotal_price: string;
  total_discounts: string;
  total_tax: string;
  currency: string;
  customer: { id: number } | null;
  line_items: Array<{
    id: number | string;
    price: string; // Price per unit (before discount), as string
    quantity: number;
    total_discount: string; // Discount on this line item, as string
  }>;
  email: string | null;
  financial_status: string;
  fulfillment_status: string | null;
  source_name?: string; // e.g., "web", "pos", "shopify_draft_order"
  refunds?: Array<ShopifyRefund>;
  cancelled_at?: string | null;
  tags?: string; // Comma-separated tags, may include "test"
  test?: boolean; // Indicates if this is a test order
};

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function parseEncryptionKey(): Uint8Array {
  const rawKey = getEnvVar('ENCRYPTION_KEY');

  // Try hex
  if (/^[0-9a-fA-F]+$/.test(rawKey) && rawKey.length === KEY_LENGTH * 2) {
    return new Uint8Array(
      rawKey.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
    );
  }

  // Try base64
  try {
    const decoded = Uint8Array.from(atob(rawKey), (c) => c.charCodeAt(0));
    if (decoded.length === KEY_LENGTH) {
      return decoded;
    }
  } catch {
    // Fall through
  }

  // Try UTF-8 (should be exact length)
  const utf8 = new TextEncoder().encode(rawKey);
  if (utf8.length === KEY_LENGTH) {
    return utf8;
  }

  throw new Error(`ENCRYPTION_KEY must be ${KEY_LENGTH} bytes after decoding.`);
}

function hexToUint8Array(hex: string): Uint8Array {
  const matches = hex.match(/.{1,2}/g) ?? [];
  const bytes = matches.map((byte) => parseInt(byte, 16));
  return new Uint8Array(bytes);
}

function decodeBufferJsonString(value: string): Uint8Array | null {
  try {
    const parsed = JSON.parse(value) as BufferJson | null;
    if (parsed?.type === 'Buffer' && Array.isArray(parsed.data)) {
      return new Uint8Array(parsed.data);
    }
  } catch {
    // ignore
  }
  return null;
}

function coercePayloadToUint8Array(payload: Uint8Array | string | BufferJson | null): Uint8Array | null {
  if (!payload) {
    return null;
  }

  if (payload instanceof Uint8Array) {
    return payload;
  }

  if (typeof payload === 'object' && payload.type === 'Buffer' && Array.isArray(payload.data)) {
    return new Uint8Array(payload.data);
  }

  if (typeof payload === 'string') {
    if (payload.startsWith('\\x')) {
      const hexPayload = payload.slice(2);
      const hexBuffer = hexToUint8Array(hexPayload);
      const asString = new TextDecoder().decode(hexBuffer);
      if (asString.startsWith('{') && asString.includes('"type":"Buffer"')) {
        const parsed = decodeBufferJsonString(asString);
        if (parsed) {
          return parsed;
        }
      }
      return hexBuffer;
    }

    if (payload.startsWith('{') && payload.includes('"type":"Buffer"')) {
      const parsed = decodeBufferJsonString(payload);
      if (parsed) {
        return parsed;
      }
    }

    try {
      return Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
  }

  return null;
}

async function decryptSecret(payload: Uint8Array | string | BufferJson | null): Promise<string | null> {
  const key = parseEncryptionKey();
  const buffer = coercePayloadToUint8Array(payload);

  if (!buffer || buffer.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Encrypted payload too short to contain IV and auth tag.');
  }

  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const encryptedWithTag = new Uint8Array(encrypted.length + authTag.length);
  encryptedWithTag.set(encrypted, 0);
  encryptedWithTag.set(authTag, encrypted.length);

  try {
    const keyBuffer = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);

    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        tagLength: AUTH_TAG_LENGTH * 8,
      },
      keyBuffer,
      encryptedWithTag,
    );

    return new TextDecoder().decode(decrypted);
  } catch (error) {
    console.error('[sync-shopify] Failed to decrypt access token', {
      payloadType: typeof payload,
      bufferLength: buffer.length,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new Error('Decryption failed');
  }
}

async function fetchShopifyOrders(params: {
  shopDomain: string;
  accessToken: string;
  since?: string;
}): Promise<ShopifyOrder[]> {
  const url = new URL(`https://${params.shopDomain}/admin/api/2023-10/orders.json`);
  url.searchParams.set('status', 'any');
  url.searchParams.set('limit', '250');
  if (params.since) {
    url.searchParams.set('created_at_min', params.since);
  }

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
  return (body.orders ?? []) as ShopifyOrder[];
}

function normalizeShopDomain(domain: string): string {
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

/**
 * Shopify-like sales calculation (mirrors lib/shopify/sales.ts logic)
 * Edge Functions can't import from lib/, so we duplicate the logic here
 */
function calculateShopifyLikeSalesInline(order: ShopifyOrder): {
  grossSales: number;
  discounts: number;
  returns: number;
  netSales: number;
} {
  // Valid financial statuses (same as lib/shopify/sales.ts)
  const VALID_FINANCIAL_STATUSES = new Set([
    'paid',
    'partially_paid',
    'partially_refunded',
    'refunded',
  ]);

  // Filter by financial status
  if (!VALID_FINANCIAL_STATUSES.has(order.financial_status)) {
    // Return zeros for invalid status
    return { grossSales: 0, discounts: 0, returns: 0, netSales: 0 };
  }

  // Calculate Discounts: prefer order.total_discounts if available (includes both line-item and order-level discounts)
  // Otherwise, fallback to summing line_items[].total_discount
  let discounts = 0;
  if (order.total_discounts !== undefined && order.total_discounts !== null) {
    discounts = parseFloat(order.total_discounts || '0');
  } else {
    // Fallback: sum line-item discounts
    for (const lineItem of order.line_items || []) {
      discounts += parseFloat(lineItem.total_discount || '0');
    }
  }
  discounts = Math.round(discounts * 100) / 100;

  // Calculate Returns: sum of refund_line_items values
  let returns = 0;
  if (order.refunds && order.refunds.length > 0) {
    for (const refund of order.refunds) {
      for (const refundLineItem of refund.refund_line_items || []) {
        let subtotal = 0;
        
        // If subtotal is provided, use it
        if (refundLineItem.subtotal) {
          subtotal = parseFloat(refundLineItem.subtotal);
        } else if (refundLineItem.line_item?.price) {
          // Use line_item.price × quantity
          subtotal = parseFloat(refundLineItem.line_item.price) * refundLineItem.quantity;
        } else {
          // Fallback: find original line item
          const originalLineItem = (order.line_items || []).find(
            (item) => item.id.toString() === refundLineItem.line_item_id.toString(),
          );
          if (originalLineItem) {
            subtotal = parseFloat(originalLineItem.price) * refundLineItem.quantity;
          }
        }
        
        returns += subtotal;
      }
    }
  }
  returns = Math.round(returns * 100) / 100;

  // Shopify Gross Sales calculation:
  // Gross Sales = SUM(line_item.price × line_item.quantity)
  // This is the product price × quantity, BEFORE discounts, tax, shipping
  let grossSales = 0;
  for (const lineItem of order.line_items || []) {
    const price = parseFloat(lineItem.price || '0');
    const quantity = lineItem.quantity || 0;
    grossSales += price * quantity;
  }
  grossSales = Math.round(grossSales * 100) / 100;

  // Net Sales = Gross Sales - (discounts + returns)
  const netSales = Math.round((grossSales - discounts - returns) * 100) / 100;

  return { grossSales, discounts, returns, netSales };
}

function mapShopifyOrderToRow(tenantId: string, order: ShopifyOrder): ShopifyOrderRow {
  // Extract date from processed_at (format: "2024-01-15T10:30:00-05:00")
  const processedAt = order.processed_at
    ? new Date(order.processed_at).toISOString().slice(0, 10)
    : null;

  // Check if this is a refund by looking at refunds array
  const isRefund = Array.isArray(order.refunds) && order.refunds.length > 0;

  // Calculate prices
  const totalPrice = parseFloat(order.total_price || '0');
  const totalTax = parseFloat(order.total_tax || '0');
  const totalDiscounts = parseFloat(order.total_discounts || '0');
  const subtotalPrice = parseFloat(order.subtotal_price || '0');
  
  // Use Shopify-like sales calculation for refunds and discounts
  const sales = calculateShopifyLikeSalesInline(order);
  
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
  const hasZeroSubtotal = subtotalPrice === 0;

  const shouldExclude = isCancelled || isTestOrder || isDraftNotCompleted || hasZeroSubtotal;
  
  // Calculate Gross Sales: SUM(line_item.price × line_item.quantity)
  // This is the product price × quantity, BEFORE discounts, tax, shipping
  let grossSales: number | null = null;
  let netSales: number | null = null;

  if (!shouldExclude) {
    grossSales = sales.grossSales > 0 ? sales.grossSales : null;
    netSales = grossSales !== null ? sales.netSales : null;
  }

  return {
    tenant_id: tenantId,
    order_id: order.id.toString(),
    processed_at: processedAt,
    total_price: totalPrice || null,
    total_tax: totalTax || null,
    discount_total: sales.discounts || null,
    total_refunds: sales.returns || null,
    currency: order.currency || null,
    customer_id: order.customer?.id?.toString() || null,
    financial_status: order.financial_status || null,
    fulfillment_status: order.fulfillment_status || null,
    source_name: order.source_name || null,
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

async function upsertJobLog(client: SupabaseClient, payload: {
  tenantId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  error?: string;
  startedAt: string;
  finishedAt?: string;
}) {
  const { error } = await client.from('jobs_log').insert({
    tenant_id: payload.tenantId,
    source: SOURCE,
    status: payload.status,
    started_at: payload.startedAt,
    finished_at: payload.finishedAt ?? null,
    error: payload.error ?? null,
  });

  if (error) {
    console.error(`Failed to write jobs_log for tenant ${payload.tenantId}:`, error);
  }
}

async function processTenant(client: SupabaseClient, connection: ShopifyConnection): Promise<JobResult> {
  const tenantId = connection.tenant_id;
  const startedAt = new Date().toISOString();

  await upsertJobLog(client, { tenantId, status: 'running', startedAt });

  try {
    // Get access token
    const accessToken = await decryptSecret(connection.access_token_enc);

    if (!accessToken) {
      throw new Error('No access token found for this connection.');
    }

    // Get shop domain from meta
    const shopDomain = connection.meta?.store_domain || connection.meta?.shop;
    if (!shopDomain || typeof shopDomain !== 'string') {
      throw new Error('No shop domain found in connection metadata.');
    }

    const normalizedShop = normalizeShopDomain(shopDomain);

    const syncStartDate = connection.meta?.sync_start_date;
    const backfillSince = connection.meta?.backfill_since;
    const since =
      typeof backfillSince === 'string' && backfillSince.length > 0
        ? backfillSince
        : typeof syncStartDate === 'string' && syncStartDate.length > 0
          ? syncStartDate
          : undefined;

    // Fetch orders from Shopify
    console.log(`[sync-shopify] Fetching orders for tenant ${tenantId}, shop ${normalizedShop}, since ${since || 'all time'}`);
    const shopifyOrders = await fetchShopifyOrders({
      shopDomain: normalizedShop,
      accessToken,
      since,
    });

    console.log(`[sync-shopify] Fetched ${shopifyOrders.length} orders for tenant ${tenantId}`);

    // Map to database rows
    let orderRows = shopifyOrders.map((order) => mapShopifyOrderToRow(tenantId, order));

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
      const { data: existingOrders, error: lookupError } = await client
        .from('shopify_orders')
        .select('customer_id, processed_at')
        .eq('tenant_id', tenantId)
        .in('customer_id', Array.from(customerIdsInBatch))
        .not('customer_id', 'is', null)
        .not('processed_at', 'is', null);

      if (!lookupError && existingOrders) {
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

    if (orderRows.length > 0) {
      const { error: upsertError } = await client.from('shopify_orders').upsert(orderRows, {
        onConflict: 'tenant_id,order_id',
      });

      if (upsertError) {
        throw new Error(upsertError.message);
      }

      const aggregates = aggregateKpis(orderRows);
      const kpiRows = aggregates.map((row) => ({
        tenant_id: tenantId,
        date: row.date,
        source: SOURCE,
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

      const { error: kpiError } = await client.from('kpi_daily').upsert(kpiRows, {
        onConflict: 'tenant_id,date,source',
      });

      if (kpiError) {
        throw new Error(kpiError.message);
      }
    }

    if (backfillSince) {
      const clearedMeta = {
        ...(connection.meta ?? {}),
        backfill_since: null,
      };

      const { error: clearBackfillError } = await client
        .from('connections')
        .update({
          meta: clearedMeta,
          updated_at: new Date().toISOString(),
        })
        .eq('id', connection.id);

      if (clearBackfillError) {
        console.error(
          `[sync-shopify] Failed to clear Shopify backfill flag for tenant ${tenantId}:`,
          clearBackfillError.message,
        );
      } else {
        console.log(`[sync-shopify] Cleared Shopify backfill flag for tenant ${tenantId}`);
      }
    }

    await upsertJobLog(client, {
      tenantId,
      status: 'succeeded',
      startedAt,
      finishedAt: new Date().toISOString(),
    });

    return { tenantId, status: 'succeeded', inserted: orderRows.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sync-shopify] Error processing tenant ${tenantId}:`, message);
    await upsertJobLog(client, {
      tenantId,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: message,
    });

    return { tenantId, status: 'failed', error: message };
  }
}

serve(async (request) => {
  try {
    let tenantFilter: string | null = null;
    if (request) {
      try {
        const payload = await request.json();
        if (payload && typeof payload.tenantId === 'string' && payload.tenantId.length > 0) {
          tenantFilter = payload.tenantId;
        }
      } catch {
        // ignore invalid JSON
      }
    }

    const client = createSupabaseClient();
    let query = client
      .from('connections')
      .select('id, tenant_id, access_token_enc, meta')
      .eq('source', SOURCE)
      .eq('status', 'connected');

    if (tenantFilter) {
      query = query.eq('tenant_id', tenantFilter);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to list connections: ${error.message}`);
    }

    const connections = (data as ShopifyConnection[]) ?? [];
    const results: JobResult[] = [];

    console.log(
      `[sync-shopify] Processing ${connections.length} connected Shopify tenants${
        tenantFilter ? ` (filtered to tenant ${tenantFilter})` : ''
      }`,
    );

    for (const connection of connections) {
      const result = await processTenant(client, connection);
      results.push(result);
    }

    return new Response(JSON.stringify({ source: SOURCE, results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sync-${SOURCE}] failed`, message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});

