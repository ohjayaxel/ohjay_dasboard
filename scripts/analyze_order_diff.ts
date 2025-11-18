#!/usr/bin/env -S tsx

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

async function analyze() {
  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0';
  
  // Get all orders for Nov 17
  const { data: orders, error } = await supabase
    .from('shopify_orders')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('processed_at', '2025-11-17')
    .order('gross_sales', { ascending: false });

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log(`Total orders: ${orders.length}\n`);

  // Expected totals
  const expected = {
    gross: 108958.02,
    discount: 18885.13, // Note: Shopify shows as negative
    refund: 3938.15,    // Note: Shopify shows as negative
    net: 86134.74,
  };

  // Current totals
  const validStatuses = new Set(['paid', 'partially_paid', 'partially_refunded', 'refunded']);
  const validOrders = orders.filter(o => validStatuses.has((o as any).financial_status || ''));
  
  const current = {
    gross: validOrders.reduce((sum, o) => sum + parseFloat((o as any).gross_sales || 0), 0),
    discount: validOrders.reduce((sum, o) => sum + parseFloat((o as any).discount_total || 0), 0),
    refund: validOrders.reduce((sum, o) => sum + parseFloat((o as any).total_refunds || 0), 0),
    net: validOrders.reduce((sum, o) => sum + parseFloat((o as any).net_sales || 0), 0),
  };

  const diff = {
    gross: current.gross - expected.gross,
    discount: current.discount - expected.discount,
    refund: current.refund - expected.refund,
    net: current.net - expected.net,
  };

  console.log('=== DIFF ANALYSIS ===\n');
  console.log(`Gross Sales diff: ${diff.gross.toFixed(2)} kr`);
  console.log(`Discounts diff: ${diff.discount.toFixed(2)} kr`);
  console.log(`Refunds diff: ${diff.refund.toFixed(2)} kr`);
  console.log(`Net Sales diff: ${diff.net.toFixed(2)} kr\n`);

  // Analyze by different dimensions
  console.log('=== TOP 20 ORDERS BY GROSS SALES ===\n');
  validOrders.slice(0, 20).forEach((order, i) => {
    const o = order as any;
    console.log(`${i + 1}. Order ${o.order_id}:`);
    console.log(`   Gross: ${parseFloat(o.gross_sales || 0).toFixed(2)} kr`);
    console.log(`   Discount: ${parseFloat(o.discount_total || 0).toFixed(2)} kr`);
    console.log(`   Net: ${parseFloat(o.net_sales || 0).toFixed(2)} kr`);
    console.log(`   Status: ${o.financial_status || 'unknown'}`);
    console.log(`   Customer: ${o.customer_id || 'none'}`);
    console.log('');
  });

  // Group by customer_id to see if one customer has many orders
  const byCustomer: Record<string, { count: number; gross: number; net: number }> = {};
  validOrders.forEach(order => {
    const o = order as any;
    const customerId = o.customer_id || 'null';
    if (!byCustomer[customerId]) {
      byCustomer[customerId] = { count: 0, gross: 0, net: 0 };
    }
    byCustomer[customerId].count++;
    byCustomer[customerId].gross += parseFloat(o.gross_sales || 0);
    byCustomer[customerId].net += parseFloat(o.net_sales || 0);
  });

  console.log('=== TOP 10 CUSTOMERS BY GROSS SALES ===\n');
  Object.entries(byCustomer)
    .sort((a, b) => b[1].gross - a[1].gross)
    .slice(0, 10)
    .forEach(([customerId, data]) => {
      console.log(`Customer ${customerId}:`);
      console.log(`  Orders: ${data.count}`);
      console.log(`  Gross Sales: ${data.gross.toFixed(2)} kr`);
      console.log(`  Net Sales: ${data.net.toFixed(2)} kr`);
      console.log('');
    });

  // Check if we have too many small orders
  const smallOrders = validOrders.filter(o => parseFloat((o as any).gross_sales || 0) < 100);
  const smallOrdersTotal = smallOrders.reduce((sum, o) => sum + parseFloat((o as any).gross_sales || 0), 0);
  
  console.log(`\n=== SMALL ORDERS ANALYSIS (< 100 kr) ===`);
  console.log(`Count: ${smallOrders.length}`);
  console.log(`Total Gross Sales: ${smallOrdersTotal.toFixed(2)} kr`);
  console.log(`Average: ${(smallOrdersTotal / smallOrders.length).toFixed(2)} kr\n`);

  // Check if we have any test orders or patterns
  const highValueOrders = validOrders.filter(o => parseFloat((o as any).gross_sales || 0) > 1000);
  console.log(`\n=== HIGH VALUE ORDERS (> 1000 kr) ===`);
  console.log(`Count: ${highValueOrders.length}`);
  console.log(`Total Gross Sales: ${highValueOrders.reduce((sum, o) => sum + parseFloat((o as any).gross_sales || 0), 0).toFixed(2)} kr\n`);

  // Summary statistics
  const orderCounts = {
    total: orders.length,
    valid: validOrders.length,
    paid: orders.filter(o => (o as any).financial_status === 'paid').length,
    refunded: orders.filter(o => (o as any).financial_status === 'refunded').length,
    unknown: orders.filter(o => !(o as any).financial_status || (o as any).financial_status === 'unknown').length,
  };

  console.log('=== ORDER STATUS BREAKDOWN ===\n');
  console.log(`Total orders: ${orderCounts.total}`);
  console.log(`Valid financial_status: ${orderCounts.valid}`);
  console.log(`  - Paid: ${orderCounts.paid}`);
  console.log(`  - Refunded: ${orderCounts.refunded}`);
  console.log(`Unknown/invalid status: ${orderCounts.unknown}\n`);

  // Calculate what we need to exclude to match Shopify
  console.log('=== TO MATCH SHOPIFY, WE NEED TO EXCLUDE ===\n');
  console.log(`Gross Sales: ${diff.gross.toFixed(2)} kr`);
  console.log(`Net Sales: ${diff.net.toFixed(2)} kr`);
  console.log(`\nThat's approximately ${Math.round(diff.gross / (current.gross / validOrders.length))} orders`);
  console.log(`(assuming average order value of ${(current.gross / validOrders.length).toFixed(2)} kr)`);
}

analyze();

