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
  
  const { data: orders, error } = await supabase
    .from('shopify_orders')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('processed_at', '2025-11-17')
    .limit(10);

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log('=== PRICE BREAKDOWN ANALYSIS ===\n');
  console.log('Sample orders (first 10):\n');
  
  orders.forEach((order, i) => {
    const o = order as any;
    const totalPrice = parseFloat(o.total_price || 0);
    const totalTax = parseFloat(o.total_tax || 0);
    const grossSales = parseFloat(o.gross_sales || 0);
    const discountTotal = parseFloat(o.discount_total || 0);
    
    console.log(`Order ${i + 1} (${o.order_id}):`);
    console.log(`  total_price: ${totalPrice.toFixed(2)} kr`);
    console.log(`  total_tax: ${totalTax.toFixed(2)} kr`);
    console.log(`  discount_total: ${discountTotal.toFixed(2)} kr`);
    console.log(`  gross_sales (calculated): ${grossSales.toFixed(2)} kr`);
    console.log(`  total_price - total_tax = ${(totalPrice - totalTax).toFixed(2)} kr`);
    console.log(`  Difference: ${(grossSales - (totalPrice - totalTax)).toFixed(2)} kr`);
    console.log('');
  });

  // Expected from Shopify Finance
  const expectedGross = 108958.02;
  const validStatuses = new Set(['paid', 'partially_paid', 'partially_refunded', 'refunded']);
  const validOrders = orders.filter(o => validStatuses.has((o as any).financial_status || ''));
  
  const currentGross = validOrders.reduce((sum, o) => sum + parseFloat((o as any).gross_sales || 0), 0);
  const currentTotalPrice = validOrders.reduce((sum, o) => sum + parseFloat((o as any).total_price || 0), 0);
  const currentTotalTax = validOrders.reduce((sum, o) => sum + parseFloat((o as any).total_tax || 0), 0);
  
  console.log('=== SUMMARY ===\n');
  console.log(`Total orders (valid status): ${validOrders.length}`);
  console.log(`Sum of total_price: ${currentTotalPrice.toFixed(2)} kr`);
  console.log(`Sum of total_tax: ${currentTotalTax.toFixed(2)} kr`);
  console.log(`Sum of total_price - total_tax: ${(currentTotalPrice - currentTotalTax).toFixed(2)} kr`);
  console.log(`Sum of gross_sales (current): ${currentGross.toFixed(2)} kr`);
  console.log(`Expected Gross Sales: ${expectedGross.toFixed(2)} kr`);
  console.log(`\nDiff (gross_sales vs expected): ${(currentGross - expectedGross).toFixed(2)} kr`);
  console.log(`Diff (total_price - tax vs expected): ${((currentTotalPrice - currentTotalTax) - expectedGross).toFixed(2)} kr`);
  console.log(`\nHypothesis:`);
  console.log(`  If total_price already excludes tax, we should use total_price directly`);
  console.log(`  If total_price includes tax, we should use total_price - total_tax`);
  console.log(`  The difference between our gross and expected is: ${(currentGross - expectedGross).toFixed(2)} kr`);
  console.log(`  If we used total_price directly: ${(currentTotalPrice - expectedGross).toFixed(2)} kr difference`);
}

check();

