#!/usr/bin/env tsx

/**
 * Debug script to find why recalculate gives 20M instead of 2.5M
 * 
 * Usage:
 *   source env/local.prod.sh
 *   pnpm tsx scripts/debug_recalculate_bug.ts skinome 2025-01-01 2025-01-31
 */

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
function loadEnvFile() {
  const shellScripts = ['env/local.prod.sh', 'env/local.dev.sh'];
  for (const script of shellScripts) {
    try {
      const content = readFileSync(script, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (!trimmed.startsWith('export ')) continue;
        const match = trimmed.match(/^export\s+([^=]+)=["']?([^"']+)["']?/);
        if (match) {
          const key = match[1].trim();
          let value = match[2].trim();
          if ((value.startsWith('"') && value.endsWith('"')) || 
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          process.env[key] = value;
        }
      }
      console.log(`✅ Loaded env from ${script}`);
      return;
    } catch { }
  }
}

loadEnvFile();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const tenantSlug = process.argv[2] || 'skinome';
const since = process.argv[3] || '2025-01-01';
const until = process.argv[4] || '2025-01-31';

async function main() {
  console.log(`🔍 Debugging recalculate bug for ${tenantSlug}`);
  console.log(`   Period: ${since} to ${until}\n`);

  // Resolve tenant ID
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', tenantSlug)
    .single();

  if (!tenant) {
    console.error(`Tenant not found: ${tenantSlug}`);
    process.exit(1);
  }

  const tenantId = tenant.id;
  console.log(`✅ Tenant ID: ${tenantId}\n`);

  // Fetch orders from database
  console.log('📥 Fetching orders from shopify_orders...');
  const { data: orders } = await supabase
    .from('shopify_orders')
    .select('order_id, customer_id, created_at, processed_at, currency, financial_status, is_refund')
    .eq('tenant_id', tenantId)
    .gte('created_at', since)
    .lte('created_at', until + 'T23:59:59')
    .order('created_at', { ascending: true })
    .limit(100); // Start with 100 orders for debugging

  if (!orders || orders.length === 0) {
    console.error('No orders found');
    process.exit(1);
  }

  console.log(`✅ Found ${orders.length} orders\n`);

  // Fetch transactions for these orders
  const orderIds = orders.map(o => o.order_id);
  console.log('📥 Fetching transactions...');
  const { data: transactions } = await supabase
    .from('shopify_sales_transactions')
    .select('shopify_order_id, event_type, event_date, gross_sales, discounts, returns, tax, currency')
    .eq('tenant_id', tenantId)
    .in('shopify_order_id', orderIds);

  if (!transactions) {
    console.error('No transactions found');
    process.exit(1);
  }

  console.log(`✅ Found ${transactions.length} transactions\n`);

  // Group transactions by order
  const txByOrder = new Map<string, typeof transactions>();
  for (const tx of transactions) {
    let key = tx.shopify_order_id?.toString() || '';
    if (key.startsWith('gid://shopify/Order/')) {
      key = key.replace('gid://shopify/Order/', '');
    }
    if (!key) continue;
    if (!txByOrder.has(key)) txByOrder.set(key, []);
    txByOrder.get(key)!.push(tx);
  }

  // Analyze orders and their transactions
  console.log('📊 Analyzing orders and transactions...\n');
  
  let totalNetSales = 0;
  let ordersWithoutTransactions = 0;
  let ordersWithTransactionsOutsidePeriod = 0;
  let ordersWithMultipleCurrencies = 0;
  let ordersWithTestFlag = 0;

  const sampleOrders: any[] = [];

  for (const order of orders.slice(0, 10)) { // Analyze first 10 orders
    const orderId = order.order_id.toString();
    const orderTx = txByOrder.get(orderId) || [];
    
    let orderNetSales = 0;
    let totalGrossSales = 0;
    let totalDiscounts = 0;
    let totalReturns = 0;
    let totalTax = 0;
    const currencies = new Set<string>();

    for (const tx of orderTx) {
      if (tx.event_type === 'SALE') {
        totalGrossSales += parseFloat(String(tx.gross_sales || 0));
        totalDiscounts += parseFloat(String(tx.discounts || 0));
        totalTax += parseFloat(String(tx.tax || 0));
        if (tx.currency) currencies.add(tx.currency);
      } else if (tx.event_type === 'RETURN') {
        totalReturns += parseFloat(String(tx.returns || 0));
      }
    }

    orderNetSales = totalGrossSales - totalDiscounts - totalTax - totalReturns;
    totalNetSales += orderNetSales;

    const txInPeriod = orderTx.filter(tx => {
      const txDate = tx.event_date;
      return txDate >= since && txDate <= until;
    });

    if (orderTx.length === 0) {
      ordersWithoutTransactions++;
    } else if (txInPeriod.length < orderTx.length) {
      ordersWithTransactionsOutsidePeriod++;
    }

    if (currencies.size > 1) {
      ordersWithMultipleCurrencies++;
    }

    sampleOrders.push({
      order_id: orderId,
      created_at: order.created_at,
      currency: order.currency,
      transactions_count: orderTx.length,
      transactions_in_period: txInPeriod.length,
      net_sales: orderNetSales,
      gross_sales: totalGrossSales,
      discounts: totalDiscounts,
      tax: totalTax,
      returns: totalReturns,
      currencies: Array.from(currencies),
      is_refund: order.is_refund,
      financial_status: order.financial_status,
    });
  }

  console.log('📊 Summary:');
  console.log(`   Total orders analyzed: ${orders.length}`);
  console.log(`   Orders without transactions: ${ordersWithoutTransactions}`);
  console.log(`   Orders with transactions outside period: ${ordersWithTransactionsOutsidePeriod}`);
  console.log(`   Orders with multiple currencies: ${ordersWithMultipleCurrencies}`);
  console.log(`   Total net sales (first 10 orders): ${totalNetSales.toFixed(2)}\n`);

  console.log('📋 Sample orders:');
  for (const order of sampleOrders) {
    console.log(`\n   Order ${order.order_id}:`);
    console.log(`      Created: ${order.created_at}`);
    console.log(`      Currency: ${order.currency}`);
    console.log(`      Transactions: ${order.transactions_count} (${order.transactions_in_period} in period)`);
    console.log(`      Net Sales: ${order.net_sales.toFixed(2)}`);
    console.log(`      Gross: ${order.gross_sales.toFixed(2)}, Discounts: ${order.discounts.toFixed(2)}, Tax: ${order.tax.toFixed(2)}, Returns: ${order.returns.toFixed(2)}`);
    console.log(`      Currencies: ${order.currencies.join(', ')}`);
    console.log(`      Is Refund: ${order.is_refund}, Status: ${order.financial_status}`);
  }

  // Check for currency issues
  console.log('\n💰 Currency analysis:');
  const currencyCounts = new Map<string, number>();
  for (const order of orders) {
    const currency = order.currency || 'NULL';
    currencyCounts.set(currency, (currencyCounts.get(currency) || 0) + 1);
  }
  for (const [currency, count] of Array.from(currencyCounts.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${currency}: ${count} orders`);
  }

  // Check for test orders
  console.log('\n🧪 Test order analysis:');
  const { data: testOrders } = await supabase
    .from('shopify_orders')
    .select('order_id, created_at, currency, financial_status')
    .eq('tenant_id', tenantId)
    .gte('created_at', since)
    .lte('created_at', until + 'T23:59:59')
    .eq('financial_status', 'pending'); // Test orders often have pending status

  console.log(`   Orders with pending status: ${testOrders?.length || 0}`);

  // Check transaction totals
  console.log('\n💳 Transaction totals:');
  let totalGrossFromTx = 0;
  let totalDiscountsFromTx = 0;
  let totalTaxFromTx = 0;
  let totalReturnsFromTx = 0;
  
  for (const tx of transactions) {
    if (tx.event_type === 'SALE') {
      totalGrossFromTx += parseFloat(String(tx.gross_sales || 0));
      totalDiscountsFromTx += parseFloat(String(tx.discounts || 0));
      totalTaxFromTx += parseFloat(String(tx.tax || 0));
    } else if (tx.event_type === 'RETURN') {
      totalReturnsFromTx += parseFloat(String(tx.returns || 0));
    }
  }

  const netFromTx = totalGrossFromTx - totalDiscountsFromTx - totalTaxFromTx - totalReturnsFromTx;
  console.log(`   Total Gross: ${totalGrossFromTx.toFixed(2)}`);
  console.log(`   Total Discounts: ${totalDiscountsFromTx.toFixed(2)}`);
  console.log(`   Total Tax: ${totalTaxFromTx.toFixed(2)}`);
  console.log(`   Total Returns: ${totalReturnsFromTx.toFixed(2)}`);
  console.log(`   Net Sales: ${netFromTx.toFixed(2)}`);

  // Expected from Shopify Analytics
  console.log('\n📊 Expected values (from user):');
  console.log(`   Total Net Sales: 2,510,186.09 kr`);
  console.log(`   New Customer: 719,001.54 kr`);
  console.log(`   Returning: 1,791,184.55 kr`);
  console.log(`\n   Calculated Net Sales: ${netFromTx.toFixed(2)}`);
  console.log(`   Difference: ${((netFromTx - 2510186.09) / 2510186.09 * 100).toFixed(2)}%`);
}

main().catch(console.error);

