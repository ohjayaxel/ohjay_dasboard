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
  const url = getEnvVar('SUPABASE_URL');
  const serviceRole = getEnvVar('SUPABASE_SERVICE_ROLE_KEY');

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
  created_at: string | null; // Date string (YYYY-MM-DD) for aggregations
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
  gross_sales: number | null;
  net_sales: number | null;
  is_new_customer: boolean;
  is_first_order_for_customer: boolean;
  customer_type_shopify_mode: string | null;
  customer_type_financial_mode: string | null;
  country: string | null;
  shipping_amount: number | null;
  shipping_tax: number | null;
  duties_amount: number | null;
  additional_fees_amount: number | null;
  is_test: boolean;
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
  processed_at?: string; // Preferred date if available (more accurate for analytics)

  // Line item refunds (used for refunded_subtotal)
  refund_line_items?: Array<{
    line_item_id: number | string;
    quantity: number;
    subtotal?: string;
    subtotal_set?: {
      shop_money?: { amount: string };
    };
    line_item?: {
      price: string;
    };
  }>;

  // Underlying payment transactions associated with this refund.
  // These map closely to /admin/api/*/transactions.json and are used to
  // build the transaction ledger (shopify_transactions).
  transactions?: Array<{
    id?: number | string;
    amount: string;
    kind: string;
    gateway: string | null;
    status?: string | null;
    processed_at?: string | null;
    created_at?: string | null;
    currency?: string | null;
    test?: boolean | null;
  }>;
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
    tax?: string; // Total tax for this line item (sum of taxLines), as string
  }>;
  email: string | null;
  financial_status: string;
  fulfillment_status: string | null;
  source_name?: string; // e.g., "web", "pos", "shopify_draft_order"
  refunds?: Array<ShopifyRefund>;
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
  total_shipping_price_set?: {
    shop_money?: { amount: string };
  };
  total_duties_set?: {
    shop_money?: { amount: string };
  };
};

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// Retry logic constants
const RETRIABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]); // Request Timeout, Conflict, Too Early, Too Many Requests, Internal Server Error, Bad Gateway, Service Unavailable, Gateway Timeout
const BASE_DELAY_MS = 500; // Base delay for exponential backoff (500ms)
const MAX_ATTEMPTS = 6; // Maximum retry attempts

