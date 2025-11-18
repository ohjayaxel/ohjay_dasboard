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

async function test() {
  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0';
  
  // We need to fetch from Shopify API to get subtotal_price
  // But let's check what we have in DB first
  const { data: orders, error } = await supabase
    .from('shopify_orders')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('processed_at', '2025-11-17');

  if (error) {
    console.error('Error:', error);
    return;
  }

  const validStatuses = new Set(['paid', 'partially_paid', 'partially_refunded', 'refunded']);
  const validOrders = orders.filter(o => validStatuses.has((o as any).financial_status || ''));

  const expected = {
    gross: 108958.02,
    discount: 18885.13,
    refund: 3938.15,
    net: 86134.74,
  };

  console.log('=== CURRENT CALCULATION (total_price - total_tax) ===');
  const currentGross = validOrders.reduce((sum, o) => sum + parseFloat((o as any).gross_sales || 0), 0);
  const currentDiscount = validOrders.reduce((sum, o) => sum + parseFloat((o as any).discount_total || 0), 0);
  const currentRefund = validOrders.reduce((sum, o) => sum + parseFloat((o as any).total_refunds || 0), 0);
  const currentNet = validOrders.reduce((sum, o) => sum + parseFloat((o as any).net_sales || 0), 0);
  
  console.log(`Gross Sales: ${currentGross.toFixed(2)} kr`);
  console.log(`Discounts: ${currentDiscount.toFixed(2)} kr`);
  console.log(`Returns: ${currentRefund.toFixed(2)} kr`);
  console.log(`Net Sales: ${currentNet.toFixed(2)} kr`);
  
  console.log('\n=== EXPECTED (Shopify Finance) ===');
  console.log(`Gross Sales: ${expected.gross.toFixed(2)} kr`);
  console.log(`Discounts: ${expected.discount.toFixed(2)} kr`);
  console.log(`Returns: ${expected.refund.toFixed(2)} kr`);
  console.log(`Net Sales: ${expected.net.toFixed(2)} kr`);
  
  console.log('\n=== DIFF ===');
  console.log(`Gross: ${(currentGross - expected.gross).toFixed(2)} kr`);
  console.log(`Discount: ${(currentDiscount - expected.discount).toFixed(2)} kr`);
  console.log(`Refund: ${(currentRefund - expected.refund).toFixed(2)} kr`);
  console.log(`Net: ${(currentNet - expected.net).toFixed(2)} kr`);
  
  console.log('\n=== ANALYSIS ===');
  console.log('If we used line_items approach (from before):');
  console.log('  We got ~108,775 kr which was much closer (-182 kr diff)');
  console.log('  That suggests line_items is the correct way');
  console.log('\nProblem with total_price - total_tax:');
  console.log('  - total_price is AFTER discounts');
  console.log('  - Shopify Finance Gross Sales = sum of line_items BEFORE discounts');
  console.log('\nSolution:');
  console.log('  - gross_sales = sum(line_items.price × quantity) (already without tax)');
  console.log('  - OR: subtotal_price (if we had it, which is products before discounts, without tax)');
}

test();

