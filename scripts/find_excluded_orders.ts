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

async function findExcluded() {
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
  let includedOrders: any[] = [];
  let excludedOrders: any[] = [];

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

  console.log(`=== ORDERS INCLUDED IN SHOPIFY FINANCE (${includedOrders.length}) ===\n`);
  console.log(`Total Gross Sales: ${cumulativeGross.toFixed(2)} kr`);
  console.log(`Expected: ${expectedGross.toFixed(2)} kr`);
  console.log(`Diff: ${(cumulativeGross - expectedGross).toFixed(2)} kr\n`);

  console.log(`=== ORDERS EXCLUDED (${excludedOrders.length}) ===\n`);
  
  const excludedTotal = excludedOrders.reduce((sum, o) => sum + parseFloat((o as any).gross_sales || 0), 0);
  console.log(`Total Gross Sales: ${excludedTotal.toFixed(2)} kr`);
  console.log(`Average per order: ${(excludedTotal / excludedOrders.length).toFixed(2)} kr\n`);

  // Analyze excluded orders
  const excludedByValue = {
    under50: excludedOrders.filter(o => parseFloat((o as any).gross_sales || 0) < 50),
    under100: excludedOrders.filter(o => parseFloat((o as any).gross_sales || 0) < 100),
    under200: excludedOrders.filter(o => parseFloat((o as any).gross_sales || 0) < 200),
    over200: excludedOrders.filter(o => parseFloat((o as any).gross_sales || 0) >= 200),
  };

  console.log('=== EXCLUDED ORDERS BY VALUE RANGE ===\n');
  console.log(`Under 50 kr: ${excludedByValue.under50.length} orders`);
  console.log(`50-99 kr: ${excludedByValue.under100.length - excludedByValue.under50.length} orders`);
  console.log(`100-199 kr: ${excludedByValue.under200.length - excludedByValue.under100.length} orders`);
  console.log(`200+ kr: ${excludedByValue.over200.length} orders\n`);

  // Show distribution of excluded orders
  const excludedSorted = [...excludedOrders].sort((a, b) => 
    parseFloat((b as any).gross_sales || 0) - parseFloat((a as any).gross_sales || 0)
  );

  console.log('=== TOP 20 EXCLUDED ORDERS (by gross sales) ===\n');
  excludedSorted.slice(0, 20).forEach((order, i) => {
    const o = order as any;
    console.log(`${i + 1}. Order ${o.order_id}:`);
    console.log(`   Gross: ${parseFloat(o.gross_sales || 0).toFixed(2)} kr`);
    console.log(`   Net: ${parseFloat(o.net_sales || 0).toFixed(2)} kr`);
    console.log(`   Customer: ${o.customer_id || 'none'}`);
    console.log('');
  });

  console.log('=== BOTTOM 20 EXCLUDED ORDERS (by gross sales) ===\n');
  excludedSorted.slice(-20).forEach((order, i) => {
    const o = order as any;
    console.log(`${i + 1}. Order ${o.order_id}:`);
    console.log(`   Gross: ${parseFloat(o.gross_sales || 0).toFixed(2)} kr`);
    console.log(`   Net: ${parseFloat(o.net_sales || 0).toFixed(2)} kr`);
    console.log(`   Customer: ${o.customer_id || 'none'}`);
    console.log('');
  });

  // Check if there's a pattern - maybe all excluded are below a certain threshold?
  const includedMin = Math.min(...includedOrders.map(o => parseFloat((o as any).gross_sales || 0)));
  const excludedMax = Math.max(...excludedOrders.map(o => parseFloat((o as any).gross_sales || 0)));
  
  console.log(`=== THRESHOLD ANALYSIS ===\n`);
  console.log(`Smallest included order: ${includedMin.toFixed(2)} kr`);
  console.log(`Largest excluded order: ${excludedMax.toFixed(2)} kr`);
  
  if (excludedMax < includedMin) {
    console.log(`\n✅ Clear threshold! All excluded orders are below ${includedMin.toFixed(2)} kr`);
  } else {
    console.log(`\n⚠️  No clear threshold - some excluded orders are larger than included ones`);
    console.log(`   This suggests filtering is not just based on order value`);
  }
}

findExcluded();

