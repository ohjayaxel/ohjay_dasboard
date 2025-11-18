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

  console.log(`Total orders: ${orders.length}`);
  
  // Group by financial_status
  const byStatus: Record<string, {
    count: number;
    gross: number;
    net: number;
    discount: number;
    refund: number;
  }> = {};
  
  orders.forEach(order => {
    const status = (order as any).financial_status || 'unknown';
    if (!byStatus[status]) {
      byStatus[status] = { count: 0, gross: 0, net: 0, discount: 0, refund: 0 };
    }
    byStatus[status].count++;
    byStatus[status].gross += parseFloat((order as any).gross_sales || '0');
    byStatus[status].net += parseFloat((order as any).net_sales || '0');
    byStatus[status].discount += parseFloat((order as any).discount_total || '0');
    byStatus[status].refund += parseFloat((order as any).total_refunds || '0');
  });

  console.log('\nBy financial_status:');
  Object.entries(byStatus).forEach(([status, data]) => {
    console.log(`\n${status}:`);
    console.log(`  Count: ${data.count}`);
    console.log(`  Gross Sales: ${data.gross.toFixed(2)} kr`);
    console.log(`  Discounts: ${data.discount.toFixed(2)} kr`);
    console.log(`  Refunds: ${data.refund.toFixed(2)} kr`);
    console.log(`  Net Sales: ${data.net.toFixed(2)} kr`);
  });

  // Valid statuses only (as per calculateShopifyLikeSales)
  const validStatuses = new Set(['paid', 'partially_paid', 'partially_refunded', 'refunded']);
  const validOrders = orders.filter(o => validStatuses.has((o as any).financial_status || ''));
  
  const validTotal = {
    gross: validOrders.reduce((sum, o) => sum + parseFloat((o as any).gross_sales || '0'), 0),
    discount: validOrders.reduce((sum, o) => sum + parseFloat((o as any).discount_total || '0'), 0),
    refund: validOrders.reduce((sum, o) => sum + parseFloat((o as any).total_refunds || '0'), 0),
    net: validOrders.reduce((sum, o) => sum + parseFloat((o as any).net_sales || '0'), 0),
  };

  // Total
  const total = {
    gross: orders.reduce((sum, o) => sum + parseFloat((o as any).gross_sales || '0'), 0),
    discount: orders.reduce((sum, o) => sum + parseFloat((o as any).discount_total || '0'), 0),
    refund: orders.reduce((sum, o) => sum + parseFloat((o as any).total_refunds || '0'), 0),
    net: orders.reduce((sum, o) => sum + parseFloat((o as any).net_sales || '0'), 0),
  };

  console.log('\n=== TOTAL (All Orders) ===');
  console.log(`Gross Sales: ${total.gross.toFixed(2)} kr`);
  console.log(`Discounts: ${total.discount.toFixed(2)} kr`);
  console.log(`Refunds: ${total.refund.toFixed(2)} kr`);
  console.log(`Net Sales: ${total.net.toFixed(2)} kr`);
  
  console.log('\n=== VALID FINANCIAL STATUS ONLY ===');
  console.log(`Orders: ${validOrders.length}`);
  console.log(`Gross Sales: ${validTotal.gross.toFixed(2)} kr`);
  console.log(`Discounts: ${validTotal.discount.toFixed(2)} kr`);
  console.log(`Refunds: ${validTotal.refund.toFixed(2)} kr`);
  console.log(`Net Sales: ${validTotal.net.toFixed(2)} kr`);
  
  console.log('\n=== EXPECTED (from Shopify Finance Report) ===');
  console.log(`Gross Sales: 108958.02 kr`);
  console.log(`Discounts: -18885.13 kr`);
  console.log(`Refunds: -3938.15 kr`);
  console.log(`Net Sales: 86134.74 kr`);
  
  console.log('\n=== DIFF ===');
  console.log(`Gross Sales: ${(validTotal.gross - 108958.02).toFixed(2)} kr`);
  console.log(`Discounts: ${(validTotal.discount - (-18885.13)).toFixed(2)} kr`);
  console.log(`Refunds: ${(validTotal.refund - (-3938.15)).toFixed(2)} kr`);
  console.log(`Net Sales: ${(validTotal.net - 86134.74).toFixed(2)} kr`);
}

check();

