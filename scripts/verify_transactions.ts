#!/usr/bin/env -S tsx

/**
 * Verify transactions were saved correctly
 */

import { ArgumentParser } from 'argparse';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

async function main() {
  const parser = new ArgumentParser({
    description: 'Verify transactions were saved correctly',
  });

  parser.add_argument('--tenant', {
    required: true,
    help: 'Tenant slug',
  });

  parser.add_argument('--date', {
    required: true,
    help: 'Date to verify (YYYY-MM-DD)',
  });

  const args = parser.parse_args();

  // Get tenant ID
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, name')
    .eq('slug', args.tenant)
    .single();

  if (tenantError || !tenant) {
    console.error(`Failed to find tenant ${args.tenant}: ${tenantError?.message}`);
    process.exit(1);
  }

  console.log(`\n[verify_transactions] Verifying transactions for ${tenant.name}`);
  console.log(`[verify_transactions] Date: ${args.date}\n`);

  // Get transaction summary by event type
  const { data: transactions, error: fetchError } = await supabase
    .from('shopify_sales_transactions')
    .select('event_type, gross_sales, discounts, returns')
    .eq('tenant_id', tenant.id)
    .eq('event_date', args.date);

  if (fetchError) {
    console.error(`Failed to fetch transactions: ${fetchError.message}`);
    process.exit(1);
  }

  if (!transactions || transactions.length === 0) {
    console.log('❌ No transactions found for this date');
    process.exit(1);
  }

  // Aggregate by event type
  const byEventType = new Map<string, {
    count: number;
    gross_sales: number;
    discounts: number;
    returns: number;
    net_sales: number;
  }>();

  for (const txn of transactions) {
    const eventType = txn.event_type as string;
    const existing = byEventType.get(eventType) || {
      count: 0,
      gross_sales: 0,
      discounts: 0,
      returns: 0,
      net_sales: 0,
    };

    existing.count += 1;
    existing.gross_sales += parseFloat((txn.gross_sales || 0).toString());
    existing.discounts += parseFloat((txn.discounts || 0).toString());
    existing.returns += parseFloat((txn.returns || 0).toString());
    existing.net_sales = existing.gross_sales - existing.discounts - existing.returns;

    byEventType.set(eventType, existing);
  }

  console.log('📊 Transaction Summary by Event Type:\n');
  for (const [eventType, stats] of Array.from(byEventType.entries()).sort()) {
    console.log(`${eventType}:`);
    console.log(`  Count: ${stats.count}`);
    console.log(`  Gross Sales: ${stats.gross_sales.toFixed(2)} SEK`);
    console.log(`  Discounts: ${stats.discounts.toFixed(2)} SEK`);
    console.log(`  Returns: ${stats.returns.toFixed(2)} SEK`);
    console.log(`  Net Sales: ${stats.net_sales.toFixed(2)} SEK`);
    console.log('');
  }

  // Total summary
  const total = {
    count: transactions.length,
    gross_sales: 0,
    discounts: 0,
    returns: 0,
    net_sales: 0,
  };

  for (const stats of byEventType.values()) {
    total.gross_sales += stats.gross_sales;
    total.discounts += stats.discounts;
    total.returns += stats.returns;
  }
  total.net_sales = total.gross_sales - total.discounts - total.returns;

  console.log('📊 Total Summary:');
  console.log(`  Total Transactions: ${total.count}`);
  console.log(`  Total Gross Sales: ${total.gross_sales.toFixed(2)} SEK`);
  console.log(`  Total Discounts: ${total.discounts.toFixed(2)} SEK`);
  console.log(`  Total Returns: ${total.returns.toFixed(2)} SEK`);
  console.log(`  Total Net Sales: ${total.net_sales.toFixed(2)} SEK`);
  console.log('');

  // Compare with shopify_orders
  const { data: orders, error: ordersError } = await supabase
    .from('shopify_orders')
    .select('gross_sales, net_sales, discount_total, total_refunds')
    .eq('tenant_id', tenant.id)
    .eq('processed_at', args.date);

  if (!ordersError && orders && orders.length > 0) {
    const ordersGrossSales = orders.reduce((sum, o) => sum + parseFloat((o.gross_sales || 0).toString()), 0);
    const ordersNetSales = orders.reduce((sum, o) => sum + parseFloat((o.net_sales || 0).toString()), 0);
    const ordersDiscounts = orders.reduce((sum, o) => sum + parseFloat((o.discount_total || 0).toString()), 0);
    const ordersReturns = orders.reduce((sum, o) => sum + parseFloat((o.total_refunds || 0).toString()), 0);

    console.log('📊 Comparison with shopify_orders:');
    console.log(`  Orders: ${orders.length}`);
    console.log(`  Orders Gross Sales: ${ordersGrossSales.toFixed(2)} SEK`);
    console.log(`  Transactions Gross Sales: ${total.gross_sales.toFixed(2)} SEK`);
    console.log(`  Difference: ${(total.gross_sales - ordersGrossSales).toFixed(2)} SEK`);
    console.log('');
  }

  console.log('✅ Verification completed!');
}

main().catch((error) => {
  console.error('\n❌ Error:', error);
  process.exit(1);
});