function parseEncryptionKey(): Uint8Array {
  const rawKey = getEnvVar('ENCRYPTION_KEY').trim();

  // Try hex (64 characters for 32 bytes)
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

  throw new Error(
    `ENCRYPTION_KEY must be ${KEY_LENGTH} bytes after decoding. ` +
    `Got ${rawKey.length} characters. ` +
    `Expected: ${KEY_LENGTH * 2} hex chars, ${Math.ceil(KEY_LENGTH * 4 / 3)} base64 chars, or ${KEY_LENGTH} UTF-8 bytes.`
  );
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

/**
 * Fetch with retry logic for Shopify API calls
 * Implements exponential backoff for retriable errors
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempt = 1,
): Promise<Response> {
  try {
    const response = await fetch(url, init);

    if (response.ok) {
      return response;
    }

    // Check if status is retriable and we haven't exceeded max attempts
    if (RETRIABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
      // Calculate exponential backoff delay: BASE_DELAY_MS * 2^(attempt-1)
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      
      // Handle rate limiting (429 Too Many Requests) - Shopify uses this
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : delayMs;
        console.log(
          `[sync-shopify] Rate limited (429) on attempt ${attempt}/${MAX_ATTEMPTS}. ` +
          `Waiting ${waitTime}ms before retry...`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      } else {
        console.log(
          `[sync-shopify] Request failed with retriable status ${response.status} (attempt ${attempt}/${MAX_ATTEMPTS}). ` +
          `Retrying after ${delayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      return fetchWithRetry(url, init, attempt + 1);
    }

    // Non-retriable error or max attempts reached
    if (attempt >= MAX_ATTEMPTS) {
      const body = await response.text();
      throw new Error(
        `Shopify API request failed after ${MAX_ATTEMPTS} attempts: ${response.status} ${body}`,
      );
    }

    return response;
  } catch (error) {
    // Network errors or exceptions - retry if we haven't exceeded max attempts
    if (attempt >= MAX_ATTEMPTS) {
      throw error;
    }

    const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
    console.log(
      `[sync-shopify] Request exception on attempt ${attempt}/${MAX_ATTEMPTS}. Retrying after ${delayMs}ms...`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fetchWithRetry(url, init, attempt + 1);
  }
}

/**
 * Fetch orders from Shopify using GraphQL API with processed_at filter
 * This matches the backfill script's approach for consistency
 */
async function fetchShopifyOrdersGraphQL(params: {
  shopDomain: string;
  accessToken: string;
  since?: string;
  until?: string;
  filterBy?: 'created_at' | 'processed_at';
  excludeTest?: boolean;
}): Promise<ShopifyOrder[]> {
  const normalizedShop = normalizeShopDomain(params.shopDomain);
  const allOrders: ShopifyOrder[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  const filterBy = params.filterBy || 'processed_at';
  const excludeTest = params.excludeTest !== false;

  // Build query string for date filtering
  const queryParts: string[] = [];
  if (params.since) {
    if (filterBy === 'processed_at') {
      queryParts.push(`processed_at:>='${params.since}'`);
    } else {
      queryParts.push(`created_at:>='${params.since}'`);
    }
  }
  if (params.until) {
    if (filterBy === 'processed_at') {
      queryParts.push(`processed_at:<='${params.until}T23:59:59'`);
    } else {
      queryParts.push(`created_at:<='${params.until}T23:59:59'`);
    }
  }
  // Don't filter test orders at fetch time - filtering happens in database/frontend
  // if (excludeTest) {
  //   queryParts.push(`-test:true`);
  // }
  const queryString = queryParts.length > 0 ? queryParts.join(' AND ') : undefined;

  const ORDERS_QUERY = `
    query GetOrders($first: Int!, $after: String, $query: String) {
      orders(first: $first, after: $after, query: $query) {
        edges {
          node {
            id
            name
            legacyResourceId
            createdAt
            processedAt
            updatedAt
            cancelledAt
            test
            currencyCode
            customer {
              id
              email
              numberOfOrders
            }
            billingAddress {
              countryCode
              country
            }
            shippingAddress {
              countryCode
              country
            }
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            subtotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            totalDiscountsSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            totalTaxSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            totalShippingPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            totalDutiesSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            lineItems(first: 250) {
              edges {
                node {
                  id
                  sku
                  name
                  quantity
                  taxLines {
                    priceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                  }
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  discountedUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  discountAllocations {
                    allocatedAmountSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
              }
            }
            transactions(first: 250) {
              id
              kind
              status
              processedAt
              gateway
              amountSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
            refunds(first: 250) {
              id
              createdAt
              refundLineItems(first: 250) {
                edges {
                  node {
                    quantity
                    lineItem {
                      id
                      originalUnitPriceSet {
                        shopMoney {
                          amount
                          currencyCode
                        }
                      }
                    }
                    subtotalSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  let page = 1;
  const MAX_PAGES = 500; // Safety limit

  while (hasNextPage && page <= MAX_PAGES) {
    const variables: any = {
      first: 100,
      query: queryString,
    };
    if (cursor) {
      variables.after = cursor;
    }

    const response = await fetchWithRetry(`https://${normalizedShop}/admin/api/2023-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': params.accessToken,
      },
      body: JSON.stringify({
        query: ORDERS_QUERY,
        variables,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Shopify GraphQL fetch failed: ${response.status} ${body}`);
    }

    const result = await response.json();
    if (result.errors) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    const orders = result.data?.orders?.edges || [];
    if (orders.length === 0) {
      break;
    }

    // Convert GraphQL orders to REST format
    for (const edge of orders) {
      const gqlOrder = edge.node;
      
      // Extract customer ID from GID
      let customerId: number | null = null;
      if (gqlOrder.customer?.id) {
        const gidMatch = gqlOrder.customer.id.match(/\/(\d+)$/);
        if (gidMatch) {
          customerId = parseInt(gidMatch[1]);
        }
      }

      // Prefer order-level totalDiscountsSet when available; fallback to summing line-item discount allocations.
      let totalDiscounts = 0;
      const orderLevelDiscount = gqlOrder.totalDiscountsSet?.shopMoney?.amount;
      if (orderLevelDiscount !== null && orderLevelDiscount !== undefined && orderLevelDiscount !== '') {
        const n = parseFloat(orderLevelDiscount);
        totalDiscounts = Number.isFinite(n) ? n : 0;
      } else {
        for (const lineItemEdge of gqlOrder.lineItems.edges || []) {
          const item = lineItemEdge.node;
          for (const allocation of item.discountAllocations || []) {
            totalDiscounts += parseFloat(allocation.allocatedAmountSet.shopMoney.amount || '0');
          }
        }
      }

      // Infer financial_status from transactions (same logic as backfill script)
      // CRITICAL: Default to 'paid' if order has line items but no transactions
      // This ensures orders are not filtered out by calculateShopifyLikeSales
      // This matches Shopify Analytics behavior where orders typically have financial_status='paid'
      let financialStatus = 'pending';
      if (gqlOrder.cancelledAt) {
        financialStatus = 'voided';
      } else if (gqlOrder.transactions && gqlOrder.transactions.length > 0) {
        const successfulSales = gqlOrder.transactions.filter(
          (txn: any) => (txn.kind === 'SALE' || txn.kind === 'CAPTURE') && txn.status === 'SUCCESS'
        );
        const refunds = gqlOrder.transactions.filter(
          (txn: any) => txn.kind === 'REFUND' && txn.status === 'SUCCESS'
        );
        
        if (refunds.length > 0 && successfulSales.length > 0) {
          financialStatus = 'partially_refunded';
        } else if (successfulSales.length > 0) {
          financialStatus = 'paid';
        } else {
          // No successful sales transactions - but if we have line items, assume 'paid'
          // (transactions might be missing from GraphQL but order is actually paid)
          const hasLineItems = gqlOrder.lineItems?.edges?.length > 0;
          financialStatus = hasLineItems ? 'paid' : 'pending';
        }
      } else {
        // No transactions available - default to 'paid' if order has line items
        // This ensures orders are included in calculations (matches Shopify Analytics behavior)
        const hasLineItems = gqlOrder.lineItems?.edges?.length > 0;
        financialStatus = hasLineItems ? 'paid' : 'pending';
      }

      // Convert line items
      const lineItems = (gqlOrder.lineItems.edges || []).map((lineItemEdge: any) => {
        const item = lineItemEdge.node;
        let lineItemId: number | null = null;
        const gidMatch = item.id.match(/\/(\d+)$/);
        if (gidMatch) {
          lineItemId = parseInt(gidMatch[1]);
        }

        let itemTotalDiscount = 0;
        for (const allocation of item.discountAllocations || []) {
          itemTotalDiscount += parseFloat(allocation.allocatedAmountSet.shopMoney.amount || '0');
        }

        let itemTaxTotal = 0;
        for (const tl of item.taxLines || []) {
          const amt = tl?.priceSet?.shopMoney?.amount;
          if (amt !== null && amt !== undefined && amt !== '') {
            const n = parseFloat(amt);
            if (Number.isFinite(n)) itemTaxTotal += n;
          }
        }

        return {
          id: lineItemId || 0,
          sku: item.sku || null,
          name: item.name,
          quantity: item.quantity,
          price: item.originalUnitPriceSet.shopMoney.amount,
          total_discount: itemTotalDiscount.toFixed(2),
          tax: itemTaxTotal.toFixed(2),
        };
      });

      // Convert refunds
      const refunds: ShopifyRefund[] = (gqlOrder.refunds || []).map((refund: any) => ({
        id: parseInt(refund.id.match(/\/(\d+)$/)?.[1] || '0'),
        created_at: refund.createdAt,
        refund_line_items: (refund.refundLineItems?.edges || []).map((refundEdge: any) => {
          const refundNode = refundEdge.node;
          return {
            line_item_id: refundNode.lineItem?.id || null,
            quantity: refundNode.quantity,
            subtotal: refundNode.subtotalSet?.shopMoney?.amount,
            line_item: refundNode.lineItem ? {
              price: refundNode.lineItem.originalUnitPriceSet.shopMoney.amount,
            } : undefined,
          };
        }),
      }));

      const restOrder: ShopifyOrder = {
        id: parseInt(gqlOrder.legacyResourceId || gqlOrder.id),
        order_number: parseInt(gqlOrder.name.replace('#', '')),
        processed_at: gqlOrder.processedAt || null,
        created_at: gqlOrder.createdAt,
        updated_at: gqlOrder.updatedAt || null,
        cancelled_at: gqlOrder.cancelledAt || null,
        total_price: gqlOrder.totalPriceSet?.shopMoney?.amount || '0',
        subtotal_price: gqlOrder.subtotalPriceSet?.shopMoney?.amount || '0',
        total_discounts: totalDiscounts.toFixed(2),
        total_tax: gqlOrder.totalTaxSet?.shopMoney?.amount || '0',
        currency: gqlOrder.currencyCode,
        test: gqlOrder.test,
        customer: gqlOrder.customer && customerId ? {
          id: customerId,
          email: gqlOrder.customer.email || null,
          first_name: null,
          last_name: null,
        } : null,
        line_items: lineItems,
        refunds,
        financial_status: financialStatus,
        billing_address: gqlOrder.billingAddress ? {
          country_code: gqlOrder.billingAddress.countryCode || null,
          country: gqlOrder.billingAddress.country || null,
        } : undefined,
        shipping_address: gqlOrder.shippingAddress ? {
          country_code: gqlOrder.shippingAddress.countryCode || null,
          country: gqlOrder.shippingAddress.country || null,
        } : undefined,
        total_shipping_price_set: gqlOrder.totalShippingPriceSet ? {
          shop_money: {
            amount: gqlOrder.totalShippingPriceSet.shopMoney.amount,
            currency_code: gqlOrder.totalShippingPriceSet.shopMoney.currencyCode,
          },
        } : undefined,
        total_duties_set: gqlOrder.totalDutiesSet ? {
          shop_money: {
            amount: gqlOrder.totalDutiesSet.shopMoney.amount,
            currency_code: gqlOrder.totalDutiesSet.shopMoney.currencyCode,
          },
        } : undefined,
      };

      allOrders.push(restOrder);
    }

    const pageInfo = result.data?.orders?.pageInfo;
    hasNextPage = pageInfo?.hasNextPage || false;
    cursor = pageInfo?.endCursor || null;
    
    console.log(`[sync-shopify] Fetched ${orders.length} orders via GraphQL (total: ${allOrders.length}, page ${page})`);
    
    page++;
    
    // Small delay between pages
    if (hasNextPage) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  if (page > MAX_PAGES) {
    console.warn(`[sync-shopify] Reached maximum page limit (${MAX_PAGES}), stopping pagination`);
  }

  console.log(`[sync-shopify] Total orders fetched via GraphQL: ${allOrders.length} across ${page - 1} page(s)`);
  
  return allOrders;
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
 * 
 * CALCULATION METHOD (matching Shopify Analytics):
 * - Gross Sales = SUM(line_item.price × quantity) EXCL tax
 * - Discounts = SUM(line_item.total_discount)
 * - Returns = SUM(refund_line_items.subtotal) EXCL tax
 * - Net Sales EXCL tax = gross_sales - discounts - returns
 * - Uses Shopify's own fields as source of truth
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

  // Prices from GraphQL:
  // - originalUnitPriceSet: typically INCL tax (for our tenant, confirmed via Shopify Analytics matching)
  // - total_discount: discount allocations, treated as INCL tax
  let grossSalesInclTax = 0;
  for (const lineItem of order.line_items || []) {
    const price = parseFloat(lineItem.price || '0');
    const quantity = lineItem.quantity || 0;
    grossSalesInclTax += price * quantity;
  }
  grossSalesInclTax = Math.round(grossSalesInclTax * 100) / 100;

  // Discounts INCL tax (order-level preferred, else sum line-level)
  let discountsInclTax = 0;
  if (order.total_discounts !== undefined && order.total_discounts !== null) {
    discountsInclTax = parseFloat(order.total_discounts || '0');
  } else {
    for (const lineItem of order.line_items || []) {
      discountsInclTax += parseFloat(lineItem.total_discount || '0');
    }
  }
  discountsInclTax = Math.round(discountsInclTax * 100) / 100;

  // NEW METHOD: Calculate Net Sales EXCL tax using Shopify's fields
  // subtotal_price = ordersumma efter rabatter, INKL moms
  // total_tax = total moms på ordern
  const subtotalPrice = order.subtotal_price
    ? parseFloat(order.subtotal_price)
    : 0;
  
  const totalTax = (() => {
    if (order.total_tax === null || order.total_tax === undefined || order.total_tax === '') {
      return 0;
    }
    const tax = parseFloat(order.total_tax);
    return Number.isFinite(tax) ? tax : 0;
  })();
  
  // Net Sales EXCL tax BEFORE refunds
  // = subtotalPrice - totalTax
  const netSalesExclTaxBeforeRefunds = Math.round((subtotalPrice - totalTax) * 100) / 100;

  const subtotalExclTax = subtotalPrice - totalTax;
  const taxRate =
    subtotalPrice > 0 && totalTax > 0 && subtotalExclTax > 0
      ? totalTax / subtotalExclTax
      : 0;

  // Mixed tax rates: compute line-level EXCL conversions (fallback to order-level taxRate)
  let grossSalesExclTaxFromLines = 0;
  let discountsExclTaxFromLines = 0;
  for (const lineItem of order.line_items || []) {
    const priceIncl = parseFloat(lineItem.price || '0') || 0;
    const qty = lineItem.quantity || 0;
    const discountIncl = parseFloat(lineItem.total_discount || '0') || 0;
    const taxTotal = parseFloat(lineItem.tax || '0') || 0;

    const lineTotalIncl = priceIncl * qty;
    const lineNetIncl = Math.max(0, lineTotalIncl - discountIncl);

    let lineTaxRate = taxRate;
    if (taxTotal > 0 && lineNetIncl > taxTotal) {
      lineTaxRate = taxTotal / (lineNetIncl - taxTotal);
    }

    const lineGrossEx =
      lineTaxRate > 0 ? lineTotalIncl / (1 + lineTaxRate) : lineTotalIncl;
    const lineDiscountEx =
      lineTaxRate > 0 ? discountIncl / (1 + lineTaxRate) : discountIncl;

    grossSalesExclTaxFromLines += lineGrossEx;
    discountsExclTaxFromLines += lineDiscountEx;

    // 100% discount special: Shopify Analytics includes the tax component in both gross & discounts
    if (
      discountIncl > 0 &&
      Math.abs(lineTotalIncl - discountIncl) < 0.01 &&
      lineTaxRate > 0
    ) {
      const extraTax = ((priceIncl * lineTaxRate) / (1 + lineTaxRate)) * qty;
      grossSalesExclTaxFromLines += extraTax;
      discountsExclTaxFromLines += extraTax;
    }
  }
  grossSalesExclTaxFromLines = Math.round(grossSalesExclTaxFromLines * 100) / 100;
  discountsExclTaxFromLines = Math.round(discountsExclTaxFromLines * 100) / 100;

  // Gross Sales strategy (mirrors lib/shopify/sales.ts)
  let grossSales = 0;
  if (totalTax === 0) {
    if (grossSalesInclTax > 0) {
      grossSales = grossSalesInclTax;
    }
  } else if (taxRate > 0 && grossSalesInclTax > 0) {
    const taxRateDeviationFrom25 = Math.abs(taxRate - 0.25);
    const USE_SUBTOTAL_PRICE_THRESHOLD = 0.001;

    let totalDiscountsAmount = 0;
    for (const li of order.line_items || []) {
      totalDiscountsAmount += parseFloat(li.total_discount || '0');
    }
    const orderHasDiscounts = totalDiscountsAmount > 0.01 || discountsInclTax > 0.01;

    const subtotalPriceTimesOnePlusTaxRate = subtotalPrice * (1 + taxRate);
    const diffBetweenSubtotalAndSum = Math.abs(subtotalPriceTimesOnePlusTaxRate - grossSalesInclTax);
    const SUBTOTAL_MATCHES_SUM_THRESHOLD = 1.0;

    if (
      taxRateDeviationFrom25 > USE_SUBTOTAL_PRICE_THRESHOLD &&
      subtotalPrice > 0 &&
      orderHasDiscounts &&
      diffBetweenSubtotalAndSum < SUBTOTAL_MATCHES_SUM_THRESHOLD
    ) {
      // Special case discovered empirically: Shopify Analytics uses subtotal_price directly
      grossSales = subtotalPrice;
    } else {
      grossSales = grossSalesExclTaxFromLines;
    }
  } else if (subtotalExclTax > 0) {
    grossSales = subtotalExclTax;
  } else if (grossSalesInclTax > 0) {
    grossSales = grossSalesInclTax;
  }
  grossSales = Math.round(grossSales * 100) / 100;

  // Discounts EXCL tax (prefer line-level conversion to handle mixed rates)
  let discounts = discountsExclTaxFromLines;
  discounts = Math.round(discounts * 100) / 100;

  // Calculate Returns EXCL tax: use refund_line_items[].subtotal if available
  // subtotal field contains refund amount EXCL tax
  let returns = 0;
  if (order.refunds && order.refunds.length > 0) {
    for (const refund of order.refunds) {
      for (const refundLineItem of refund.refund_line_items || []) {
        // Prefer subtotal field (EXCL tax), otherwise calculate from price
        if (refundLineItem.subtotal) {
          returns += parseFloat(refundLineItem.subtotal);
        } else if (refundLineItem.line_item?.price) {
          // Use line_item.price × quantity
          returns += parseFloat(refundLineItem.line_item.price) * refundLineItem.quantity;
        } else {
          // Fallback: find original line item
          const originalLineItem = (order.line_items || []).find(
            (item) => item.id.toString() === refundLineItem.line_item_id.toString(),
          );
          if (originalLineItem) {
            returns += parseFloat(originalLineItem.price) * refundLineItem.quantity;
          }
        }
      }
    }
  }
  returns = Math.round(returns * 100) / 100;

  // Net Sales EXCL tax = gross_sales - discounts - returns (Shopify Analytics definition)
  const netSales = Math.round((grossSales - discounts - returns) * 100) / 100;

  return { grossSales, discounts, returns, netSales };
}

// Helper function to parse date in Stockholm timezone (not UTC)
// This matches file behavior where dates are grouped by local date, not UTC date
function parseDateInStockholmTimezone(dateStr: string | null): string | null {
  if (!dateStr) return null;
  try {
    // Parse date and convert to Stockholm timezone
    const date = new Date(dateStr);
    // Use toLocaleDateString with Stockholm timezone to get correct date
    // 'en-CA' format gives us YYYY-MM-DD
    return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' });
  } catch {
    return null;
  }
}

function mapShopifyOrderToRow(tenantId: string, order: ShopifyOrder): ShopifyOrderRow {
  // Extract date from processed_at using Stockholm timezone (matches file behavior)
  // For sync: Use processed_at as-is, but with correct timezone parsing
  // Priority logic for date assignment (created_at vs processed_at vs refund.created_at)
  // will be handled in backfill script, but for real-time syncs we use processed_at
  const processedAtRaw = order.processed_at
    ? parseDateInStockholmTimezone(order.processed_at)
    : null;
  
  // For sync operations, determine the correct processed_at based on the same logic as backfill:
  // 1. If order has refunds created today, use refund.created_at
  // 2. If created_at is today, use created_at (file behavior)
  // 3. Otherwise, use processed_at
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

  // Check if this is a refund by looking at refunds array
  const isRefund = Array.isArray(order.refunds) && order.refunds.length > 0;

  // Calculate prices
  const totalPrice = parseFloat(order.total_price || '0');
  const totalTax = parseFloat(order.total_tax || '0');
  const totalDiscounts = parseFloat(order.total_discounts || '0');
  const subtotalPrice = parseFloat(order.subtotal_price || '0');
  
  // Don't filter when saving to database - save ALL orders
  // Filtering happens in aggregation (shopify_daily_sales, etc) based on gross_sales > 0
  // Mark test orders but still calculate and save their sales values
  const isTestOrder = order.test === true || (order.tags?.toLowerCase().includes('test') ?? false);
  
  // Calculate sales for ALL orders (no filtering at save time)
  // This calculates:
  // - Gross Sales = SUM(line_item.price × quantity) EXCL tax
  // - Discounts = SUM(line_item.total_discount)
  // - Returns = SUM(refund_line_items.subtotal) EXCL tax
  // - Net Sales EXCL tax = gross_sales - discounts - returns
  const sales = totalPrice > 0 && order.line_items && order.line_items.length > 0
    ? calculateShopifyLikeSalesInline(order)
    : { grossSales: 0, discounts: 0, returns: 0, netSales: 0 };

  // Use the correctly calculated values from calculateShopifyLikeSalesInline
  // Gross Sales = SUM of (line_item.price × quantity) for all line items EXCL tax
  // Definition: Ungefärliga försäljningsintäkter, innan rabatter och returer räknas in över tid, exklusive skatt
  // Save gross_sales for ALL orders (filtering happens in aggregation)
  const grossSales = sales.grossSales > 0 ? sales.grossSales : null;
  
  // Tax = skatt på Gross Sales
  // Calculate approximate tax on gross_sales using tax rate from subtotal
  // tax_rate = total_tax / (subtotal_price - total_tax)
  // tax = gross_sales * tax_rate
  // Note: subtotalPrice and totalTax are already declared above
  const subtotalPriceExclTax = subtotalPrice - totalTax;
  const taxRate = subtotalPriceExclTax > 0 ? totalTax / subtotalPriceExclTax : 0;
  const tax = grossSales && grossSales > 0 
    ? Math.round((grossSales * taxRate) * 100) / 100
    : null;
  
  // Total Sales = Gross Sales + Tax
  // Definition: Exakt som Gross Sales men inkluderar skatt
  const totalSales = grossSales && tax !== null 
    ? Math.round((grossSales + tax) * 100) / 100
    : null;
  
  // Net Sales EXCL tax = gross_sales - discounts - returns
  // This is calculated correctly in calculateShopifyLikeSalesInline using Shopify Analytics formula
  // Save net_sales for ALL orders (filtering happens in aggregation)
  const netSales = sales.netSales !== 0 ? sales.netSales : null;

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

  // Extract shipping and duties amounts from Shopify API
  // total_shipping_price_set.shop_money.amount is shipping excluding tax
  const shippingAmount = order.total_shipping_price_set?.shop_money?.amount
    ? parseFloat(order.total_shipping_price_set.shop_money.amount)
    : null;
  
  // For shipping_tax, we'd need current_total_tax_set or similar, but Shopify API doesn't always provide this breakdown
  // Setting to null for now - can be enhanced later if needed
  const shippingTax: number | null = null;
  
  const dutiesAmount = order.total_duties_set?.shop_money?.amount
    ? parseFloat(order.total_duties_set.shop_money.amount)
    : null;
  
  // Additional fees are not directly available in Shopify Admin API
  // They may appear in some setups (marketplace fees, payment fees), but require custom handling
  const additionalFeesAmount: number | null = null;

  // Revenue (Omsättning) = net_sales + tax + shipping_amount
  // Definition: Net Sales + Tax + Fraktavgifter
  const revenue = netSales !== null && tax !== null && shippingAmount !== null
    ? Math.round((netSales + tax + shippingAmount) * 100) / 100
    : (netSales !== null && tax !== null
      ? Math.round((netSales + tax + (shippingAmount || 0)) * 100) / 100
      : null);

  // Extract full timestamp for created_at_ts (ISO string from Shopify API)
  const createdAtTimestamp = order.created_at
    ? new Date(order.created_at).toISOString()
    : null;

  return {
    tenant_id: tenantId,
    order_id: order.id.toString(),
    processed_at: processedAt,
    created_at: orderCreatedAt, // Date string (YYYY-MM-DD) for aggregations
    created_at_ts: createdAtTimestamp, // Full timestamp (ISO) for deterministic classification
    total_sales: totalSales || null, // Gross Sales + Tax (produkter före rabatter, inklusive skatt)
    tax: tax || null, // Skatt på Gross Sales
    total_tax: totalTax || null, // Total tax från Shopify API (tax på subtotal_price, dvs efter rabatter)
    discount: sales.discounts || null,
    refunds: sales.returns || null,
    currency: order.currency || null,
    customer_id: order.customer?.id?.toString() || null,
    financial_status: order.financial_status || null,
    fulfillment_status: order.fulfillment_status || null,
    source_name: order.source_name || null,
    is_refund: isRefund,
    gross_sales: grossSales, // Produkter före rabatter, exklusive skatt
    net_sales: netSales,
    revenue: revenue, // Omsättning: net_sales + tax + shipping_amount
    is_new_customer: false, // Will be determined using customer_stats
    is_first_order_for_customer: false, // Will be determined using customer_stats
    customer_type_shopify_mode: null, // Will be determined using customer_stats
    customer_type_financial_mode: null, // DEPRECATED
    country: country || null,
    shipping_amount: shippingAmount,
    shipping_tax: shippingTax,
    duties_amount: dutiesAmount,
    additional_fees_amount: additionalFeesAmount,
    is_test: isTestOrder,
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
    const netValue = row.net_sales ?? 0;
    // Gross Sales = SUM(line_item.price × quantity) for each order (BEFORE discounts, tax, shipping)
    // This is stored in row.gross_sales
    // grossSalesValue was already declared above in the filter check, reuse it
    existing.revenue += grossSalesValue;
    // total_sales should also use gross_sales (same as revenue for Shopify)
    existing.total_sales += grossSalesValue;
    existing.total_tax += row.total_tax ?? 0;
    existing.net_sales += netValue;
    
    // Count ALL orders with gross_sales > 0 as "orders" (Shopify Analytics behavior)
    // No filtering on is_refund - only gross_sales > 0 matters
    existing.conversions += 1;
    
    // Track currency frequency (use most common currency for the day)
    if (row.currency) {
      const count = existing.currencies.get(row.currency) ?? 0;
      existing.currencies.set(row.currency, count + 1);
    }
    
    // Use is_first_order_for_customer for correct classification
    // is_new_customer is kept for backward compatibility but should match is_first_order_for_customer
    if (row.is_first_order_for_customer === true) {
      existing.new_customer_conversions += 1;
      existing.new_customer_net_sales += netValue;
    } else {
      existing.returning_customer_conversions += 1;
      existing.returning_customer_net_sales += netValue;
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
    
    // Gross Sales = sum of gross_sales from shopify_orders
    // gross_sales = SUM(line_item.price × quantity) for each order (BEFORE discounts, tax, shipping)
    // revenue is now correctly set to sum of gross_sales (we fixed it above)
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
      total_tax: values.total_tax || null, // Include total_tax for shopify_daily_sales calculation
    };
  });
}

async function upsertJobLog(
  client: SupabaseClient,
  payload: {
    tenantId: string;
    status: 'pending' | 'running' | 'succeeded' | 'failed';
    error?: string;
    startedAt: string;
    finishedAt?: string;
    jobLogId?: string; // If provided, update this specific job log entry
  },
): Promise<string | null> {
  // If we have a jobLogId, update the existing entry
  if (payload.jobLogId) {
    const { error, data } = await client
      .from('jobs_log')
      .update({
        status: payload.status,
        finished_at: payload.finishedAt ?? null,
        error: payload.error ?? null,
      })
      .eq('id', payload.jobLogId)
      .select('id')
      .single();

    if (error) {
      console.error(`Failed to update jobs_log ${payload.jobLogId} for tenant ${payload.tenantId}:`, error);
      return null;
    }
    return data?.id ?? null;
  }

  // Otherwise, insert new entry (for initial 'running' status)
  const { error, data } = await client
    .from('jobs_log')
    .insert({
      tenant_id: payload.tenantId,
      source: SOURCE,
      status: payload.status,
      started_at: payload.startedAt,
      finished_at: payload.finishedAt ?? null,
      error: payload.error ?? null,
    })
    .select('id')
    .single();

  if (error) {
    console.error(`Failed to insert jobs_log for tenant ${payload.tenantId}:`, error);
    return null;
  }
  return data?.id ?? null;
}

async function processTenant(client: SupabaseClient, connection: ShopifyConnection): Promise<JobResult> {
  const tenantId = connection.tenant_id;
  const startedAt = new Date().toISOString();

  // Version stamp for operational parity verification
  const SYNC_VERSION = 'phase3-20250111';
  console.log(`[sync-shopify] SYNC_VERSION=${SYNC_VERSION} - Starting sync for tenant ${tenantId}`);

  // Insert initial 'running' job log entry and save the ID for updates
  let jobLogId: string | null = null;
  try {
    jobLogId = await upsertJobLog(client, { tenantId, status: 'running', startedAt });
  } catch (logError) {
    console.error(`Failed to insert initial job log for tenant ${tenantId}:`, logError);
    // Continue anyway - we'll try to create it later if needed
  }

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
    let since =
      typeof backfillSince === 'string' && backfillSince.length > 0
        ? backfillSince
        : typeof syncStartDate === 'string' && syncStartDate.length > 0
          ? syncStartDate
          : undefined;

    // Fetch orders from Shopify using GraphQL API with processed_at filter
    // This matches the backfill script's approach for consistency
    console.log(`[sync-shopify] Fetching orders for tenant ${tenantId}, shop ${normalizedShop}, since ${since || 'all time'}`);
    
    // For daily syncs, if 'since' is a single date, fetch that entire day
    // Otherwise, if a date range is provided, use it
    let until: string | undefined = undefined;
    if (since) {
      // If since is just a date (YYYY-MM-DD), fetch the entire day
      if (since.match(/^\d{4}-\d{2}-\d{2}$/)) {
        until = `${since}T23:59:59Z`;
        since = `${since}T00:00:00Z`;
      } else {
        // If since includes time, use it as-is and don't set until (fetch from since onwards)
        until = undefined;
      }
    }
    
    // Fetch ALL orders without filtering - filtering happens in database/frontend
    const shopifyOrders = await fetchShopifyOrdersGraphQL({
      shopDomain: normalizedShop,
      accessToken,
      since,
      until,
      filterBy: 'processed_at', // Use processed_at filter (same as backfill)
      excludeTest: false, // Don't filter - fetch all orders, filtering happens in DB/frontend
    });

    console.log(`[sync-shopify] Fetched ${shopifyOrders.length} orders for tenant ${tenantId}`);

    // Map to database rows (need to preserve original order for customer_stats timestamp)
    const orderRowsWithOriginal: Array<{ row: ShopifyOrderRow; originalOrder: ShopifyOrder }> = shopifyOrders.map((order) => ({
      row: mapShopifyOrderToRow(tenantId, order),
      originalOrder: order,
    }));

    // Step 1: Update customer_stats for all orders in batch (MIN-merge)
    // Collect customer stats updates (using original order.created_at timestamp for accurate comparison)
    const customerStatsUpdates = new Map<string, {
      tenantId: string;
      customerId: string;
      firstOrderAt: string; // ISO timestamp from order.created_at
      firstOrderId: string;
    }>();

    for (const { row, originalOrder } of orderRowsWithOriginal) {
      if (!row.customer_id || !originalOrder.created_at) continue;
      
      const customerId = row.customer_id;
      const orderCreatedAtTimestamp = originalOrder.created_at; // ISO timestamp from API
      const orderId = row.order_id;
      
      const existing = customerStatsUpdates.get(customerId);
      if (!existing) {
        customerStatsUpdates.set(customerId, {
          tenantId,
          customerId,
          firstOrderAt: orderCreatedAtTimestamp,
          firstOrderId: orderId,
        });
      } else {
        // MIN-merge: if this order is earlier, or same timestamp but smaller order_id
        if (
          orderCreatedAtTimestamp < existing.firstOrderAt ||
          (orderCreatedAtTimestamp === existing.firstOrderAt && orderId < existing.firstOrderId)
        ) {
          existing.firstOrderAt = orderCreatedAtTimestamp;
          existing.firstOrderId = orderId;
        }
      }
    }

    // Upsert customer_stats (using SQL function for atomic MIN-merge)
    // Note: We use upsert_shopify_customer_stats (not the new RPC) for batch processing
    // The new RPC (upsert_and_classify_shopify_customer_order) is used in webhook for single orders
    if (customerStatsUpdates.size > 0) {
      for (const stats of customerStatsUpdates.values()) {
        const { error: statsError } = await client.rpc('upsert_shopify_customer_stats', {
          p_tenant_id: stats.tenantId,
          p_customer_id: stats.customerId,
          p_first_order_at: stats.firstOrderAt,
          p_first_order_id: stats.firstOrderId,
        });

        if (statsError) {
          console.error(
            `[sync-shopify] Failed to upsert customer_stats for customer ${stats.customerId}:`,
            statsError.message,
          );
          // Continue processing even if stats update fails
        }
      }
    }

    // Step 2: Fetch customer_stats for all customers in batch
    const customerStatsMap = new Map<string, { first_order_at: string; first_order_id: string }>();
    if (customerStatsUpdates.size > 0) {
      const { data: customerStats, error: statsFetchError } = await client
        .from('shopify_customer_stats')
        .select('customer_id, first_order_at, first_order_id')
        .eq('tenant_id', tenantId)
        .in('customer_id', Array.from(customerStatsUpdates.keys()));

      if (statsFetchError) {
        console.error('[sync-shopify] Failed to fetch customer_stats:', statsFetchError.message);
        // Continue but classification may be incorrect
      } else if (customerStats) {
        for (const stats of customerStats) {
          customerStatsMap.set(stats.customer_id, {
            first_order_at: stats.first_order_at,
            first_order_id: stats.first_order_id || '',
          });
        }
      }
    }

    // Step 3: Classify each order deterministically based on customer_stats
    let orderRows = orderRowsWithOriginal.map(({ row, originalOrder }) => {
      // Handle guest checkout or missing customer_id
      if (!row.customer_id || !row.created_at_ts || !originalOrder.created_at) {
        return {
          ...row,
          is_new_customer: false,
          is_first_order_for_customer: false,
          customer_type_shopify_mode: row.customer_id ? null : 'GUEST',
          customer_type_financial_mode: null,
        };
      }
      
      const stats = customerStatsMap.get(row.customer_id);
      if (!stats) {
        // Customer not in stats yet (shouldn't happen after upsert, but handle gracefully)
        console.warn(`[sync-shopify] Customer ${row.customer_id} not found in customer_stats`);
        return {
          ...row,
          is_new_customer: false,
          is_first_order_for_customer: false,
          customer_type_shopify_mode: 'RETURNING',
          customer_type_financial_mode: null,
        };
      }
      
      // Deterministic classification: is_first if timestamp matches AND order_id matches
      // Compare ISO timestamp string from API with timestamptz from stats
      // Convert both to ISO strings for accurate comparison (handles timezone normalization)
      const orderCreatedAtTimestamp = originalOrder.created_at; // ISO timestamp string from API
      const statsFirstOrderAt = stats.first_order_at; // timestamptz from database (ISO string format)
      
      // Normalize both to ISO strings for comparison
      // This handles timezone differences and ensures accurate timestamp comparison
      const orderTimestamp = new Date(orderCreatedAtTimestamp).toISOString();
      const statsTimestamp = new Date(statsFirstOrderAt).toISOString();
      
      // Compare timestamps: must match exactly
      // For same timestamp, use order_id as tie-breaker (exact match required)
      const isFirstOrder = 
        orderTimestamp === statsTimestamp &&
        row.order_id === stats.first_order_id; // Exact match required (no fallback to null check)
      
      // Set all classification fields consistently
      return {
        ...row,
        is_new_customer: isFirstOrder, // For backward compatibility
        is_first_order_for_customer: isFirstOrder,
        customer_type_shopify_mode: isFirstOrder ? 'FIRST_TIME' : 'RETURNING',
        customer_type_financial_mode: null, // DEPRECATED
      };
    });

    if (orderRows.length > 0) {
      const { error: upsertError } = await client.from('shopify_orders').upsert(orderRows, {
        onConflict: 'tenant_id,order_id',
      });

      if (upsertError) {
        throw new Error(upsertError.message);
      }

      // Process refunds and populate shopify_refunds table
      // CRITICAL: Process refunds from BOTH main orders AND lookback orders.
      // We need to find ALL product-related refunds where refund_processed_at falls
      // in our target period, regardless of when the order was processed_at.
      //
      // Process refunds and populate shopify_refunds table.
      //
      // NOTE: shopify_refunds is primarily a line-item level ledger for debugging.
      // The canonical source for Returns in analytics will be shopify_transactions
      // (kind = 'refund'), which is built from refund.transactions and, in
      // backfills, from GraphQL payment transactions.
      //
      // Shopify Analytics \"Returns\" includes:
      //   - Line item refunds (refund_line_items.subtotal_set.shop_money.amount)
      //   - Custom refunds that do not have refund_line_items (only transactions)
      //
      // but EXCLUDES:
      //   - Tax refunds
      //   - Shipping refunds
      const refundRows: Array<{
        tenant_id: string;
        shopify_order_id: string;
        shopify_refund_id: string;
        refund_processed_at: string;
        refunded_subtotal: number;
        refunded_tax: number;
        refunded_shipping: number;
        currency: string | null;
      }> = [];

      // Determine target period for refund filtering (if we have a since date).
      // When present, we only keep refunds whose refund_processed_at falls inside
      // this window – matching Shopify Analytics which attributes returns on
      // refund date, not order date.
      let refundPeriodStart: Date | null = null;
      let refundPeriodEnd: Date | null = null;
      if (since) {
        refundPeriodStart = new Date(since);
        refundPeriodEnd = new Date(); // Current date as end
      }

      // Track how many refund transactions we upsert to the transaction ledger
      let refundTransactionsUpserted = 0;

      // Process refunds from main orders (for orders in target period)
      for (const { originalOrder } of orderRowsWithOriginal) {
        if (!originalOrder.refunds || originalOrder.refunds.length === 0) continue;

        for (const refund of originalOrder.refunds) {
          // STEP A: Calculate refunded_subtotal from refund_line_items (line item refunds, excl. tax)
          let refundedSubtotal = 0;
          if (refund.refund_line_items && refund.refund_line_items.length > 0) {
            for (const refundLineItem of refund.refund_line_items) {
              // Prefer subtotal_set.shop_money.amount if available (most accurate)
              if (refundLineItem.subtotal_set?.shop_money?.amount) {
                refundedSubtotal += parseFloat(refundLineItem.subtotal_set.shop_money.amount);
              } else if (refundLineItem.subtotal) {
                // Fallback to subtotal string
                refundedSubtotal += parseFloat(refundLineItem.subtotal);
              }
            }
          }

          // STEP B: Fallback – handle custom refunds without refund_line_items.
          // Shopify Analytics still counts these as \"Returns\".
          //
          // When there are no line item subtotals, approximate the product refund
          // portion from refund.transactions. We:
          //   - Treat kind='refund' + gateway=null as tax/shipping (handled below)
          //   - Treat kind='refund' + gateway!=null as product-level refund
          if (
            refundedSubtotal === 0 &&
            refund.transactions &&
            refund.transactions.length > 0
          ) {
            for (const transaction of refund.transactions) {
              const amount = parseFloat(transaction.amount || '0');
              if (!Number.isFinite(amount) || amount <= 0) continue;

              // Product-level refund approximation: kind='refund' with a gateway.
              // Tax/shipping refunds (kind='refund' + gateway=null) are handled
              // separately and should not be counted as product returns.
              if (transaction.kind === 'refund' && transaction.gateway) {
                refundedSubtotal += amount;
              }
            }
          }

          // STEP C: Calculate refunded_tax and refunded_shipping from transactions.
          // Shopify refund transactions have kind='refund' and gateway=null for
          // tax/shipping refunds. We conservatively attribute these amounts to tax.
          let refundedTax = 0;
          let refundedShipping = 0;
          if (refund.transactions && refund.transactions.length > 0) {
            for (const transaction of refund.transactions) {
              const amount = parseFloat(transaction.amount || '0');
              // For tax refunds: kind='refund' and gateway is null
              // For shipping refunds: similar pattern (may need refinement based on actual data)
              if (transaction.kind === 'refund' && !transaction.gateway) {
                // Shopify doesn't always break down tax vs shipping in transactions
                // This is an approximation - may need refinement
                refundedTax += amount; // Conservative: attribute to tax
              }
            }
          }

          // Use refund.processed_at if available (preferred), otherwise fallback to created_at
          // This is critical for accurate time series matching with Shopify Analytics
          const refundDate = refund.processed_at || refund.created_at;
          
          // FILTER: Only include refunds where refund_processed_at falls in our target period
          // This ensures we count refunds by refund date, not order date (matching Shopify Analytics)
          if (refundPeriodStart && refundPeriodEnd) {
            const refundDateObj = new Date(refundDate);
            if (refundDateObj < refundPeriodStart || refundDateObj > refundPeriodEnd) {
              // Skip refunds outside our target period
              continue;
            }
          }
          
          refundRows.push({
            tenant_id: tenantId,
            shopify_order_id: originalOrder.id.toString(),
            shopify_refund_id: refund.id.toString(),
            refund_processed_at: refundDate,
            refunded_subtotal: refundedSubtotal,
            refunded_tax: refundedTax,
            refunded_shipping: refundedShipping,
            currency: originalOrder.currency || null,
          });
        }
      }

      // Upsert refunds if any
      if (refundRows.length > 0) {
        const { error: refundsError } = await client
          .from('shopify_refunds')
          .upsert(refundRows, {
            onConflict: 'tenant_id,shopify_order_id,shopify_refund_id',
          });

        if (refundsError) {
          console.error('[sync-shopify] Failed to upsert refunds:', refundsError.message);
          // Continue processing even if refunds update fails (non-critical)
        } else {
          console.log(`[sync-shopify] Upserted ${refundRows.length} refund events`);
        }
      }

      // Build transaction ledger rows from refund.transactions (kind = 'refund').
      // This provides a near real-time transaction ledger; historical completeness
      // comes from the GraphQL-powered backfill script which also writes to
      // shopify_transactions.
      const transactionRows: Array<{
        tenant_id: string;
        order_id: string;
        shopify_transaction_id: string;
        processed_at: string;
        kind: string;
        amount: number;
        currency: string | null;
        gateway: string | null;
        status: string | null;
        test: boolean | null;
      }> = [];

      for (const { originalOrder } of orderRowsWithOriginal) {
        if (!originalOrder.refunds || originalOrder.refunds.length === 0) continue;

        const orderIdStr = originalOrder.id.toString();

        for (const refund of originalOrder.refunds) {
          if (!refund.transactions || refund.transactions.length === 0) continue;

          for (const tx of refund.transactions) {
            if (tx.kind !== 'refund') continue;

            const amount = parseFloat(tx.amount || '0');
            if (!Number.isFinite(amount) || amount <= 0) continue;

            const processedAt =
              tx.processed_at ||
              tx.created_at ||
              refund.processed_at ||
              refund.created_at;

            const currency = tx.currency || originalOrder.currency || null;
            const status = (tx.status as string | null) ?? null;
            const test =
              typeof tx.test === 'boolean'
                ? tx.test
                : typeof originalOrder.test === 'boolean'
                  ? originalOrder.test
                  : null;

            const txId =
              (tx.id !== undefined && tx.id !== null
                ? String(tx.id)
                : `${orderIdStr}-${refund.id}-${tx.kind}-${processedAt}`) || '';

            transactionRows.push({
              tenant_id: tenantId,
              order_id: orderIdStr,
              shopify_transaction_id: txId,
              processed_at: processedAt,
              kind: tx.kind,
              amount,
              currency,
              gateway: tx.gateway,
              status,
              test,
            });
          }
        }
      }

      if (transactionRows.length > 0) {
        const { error: txError } = await client
          .from('shopify_transactions')
          .upsert(transactionRows, {
            onConflict: 'tenant_id,shopify_transaction_id',
          });

        if (txError) {
          console.error('[sync-shopify] Failed to upsert transactions:', txError.message);
        } else {
          refundTransactionsUpserted = transactionRows.length;
          console.log(
            `[sync-shopify] Upserted ${refundTransactionsUpserted} refund transactions to shopify_transactions`,
          );
        }
      }

      // Log sync summary for operational parity verification
      console.log(
        `[sync-shopify] SYNC_VERSION=${SYNC_VERSION} - Summary: ${orderRows.length} orders updated, ${refundRows.length} refunds upserted, ${refundTransactionsUpserted} refund transactions upserted`,
      );

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
        new_customer_net_sales: row.new_customer_net_sales,
        returning_customer_net_sales: row.returning_customer_net_sales,
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

      // Update shopify_daily_sales for all dates that were affected by this sync
      // We need to recalculate from ALL orders for each date (not just the synced ones)
      // to ensure accuracy - this matches the logic in recalculate_all_shopify_daily_sales.ts
      const uniqueDates = Array.from(new Set(aggregates.map((a) => a.date)));
      
      for (const date of uniqueDates) {
        // Fetch ALL orders for this date from database
        const { data: dateOrders, error: dateOrdersError } = await client
          .from('shopify_orders')
          .select('processed_at, gross_sales, net_sales, discount, refunds, currency, is_first_order_for_customer, is_refund')
          .eq('tenant_id', tenantId)
          .eq('processed_at', date)
          .not('gross_sales', 'is', null)
          .gt('gross_sales', 0);

        if (dateOrdersError) {
          console.error(`[sync-shopify] Failed to fetch orders for date ${date}:`, dateOrdersError.message);
          continue;
        }

        // Aggregate for this date from ALL orders
        let grossSales = 0;
        let netSales = 0;
        let discounts = 0;
        let refunds = 0;
        let ordersCount = 0;
        let newCustomerNetSales = 0;
        let returningCustomerNetSales = 0;
        let currency: string | null = null;

        for (const order of dateOrders || []) {
          const gross = parseFloat((order.gross_sales || 0).toString());
          const net = parseFloat((order.net_sales || 0).toString());
          const disc = parseFloat((order.discount || 0).toString());
          const ref = parseFloat((order.refunds || 0).toString());

          grossSales += gross;
          netSales += net;
          discounts += disc;
          refunds += ref;

          // Count ALL orders with gross_sales > 0 (Shopify Analytics behavior)
          // Only filter: gross_sales > 0 (already filtered in the query above)
          // No filtering on is_refund - Shopify counts all orders with gross_sales > 0
          ordersCount += 1;
          
          if (order.is_first_order_for_customer === true) {
            newCustomerNetSales += net;
          } else if (order.is_first_order_for_customer === false) {
            returningCustomerNetSales += net;
          }

          if (!currency && order.currency) {
            currency = order.currency as string;
          }
        }

        // Upsert shopify_daily_sales for this date
        const { error: dailySalesError } = await client
          .from('shopify_daily_sales')
          .upsert(
            {
              tenant_id: tenantId,
              date: date,
              mode: 'shopify',
              gross_sales_excl_tax: grossSales,
              net_sales_excl_tax: netSales,
              discounts_excl_tax: discounts,
              refunds_excl_tax: refunds,
              orders_count: ordersCount,
              currency: currency,
              new_customer_net_sales: newCustomerNetSales,
              returning_customer_net_sales: returningCustomerNetSales,
              guest_net_sales: 0,
            },
            {
              onConflict: 'tenant_id,date,mode',
            },
          );

        if (dailySalesError) {
          console.error(`[sync-shopify] Failed to upsert shopify_daily_sales for date ${date}:`, dailySalesError.message);
        }
      }
      
      console.log(`[sync-shopify] Updated shopify_daily_sales for ${uniqueDates.length} dates for tenant ${tenantId}`);
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
      jobLogId,
    });

    return { tenantId, status: 'succeeded', inserted: orderRows.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sync-shopify] Error processing tenant ${tenantId}:`, message);
    
    // Update existing job log if we have an ID, otherwise create new one
    if (jobLogId) {
      await upsertJobLog(client, {
        tenantId,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        error: message,
        jobLogId,
      });
    } else {
      // Fallback: create new entry if we don't have jobLogId
      await upsertJobLog(client, {
        tenantId,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        error: message,
      });
    }

    return { tenantId, status: 'failed', error: message };
  } finally {
    // Ensure job log is always updated if we have a jobLogId but it's still in running status
    if (jobLogId) {
      try {
        // Check if job log was already updated (has finished_at)
        const { data: existingJob } = await client
          .from('jobs_log')
          .select('finished_at')
          .eq('id', jobLogId)
          .maybeSingle();

        // Only update if still in running status (no finished_at)
        if (existingJob && !existingJob.finished_at) {
          await upsertJobLog(client, {
            tenantId,
            status: 'failed',
            startedAt,
            finishedAt: new Date().toISOString(),
            error: 'Job execution was interrupted or failed unexpectedly',
            jobLogId,
          });
        }
      } catch (finalError) {
        // Last resort - log but don't throw
        console.error(`Failed to update job log in finally block for tenant ${tenantId}:`, finalError);
      }
    }
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