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

  const validStatuses = new Set(['paid', 'partially_paid', 'partially_refunded', 'refunded']);
  const validOrders = orders.filter(o => validStatuses.has((o as any).financial_status || ''));

  const expectedGross = 108958.02;
  let cumulativeGross = 0;
  const includedOrders: any[] = [];
  const excludedOrders: any[] = [];

  // Find which orders to include to match Shopify Finance
  for (const order of validOrders) {
    const gross = parseFloat((order as any).gross_sales || 0);
    
    if (cumulativeGross < expectedGross) {
      cumulativeGross += gross;
      includedOrders.push(order);
    } else {
      excludedOrders.push(order);
    }
  }

  // Focus on web orders
  const webOrders = validOrders.filter(o => (o as any).source_name === 'web');
  const excludedWebOrders = excludedOrders.filter(o => (o as any).source_name === 'web');
  const includedWebOrders = includedOrders.filter(o => (o as any).source_name === 'web');

  console.log('=== WEB ORDERS ANALYSIS ===\n');
  console.log(`Total web orders: ${webOrders.length}`);
  console.log(`Included: ${includedWebOrders.length}`);
  console.log(`Excluded: ${excludedWebOrders.length}\n`);

  // Sort excluded web orders by value
  const excludedWebSorted = [...excludedWebOrders].sort((a, b) => 
    parseFloat((b as any).gross_sales || 0) - parseFloat((a as any).gross_sales || 0)
  );

  console.log('=== EXCLUDED WEB ORDERS (sorted by gross sales) ===\n');
  excludedWebSorted.forEach((order, i) => {
    const o = order as any;
    console.log(`${i + 1}. Order ${o.order_id}:`);
    console.log(`   Gross: ${parseFloat(o.gross_sales || 0).toFixed(2)} kr`);
    console.log(`   Net: ${parseFloat(o.net_sales || 0).toFixed(2)} kr`);
    console.log(`   Discount: ${parseFloat(o.discount_total || 0).toFixed(2)} kr`);
    console.log(`   Fulfillment: ${o.fulfillment_status || 'null'}`);
    console.log(`   Customer: ${o.customer_id || 'none'}`);
    console.log('');
  });

  // Compare value ranges
  const excludedWebValues = excludedWebSorted.map(o => parseFloat((o as any).gross_sales || 0));
  const includedWebValues = includedWebOrders.map(o => parseFloat((o as any).gross_sales || 0));

  console.log('=== VALUE RANGE COMPARISON ===\n');
  console.log('Excluded web orders:');
  console.log(`  Min: ${Math.min(...excludedWebValues).toFixed(2)} kr`);
  console.log(`  Max: ${Math.max(...excludedWebValues).toFixed(2)} kr`);
  console.log(`  Avg: ${(excludedWebValues.reduce((a, b) => a + b, 0) / excludedWebValues.length).toFixed(2)} kr`);
  console.log(`  Median: ${excludedWebValues.sort((a, b) => a - b)[Math.floor(excludedWebValues.length / 2)].toFixed(2)} kr`);
  
  console.log('\nIncluded web orders:');
  console.log(`  Min: ${Math.min(...includedWebValues).toFixed(2)} kr`);
  console.log(`  Max: ${Math.max(...includedWebValues).toFixed(2)} kr`);
  console.log(`  Avg: ${(includedWebValues.reduce((a, b) => a + b, 0) / includedWebValues.length).toFixed(2)} kr`);
  console.log(`  Median: ${includedWebValues.sort((a, b) => a - b)[Math.floor(includedWebValues.length / 2)].toFixed(2)} kr`);

  // Check if there's a clear cutoff
  const smallestIncludedWeb = Math.min(...includedWebValues);
  const largestExcludedWeb = Math.max(...excludedWebValues);
  
  console.log('\n=== CUTOFF ANALYSIS ===');
  console.log(`Smallest included web order: ${smallestIncludedWeb.toFixed(2)} kr`);
  console.log(`Largest excluded web order: ${largestExcludedWeb.toFixed(2)} kr`);
  
  if (largestExcludedWeb < smallestIncludedWeb) {
    console.log(`\n✅ Clear cutoff! All excluded web orders are below ${smallestIncludedWeb.toFixed(2)} kr`);
  } else {
    console.log(`\n⚠️  No clear cutoff - some excluded web orders are larger than included ones`);
    console.log(`   This suggests filtering is not based on order value alone`);
    
    // Show overlapping orders
    const overlapping = excludedWebOrders.filter(o => 
      parseFloat((o as any).gross_sales || 0) >= smallestIncludedWeb
    );
    console.log(`\n   Overlapping orders (excluded but >= smallest included): ${overlapping.length}`);
    overlapping.forEach(o => {
      const order = o as any;
      console.log(`     Order ${order.order_id}: ${parseFloat(order.gross_sales || 0).toFixed(2)} kr`);
    });
  }

  // Check if all excluded web orders share any other attribute
  console.log('\n=== FULFILLMENT STATUS OF EXCLUDED WEB ORDERS ===');
  const excludedWebFulfillment: Record<string, number> = {};
  excludedWebOrders.forEach(o => {
    const status = (o as any).fulfillment_status || 'null';
    excludedWebFulfillment[status] = (excludedWebFulfillment[status] || 0) + 1;
  });
  Object.entries(excludedWebFulfillment).forEach(([status, count]) => {
    console.log(`  ${status || 'null'}: ${count} orders`);
  });
}

analyze();

