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
  
  // Get all orders for Nov 17
  const { data: orders, error } = await supabase
    .from('shopify_orders')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('processed_at', '2025-11-17');

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log(`Total orders: ${orders.length}\n`);

  // We need to fetch from Shopify API to get total_tax
  // But let's first check what we have in our data
  
  // Expected from Shopify Finance
  const expected = {
    gross: 108958.02,
    discount: 18885.13,
    refund: 3938.15,
    net: 86134.74,
    tax: 21521.77, // From the image
  };

  console.log('=== EXPECTED (Shopify Finance Report) ===');
  console.log(`Gross Sales: ${expected.gross.toFixed(2)} kr`);
  console.log(`Discounts: ${expected.discount.toFixed(2)} kr`);
  console.log(`Returns: ${expected.refund.toFixed(2)} kr`);
  console.log(`Net Sales: ${expected.net.toFixed(2)} kr`);
  console.log(`Taxes: ${expected.tax.toFixed(2)} kr`);
  console.log(`\nNote: Gross Sales - Discounts - Returns = ${(expected.gross - expected.discount - expected.refund).toFixed(2)} kr`);
  console.log(`This matches Net Sales: ${expected.net.toFixed(2)} kr ✓\n`);

  // Our current calculation
  const validStatuses = new Set(['paid', 'partially_paid', 'partially_refunded', 'refunded']);
  const validOrders = orders.filter(o => validStatuses.has((o as any).financial_status || ''));
  
  const current = {
    gross: validOrders.reduce((sum, o) => sum + parseFloat((o as any).gross_sales || 0), 0),
    discount: validOrders.reduce((sum, o) => sum + parseFloat((o as any).discount_total || 0), 0),
    refund: validOrders.reduce((sum, o) => sum + parseFloat((o as any).total_refunds || 0), 0),
    net: validOrders.reduce((sum, o) => sum + parseFloat((o as any).net_sales || 0), 0),
  };

  console.log('=== CURRENT (Our Calculation) ===');
  console.log(`Gross Sales: ${current.gross.toFixed(2)} kr`);
  console.log(`Discounts: ${current.discount.toFixed(2)} kr`);
  console.log(`Returns: ${current.refund.toFixed(2)} kr`);
  console.log(`Net Sales: ${current.net.toFixed(2)} kr`);
  console.log(`\nGross Sales - Discounts - Returns = ${(current.gross - current.discount - current.refund).toFixed(2)} kr`);
  console.log(`This matches Net Sales: ${current.net.toFixed(2)} kr ✓\n`);

  console.log('=== DIFF ===');
  console.log(`Gross Sales diff: ${(current.gross - expected.gross).toFixed(2)} kr`);
  console.log(`Net Sales diff: ${(current.net - expected.net).toFixed(2)} kr\n`);

  console.log('=== ANALYSIS ===');
  console.log('If Shopify Finance excludes tax from calculations:');
  console.log(`  We need to subtract ~${(current.gross - expected.gross).toFixed(2)} kr from Gross Sales`);
  console.log(`  Expected tax (from image): ${expected.tax.toFixed(2)} kr`);
  console.log(`  Difference between our gross and expected: ${(current.gross - expected.gross).toFixed(2)} kr`);
  console.log(`  Difference between our net and expected: ${(current.net - expected.net).toFixed(2)} kr\n`);
  
  console.log('Next step: Fetch total_tax from Shopify API to verify this hypothesis.');
}

check();

