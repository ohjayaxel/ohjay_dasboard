#!/usr/bin/env -S tsx

/**
 * Check Shopify order data for a specific date range
 * 
 * Usage:
 *   source env/local.prod.sh
 *   pnpm tsx scripts/check_shopify_data.ts --tenant skinome --from 2025-11-01 --to 2025-11-17
 */

import { ArgumentParser } from 'argparse';
import { createClient } from '@supabase/supabase-js';

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

async function main() {
  const parser = new ArgumentParser({
    description: 'Check Shopify order data',
  });

  parser.add_argument('--tenant', {
    required: true,
    help: 'Tenant slug (e.g., skinome)',
  });

  parser.add_argument('--from', {
    required: true,
    help: 'Start date (YYYY-MM-DD)',
  });

  parser.add_argument('--to', {
    required: true,
    help: 'End date (YYYY-MM-DD)',
  });

  const args = parser.parse_args();

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

  console.log(`\n[check_shopify_data] Checking data for tenant: ${tenant.name} (${tenant.id})`);
  console.log(`[check_shopify_data] Date range: ${args.from} to ${args.to}\n`);

  // Query orders from shopify_orders table (fetch all, no limit)
  let allOrders: any[] = [];
  let page = 0;
  const pageSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data: orders, error: ordersError } = await supabase
      .from('shopify_orders')
      .select('*')
      .eq('tenant_id', tenant.id)
      .gte('processed_at', args.from)
      .lte('processed_at', args.to)
      .order('processed_at', { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (ordersError) {
      throw new Error(`Failed to fetch orders: ${ordersError.message}`);
    }

    if (orders && orders.length > 0) {
      allOrders.push(...orders);
      page++;
      
      if (orders.length < pageSize) {
        hasMore = false;
      }
    } else {
      hasMore = false;
    }
  }

  const orders = allOrders;

  console.log(`[check_shopify_data] Found ${orders?.length || 0} orders\n`);

  if (!orders || orders.length === 0) {
    console.log('[check_shopify_data] No orders found for the specified period.');
    return;
  }

  // Calculate totals
  let grossSales = 0;
  let netSales = 0;
  let totalDiscounts = 0;
  let totalRefunds = 0;
  let orderCount = 0;
  let refundOrderCount = 0;

  // Also check calculation method: gross_sales = subtotal + discounts + refunds
  let calculatedGrossSales = 0;
  let calculatedNetSales = 0;

  // Count only non-refund orders for sales totals
  // Note: In Shopify, an order can have refunds, but that doesn't make it a "refund order"
  // The is_refund flag likely marks something else - let's count all orders
  // Refunds are tracked separately in total_refunds column
  for (const order of orders) {
    const subtotal = parseFloat(order.net_sales || '0'); // net_sales = subtotal_price
    const discounts = parseFloat(order.discount_total || '0');
    const refunds = parseFloat(order.total_refunds || '0');
    
    // Count ALL orders (non-refund) for sales
    // If is_refund is true, it might mean something else - exclude those for now
    if (!order.is_refund) {
      grossSales += parseFloat(order.gross_sales || '0');
      netSales += parseFloat(order.net_sales || '0');
      totalDiscounts += discounts;
      orderCount++;
      
      // Verify calculation: gross_sales should be subtotal + discounts + refunds
      const expectedGross = subtotal + discounts + refunds;
      calculatedGrossSales += expectedGross;
      calculatedNetSales += subtotal;
    } else {
      refundOrderCount++;
    }
    
    // Always count refunds from total_refunds column (they're stored as positive numbers)
    totalRefunds += refunds;
  }
  
  // Note: Shopify's gross_sales calculation includes refunds in the gross_sales field
  // So gross_sales = (subtotal after refunds) + discounts + refunds
  // This means gross_sales already accounts for refunds
  // Net sales should NOT include refunds (it's subtotal after discounts but before refunds are added back)
  
  // The expected values suggest:
  // Gross Sales = Net Sales + Discounts + Refunds
  // 6,459,927.70 ≈ 4,639,736.58 + 1,786,457.33 + 33,733.79 = 6,459,927.70 ✓
  
  // But our calculation shows:
  // Gross Sales = subtotal (net_sales) + discounts + refunds
  // Which matches the formula, but our values are higher
  
  // Possible issues:
  // 1. We have orders that shouldn't be included (wrong date range)
  // 2. We're double-counting refunds somewhere
  // 3. Our gross_sales calculation is wrong

  // Format as currency (SEK)
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('sv-SE', {
      style: 'currency',
      currency: 'SEK',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  console.log('[check_shopify_data] ============================================');
  console.log('[check_shopify_data] SUMMARY');
  console.log('[check_shopify_data] ============================================');
  console.log(`[check_shopify_data] Orders (non-refund): ${orderCount}`);
  console.log(`[check_shopify_data] Orders (refund): ${refundOrderCount}`);
  console.log(`[check_shopify_data] Total orders: ${orders.length}`);
  console.log(`[check_shopify_data] Gross Sales (from DB): ${formatCurrency(grossSales)}`);
  console.log(`[check_shopify_data] Gross Sales (calculated): ${formatCurrency(calculatedGrossSales)}`);
  console.log(`[check_shopify_data] Net Sales (from DB): ${formatCurrency(netSales)}`);
  console.log(`[check_shopify_data] Net Sales (calculated): ${formatCurrency(calculatedNetSales)}`);
  console.log(`[check_shopify_data] Discounts: ${formatCurrency(-totalDiscounts)}`);
  console.log(`[check_shopify_data] Returns/Refunds: ${formatCurrency(-totalRefunds)}`);
  console.log('[check_shopify_data] ============================================\n');

  // Expected values
  const expectedGrossSales = 6459927.70;
  const expectedNetSales = 4639736.58;
  const expectedDiscounts = 1786457.33;
  const expectedRefunds = 33733.79;

  console.log('[check_shopify_data] ============================================');
  console.log('[check_shopify_data] COMPARISON WITH EXPECTED VALUES');
  console.log('[check_shopify_data] ============================================');
  console.log(`[check_shopify_data] Gross Sales:`);
  console.log(`[check_shopify_data]   Expected: ${formatCurrency(expectedGrossSales)}`);
  console.log(`[check_shopify_data]   Actual:   ${formatCurrency(grossSales)}`);
  console.log(`[check_shopify_data]   Diff:     ${formatCurrency(grossSales - expectedGrossSales)}`);
  console.log(`[check_shopify_data] Net Sales:`);
  console.log(`[check_shopify_data]   Expected: ${formatCurrency(expectedNetSales)}`);
  console.log(`[check_shopify_data]   Actual:   ${formatCurrency(netSales)}`);
  console.log(`[check_shopify_data]   Diff:     ${formatCurrency(netSales - expectedNetSales)}`);
  console.log(`[check_shopify_data] Discounts:`);
  console.log(`[check_shopify_data]   Expected: ${formatCurrency(-expectedDiscounts)}`);
  console.log(`[check_shopify_data]   Actual:   ${formatCurrency(-totalDiscounts)}`);
  console.log(`[check_shopify_data]   Diff:     ${formatCurrency(totalDiscounts - expectedDiscounts)}`);
  console.log(`[check_shopify_data] Refunds:`);
  console.log(`[check_shopify_data]   Expected: ${formatCurrency(-expectedRefunds)}`);
  console.log(`[check_shopify_data]   Actual:   ${formatCurrency(-totalRefunds)}`);
  console.log(`[check_shopify_data]   Diff:     ${formatCurrency(totalRefunds - expectedRefunds)}`);
  console.log('[check_shopify_data] ============================================\n');

  // Show sample of orders by date
  const byDate = new Map<string, { count: number; gross: number; net: number }>();
  for (const order of orders) {
    if (!order.is_refund && order.processed_at) {
      const existing = byDate.get(order.processed_at) || { count: 0, gross: 0, net: 0 };
      existing.count++;
      existing.gross += parseFloat(order.gross_sales || '0');
      existing.net += parseFloat(order.net_sales || '0');
      byDate.set(order.processed_at, existing);
    }
  }

  console.log('[check_shopify_data] Orders per day:');
  for (const [date, stats] of Array.from(byDate.entries()).sort()) {
    console.log(`[check_shopify_data]   ${date}: ${stats.count} orders, Gross: ${formatCurrency(stats.gross)}, Net: ${formatCurrency(stats.net)}`);
  }
  console.log('');
}

main().catch((error) => {
  console.error('\n[check_shopify_data] ❌ Error:', error);
  process.exit(1);
});

