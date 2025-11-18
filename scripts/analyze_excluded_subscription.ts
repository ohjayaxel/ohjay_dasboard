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

  // Focus on subscription orders
  const subscriptionOrders = validOrders.filter(o => (o as any).source_name === 'subscription_contract_checkout_one');
  const excludedSubOrders = excludedOrders.filter(o => (o as any).source_name === 'subscription_contract_checkout_one');
  const includedSubOrders = includedOrders.filter(o => (o as any).source_name === 'subscription_contract_checkout_one');

  console.log('=== SUBSCRIPTION ORDERS ANALYSIS ===\n');
  console.log(`Total subscription orders: ${subscriptionOrders.length}`);
  console.log(`Included: ${includedSubOrders.length}`);
  console.log(`Excluded: ${excludedSubOrders.length}\n`);

  // Sort excluded subscription orders by value
  const excludedSubSorted = [...excludedSubOrders].sort((a, b) => 
    parseFloat((b as any).gross_sales || 0) - parseFloat((a as any).gross_sales || 0)
  );

  console.log('=== EXCLUDED SUBSCRIPTION ORDERS (sorted by gross sales) ===\n');
  excludedSubSorted.forEach((order, i) => {
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
  const excludedSubValues = excludedSubSorted.map(o => parseFloat((o as any).gross_sales || 0));
  const includedSubValues = includedSubOrders.map(o => parseFloat((o as any).gross_sales || 0));

  console.log('=== VALUE RANGE COMPARISON ===\n');
  console.log('Excluded subscription orders:');
  console.log(`  Min: ${Math.min(...excludedSubValues).toFixed(2)} kr`);
  console.log(`  Max: ${Math.max(...excludedSubValues).toFixed(2)} kr`);
  console.log(`  Avg: ${(excludedSubValues.reduce((a, b) => a + b, 0) / excludedSubValues.length).toFixed(2)} kr`);
  if (excludedSubValues.length > 0) {
    const sorted = excludedSubValues.sort((a, b) => a - b);
    console.log(`  Median: ${sorted[Math.floor(sorted.length / 2)].toFixed(2)} kr`);
  }
  
  console.log('\nIncluded subscription orders:');
  console.log(`  Min: ${Math.min(...includedSubValues).toFixed(2)} kr`);
  console.log(`  Max: ${Math.max(...includedSubValues).toFixed(2)} kr`);
  console.log(`  Avg: ${(includedSubValues.reduce((a, b) => a + b, 0) / includedSubValues.length).toFixed(2)} kr`);
  if (includedSubValues.length > 0) {
    const sorted = includedSubValues.sort((a, b) => a - b);
    console.log(`  Median: ${sorted[Math.floor(sorted.length / 2)].toFixed(2)} kr`);
  }

  // Check if there's a clear cutoff
  if (excludedSubValues.length > 0 && includedSubValues.length > 0) {
    const smallestIncludedSub = Math.min(...includedSubValues);
    const largestExcludedSub = Math.max(...excludedSubValues);
    
    console.log('\n=== CUTOFF ANALYSIS ===');
    console.log(`Smallest included subscription order: ${smallestIncludedSub.toFixed(2)} kr`);
    console.log(`Largest excluded subscription order: ${largestExcludedSub.toFixed(2)} kr`);
    
    if (largestExcludedSub < smallestIncludedSub) {
      console.log(`\n✅ Clear cutoff! All excluded subscription orders are below ${smallestIncludedSub.toFixed(2)} kr`);
    } else {
      console.log(`\n⚠️  No clear cutoff - some excluded subscription orders are larger than included ones`);
      console.log(`   This suggests filtering is not based on order value alone`);
      
      // Show overlapping orders
      const overlapping = excludedSubOrders.filter(o => 
        parseFloat((o as any).gross_sales || 0) >= smallestIncludedSub
      );
      console.log(`\n   Overlapping orders (excluded but >= smallest included): ${overlapping.length}`);
      overlapping.forEach(o => {
        const order = o as any;
        console.log(`     Order ${order.order_id}: ${parseFloat(order.gross_sales || 0).toFixed(2)} kr`);
      });
    }
  }

  // Summary
  console.log('\n=== SUMMARY ===\n');
  console.log(`Web orders cutoff: ~479 kr (excludes orders below this)`);
  console.log(`Subscription orders: ${excludedSubOrders.length} excluded out of ${subscriptionOrders.length} total`);
  if (excludedSubValues.length > 0 && includedSubValues.length > 0) {
    const smallestIncludedSub = Math.min(...includedSubValues);
    const largestExcludedSub = Math.max(...excludedSubValues);
    if (largestExcludedSub < smallestIncludedSub) {
      console.log(`Subscription orders cutoff: ~${smallestIncludedSub.toFixed(2)} kr (excludes orders below this)`);
    }
  }
}

analyze();

