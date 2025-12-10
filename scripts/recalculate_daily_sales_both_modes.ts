#!/usr/bin/env tsx

/**
 * Recalculate shopify_daily_sales for both Shopify and Financial modes
 * using the stored per-order customer classification in shopify_orders.
 *
 * This is a post-processing step after fixing customer classification
 * (e.g., via reclassify_all_customers.ts). It does NOT call Shopify APIs.
 *
 * Usage:
 *   pnpm tsx scripts/recalculate_daily_sales_both_modes.ts <tenant-slug>
 *
 * Example:
 *   pnpm tsx scripts/recalculate_daily_sales_both_modes.ts skinome
 */

import { readFileSync } from 'fs';

// Load environment variables from .env.local if present
function loadEnvFile() {
  const possible = [
    process.env.ENV_FILE,
    '.env.local',
    '.env.production.local',
    '.env.development.local',
    '.env',
  ].filter(Boolean) as string[];

  for (const envFile of possible) {
    try {
      const content = readFileSync(envFile, 'utf-8');
      for (const line of content.split('\n')) {
        const match = line.match(/^([^=:#]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          const value = match[2].trim().replace(/^[\"']|[\"']$/g, '');
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
      console.log(`[recalc_both_modes] Loaded env from ${envFile}`);
      return;
    } catch {
      // try next
    }
  }
}

loadEnvFile();

import { createClient } from '@supabase/supabase-js';
import { resolveTenantId } from '@/lib/tenants/resolve-tenant';
import { calculateDailySales, type OrderCustomerClassification, type SalesMode } from '@/lib/shopify/sales';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

type OrderRow = {
  order_id: string;
  customer_id: string | null;
  created_at: string | null;
  processed_at: string | null;
  currency: string | null;
  financial_status: string | null;
  customer_type_shopify_mode: 'FIRST_TIME' | 'RETURNING' | 'GUEST' | 'UNKNOWN' | null;
  customer_type_financial_mode: 'NEW' | 'RETURNING' | 'GUEST' | 'UNKNOWN' | null;
  is_first_order_for_customer: boolean | null;
};

type TxRow = {
  shopify_order_id: string;
  event_type: string;
  event_date: string;
  currency: string | null;
  gross_sales: number | null;
  discounts: number | null;
  returns: number | null;
  tax: number | null;
  shipping: number | null;
  product_sku: string | null;
  product_title: string | null;
  variant_title: string | null;
};

async function recalc(tenantSlug: string) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Recalculate Daily Sales (both modes)');
  console.log('═══════════════════════════════════════════════════════\n');

  const tenantId = await resolveTenantId(tenantSlug);
  console.log(`Tenant: ${tenantSlug} (${tenantId})\n`);

  // Fetch orders with classification (pagination)
  console.log('📥 Fetching orders with classification from shopify_orders...');
  let orders: OrderRow[] = [];
  {
    const pageSize = 1000;
    let page = 0;
    while (true) {
      const { data, error } = await supabase
        .from('shopify_orders')
        .select(
          'order_id, customer_id, created_at, processed_at, currency, financial_status, customer_type_shopify_mode, customer_type_financial_mode, is_first_order_for_customer',
        )
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: true })
        .range(page * pageSize, page * pageSize + pageSize - 1);

      if (error) throw new Error(`Failed to fetch orders (page ${page}): ${error.message}`);
      if (!data || data.length === 0) break;
      orders = orders.concat(data as OrderRow[]);
      console.log(`   Fetched ${orders.length} orders so far...`);
      if (data.length < pageSize) break;
      page += 1;
    }
  }
  if (orders.length === 0) {
    console.log('No orders found. Exiting.');
    return;
  }
  console.log(`✅ Fetched ${orders.length} orders\n`);

  // Fetch transactions (pagination)
  console.log('📥 Fetching transactions from shopify_sales_transactions...');
  let txs: TxRow[] = [];
  {
    const pageSize = 1000;
    let page = 0;
    while (true) {
      const { data, error } = await supabase
        .from('shopify_sales_transactions')
        .select(
          'shopify_order_id, event_type, event_date, currency, gross_sales, discounts, returns, tax, shipping, product_sku, product_title, variant_title',
        )
        .eq('tenant_id', tenantId)
        .order('event_date', { ascending: true })
        .range(page * pageSize, page * pageSize + pageSize - 1);

      if (error) throw new Error(`Failed to fetch transactions (page ${page}): ${error.message}`);
      if (!data || data.length === 0) break;
      txs = txs.concat(data as TxRow[]);
      console.log(`   Fetched ${txs.length} transactions so far...`);
      if (data.length < pageSize) break;
      page += 1;
    }
  }
  console.log(`✅ Fetched ${txs.length} transactions\n`);

  // Group transactions by order_id
  const txByOrder = new Map<string, TxRow[]>();
  for (const tx of txs || []) {
    let key = tx.shopify_order_id?.toString();
    if (key && key.startsWith('gid://shopify/Order/')) {
      key = key.replace('gid://shopify/Order/', '');
    }
    if (!key) continue;
    if (!txByOrder.has(key)) txByOrder.set(key, []);
    txByOrder.get(key)!.push(tx);
  }

  // Build classification map and ShopifyOrderWithTransactions
  type ShopifyOrderWithTransactions = Parameters<typeof calculateDailySales>[0][number];

  const orderCustomerClassification = new Map<string, OrderCustomerClassification>();
  const orderCustomerMapShopify = new Map<string, boolean>(); // order_id -> is_new_customer (FIRST_TIME)
  const ordersWithTx: ShopifyOrderWithTransactions[] = [];
  let ordersWithTransactionsCount = 0;

  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const o of orders as OrderRow[]) {
    const orderId = o.order_id.toString();
    const createdAt = o.created_at ? new Date(o.created_at).toISOString() : null;
    const processedAt = o.processed_at ? new Date(o.processed_at).toISOString() : null;

    const shopifyMode = (o.customer_type_shopify_mode as any) || 'UNKNOWN';
    const financialMode = (o.customer_type_financial_mode as any) || 'UNKNOWN';
    const isFirst =
      shopifyMode === 'FIRST_TIME'
        ? true
        : !!o.is_first_order_for_customer;

    orderCustomerClassification.set(orderId, {
      shopifyMode: shopifyMode === null ? 'UNKNOWN' : shopifyMode,
      financialMode: financialMode === null ? 'UNKNOWN' : financialMode,
      customerCreatedAt: shopifyMode === 'FIRST_TIME' ? (minDate || o.created_at || null) : null,
      isFirstOrderForCustomer: isFirst,
    });
    orderCustomerMapShopify.set(orderId, shopifyMode === 'FIRST_TIME');

    const orderTx = txByOrder.get(orderId) || [];

    // Track date range
    if (createdAt) {
      const d = createdAt.slice(0, 10);
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
    if (processedAt) {
      const d = processedAt.slice(0, 10);
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }

    const mapTx = orderTx
      .filter((t) => !!t.event_date)
      .map((t) => ({
        shopify_order_id: orderId,
        event_type: t.event_type,
        event_date: t.event_date!,
        currency: t.currency || o.currency || null,
        kind: (t.event_type === 'SALE' ? 'SALE' : t.event_type === 'REFUND' ? 'REFUND' : 'SALE') as any,
        status: 'SUCCESS',
        processedAt: t.event_date!,
        product_sku: t.product_sku || undefined,
        product_title: t.product_title || undefined,
        variant_title: t.variant_title || undefined,
        gross_sales: t.gross_sales ?? 0,
        discounts: t.discounts ?? 0,
        returns: t.returns ?? 0,
        tax: t.tax ?? 0,
        shipping: t.shipping ?? 0,
        quantity: 1,
      }));

    if (mapTx.length > 0) {
      ordersWithTransactionsCount += 1;
    }

    const netFromTx = mapTx.reduce(
      (sum, t) => sum + (t.gross_sales ?? 0) - (t.discounts ?? 0) - (t.returns ?? 0),
      0,
    );

    ordersWithTx.push({
      id: orderId,
      name: orderId,
      orderNumber: 0,
      processedAt,
      createdAt,
      updatedAt: processedAt || createdAt,
      created_at: createdAt,
      processed_at: processedAt,
      currency: o.currency || null,
      test: false,
      customer: o.customer_id ? { id: o.customer_id } : null,
      financial_status: o.financial_status || 'paid',
      cancelled_at: null,
      refunds: [],
      line_items: [],
      subtotal_price: netFromTx.toFixed(2),
      total_tax: '0',
      total_discounts: '0',
      transactions: mapTx,
    });
  }

  console.log(`✅ Built ${ordersWithTx.length} orders; with transactions: ${ordersWithTransactionsCount}`);
  console.log(`Date span: ${minDate} to ${maxDate}\n`);

  // Calculate daily sales for both modes using stored classification
  console.log('🧮 Calculating daily sales (Shopify mode)...');
  const shopifyModeDaily = calculateDailySales(
    ordersWithTx,
    'shopify',
    'Europe/Stockholm',
    orderCustomerMapShopify,
    undefined,
    minDate || undefined,
    maxDate || undefined,
  ).filter((row) => row.date && row.date !== 'Invalid Date');
  console.log(`✅ Shopify mode daily rows: ${shopifyModeDaily.length}`);

  console.log('🧮 Calculating daily sales (Financial mode)...');
  const financialModeDaily = calculateDailySales(
    ordersWithTx,
    'financial',
    'Europe/Stockholm',
    undefined,
    orderCustomerClassification,
  ).filter((row) => row.date && row.date !== 'Invalid Date');
  console.log(`✅ Financial mode daily rows: ${financialModeDaily.length}\n`);

  // Prepare rows for upsert
  const dailySalesRows = [
    ...shopifyModeDaily.map((row) => ({
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
    })),
    ...financialModeDaily.map((row) => ({
      tenant_id: tenantId,
      date: row.date,
      mode: 'financial' as SalesMode,
      net_sales_excl_tax: row.netSalesExclTax,
      gross_sales_excl_tax: row.grossSalesExclTax || null,
      refunds_excl_tax: row.refundsExclTax || null,
      discounts_excl_tax: row.discountsExclTax || null,
      orders_count: row.ordersCount,
      currency: row.currency || null,
      new_customer_net_sales: row.newCustomerNetSales || 0,
      returning_customer_net_sales: row.returningCustomerNetSales || 0,
      guest_net_sales: row.guestNetSales || 0,
    })),
  ];

  // Upsert
  console.log(`💾 Upserting ${dailySalesRows.length} daily sales rows...`);
  const BATCH_SIZE = 500;
  let saved = 0;
  const failed: number[] = [];

  for (let i = 0; i < dailySalesRows.length; i += BATCH_SIZE) {
    const batch = dailySalesRows.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(dailySalesRows.length / BATCH_SIZE);
    const { error } = await supabase.from('shopify_daily_sales').upsert(batch, {
      onConflict: 'tenant_id,date,mode',
    });
    if (error) {
      console.error(`   ✗ Batch ${batchNum}/${totalBatches} failed: ${error.message}`);
      failed.push(batchNum);
    } else {
      saved += batch.length;
      if (batchNum % 20 === 0 || batchNum === totalBatches) {
        console.log(`   ✓ Batch ${batchNum}/${totalBatches} (${saved}/${dailySalesRows.length} rows)`);
      }
    }
  }

  console.log('\n✅ Done!');
  console.log(`   Saved rows: ${saved}/${dailySalesRows.length}`);
  if (failed.length > 0) {
    console.log(`   Failed batches: ${failed.join(', ')}`);
  }
}

const tenantSlug = process.argv[2] || 'skinome';
recalc(tenantSlug).catch((error) => {
  console.error('\n❌ Error:', error);
  process.exit(1);
});

