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

async function check() {
  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0';
  
  // Get raw order data from Shopify API to check for additional fields
  // For now, let's check what we have in the database
  
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

  // Check for any fields that might indicate filtered orders
  const validStatuses = new Set(['paid', 'partially_paid', 'partially_refunded', 'refunded']);
  const validOrders = orders.filter(o => validStatuses.has((o as any).financial_status || ''));

  // Group by various attributes to find patterns
  console.log('=== CHECKING FOR PATTERNS ===\n');

  // Check if we can see tags or source_name
  const ordersWithTags = validOrders.filter(o => (o as any).tags && Array.isArray((o as any).tags) && (o as any).tags.length > 0);
  const ordersWithSourceName = validOrders.filter(o => (o as any).source_name);

  console.log(`Orders with tags: ${ordersWithTags.length}`);
  if (ordersWithTags.length > 0) {
    const tagCounts: Record<string, number> = {};
    ordersWithTags.forEach(o => {
      const tags = (o as any).tags || [];
      tags.forEach((tag: string) => {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });
    });
    console.log('Tag distribution:');
    Object.entries(tagCounts).forEach(([tag, count]) => {
      console.log(`  ${tag}: ${count}`);
    });
  }

  console.log(`\nOrders with source_name: ${ordersWithSourceName.length}`);
  if (ordersWithSourceName.length > 0) {
    const sourceCounts: Record<string, number> = {};
    ordersWithSourceName.forEach(o => {
      const source = (o as any).source_name || 'unknown';
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    });
    console.log('Source distribution:');
    Object.entries(sourceCounts).forEach(([source, count]) => {
      console.log(`  ${source}: ${count}`);
    });
  }

  // Calculate cumulative totals to see where the "extra" orders are
  console.log('\n=== CUMULATIVE ANALYSIS ===');
  console.log('If we exclude top N orders, what totals do we get?\n');
  
  const sortedOrders = [...validOrders].sort((a, b) => 
    parseFloat((b as any).gross_sales || 0) - parseFloat((a as any).gross_sales || 0)
  );

  const expectedGross = 108958.02;
  let cumulativeGross = 0;
  
  for (let i = 0; i < sortedOrders.length; i++) {
    cumulativeGross += parseFloat((sortedOrders[i] as any).gross_sales || 0);
    
    if ((i + 1) % 10 === 0 || cumulativeGross >= expectedGross) {
      const remaining = sortedOrders.length - (i + 1);
      const diff = cumulativeGross - expectedGross;
      console.log(`Top ${i + 1} orders: ${cumulativeGross.toFixed(2)} kr (${diff > 0 ? '+' : ''}${diff.toFixed(2)} vs expected)`);
      
      if (cumulativeGross >= expectedGross) {
        console.log(`\n⚠️  We've reached expected gross sales after ${i + 1} orders!`);
        console.log(`   That means we have ${remaining} extra orders (${(remaining / sortedOrders.length * 100).toFixed(1)}%)`);
        break;
      }
    }
  }

  // Check if there are any orders with zero or very low values that might be test orders
  const zeroValueOrders = validOrders.filter(o => parseFloat((o as any).gross_sales || 0) === 0);
  const veryLowValueOrders = validOrders.filter(o => {
    const gross = parseFloat((o as any).gross_sales || 0);
    return gross > 0 && gross < 10;
  });

  console.log(`\n=== POTENTIALLY EXCLUDED ORDERS ===`);
  console.log(`Zero-value orders: ${zeroValueOrders.length}`);
  console.log(`Very low value orders (< 10 kr): ${veryLowValueOrders.length}`);
  
  if (veryLowValueOrders.length > 0) {
    console.log('\nVery low value orders:');
    veryLowValueOrders.forEach(o => {
      const order = o as any;
      console.log(`  Order ${order.order_id}: ${parseFloat(order.gross_sales || 0).toFixed(2)} kr`);
    });
  }
}

check();

