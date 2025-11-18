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
  
  // Group by financial_status AND fulfillment_status
  const byStatus: Record<string, {
    count: number;
    gross: number;
    net: number;
    discount: number;
    refund: number;
  }> = {};
  
  orders.forEach(order => {
    const o = order as any;
    const financialStatus = o.financial_status || 'unknown';
    const fulfillmentStatus = o.fulfillment_status || 'unknown';
    const status = `${financialStatus} / ${fulfillmentStatus}`;
    
    if (!byStatus[status]) {
      byStatus[status] = { count: 0, gross: 0, net: 0, discount: 0, refund: 0 };
    }
    byStatus[status].count++;
    byStatus[status].gross += parseFloat(o.gross_sales || 0);
    byStatus[status].net += parseFloat(o.net_sales || 0);
    byStatus[status].discount += parseFloat(o.discount_total || 0);
    byStatus[status].refund += parseFloat(o.total_refunds || 0);
  });

  console.log('\nBy financial_status / fulfillment_status:');
  Object.entries(byStatus)
    .sort((a, b) => b[1].gross - a[1].gross)
    .forEach(([status, data]) => {
      console.log(`\n${status}:`);
      console.log(`  Count: ${data.count}`);
      console.log(`  Gross Sales: ${data.gross.toFixed(2)} kr`);
      console.log(`  Discounts: ${data.discount.toFixed(2)} kr`);
      console.log(`  Refunds: ${data.refund.toFixed(2)} kr`);
      console.log(`  Net Sales: ${data.net.toFixed(2)} kr`);
    });

  // Try different filters
  const validFinancialStatuses = new Set(['paid', 'partially_paid', 'partially_refunded', 'refunded']);
  const validFulfillmentStatuses = new Set(['fulfilled', 'partial', 'unfulfilled', 'restocked', null]);
  
  // Only paid + fulfilled orders (most likely what Shopify Finance uses)
  const paidAndFulfilled = orders.filter(o => {
    const o_any = o as any;
    return validFinancialStatuses.has(o_any.financial_status) && 
           (o_any.fulfillment_status === 'fulfilled' || o_any.fulfillment_status === null || o_any.fulfillment_status === '');
  });
  
  const paidAndFulfilledTotal = {
    gross: paidAndFulfilled.reduce((sum, o) => sum + parseFloat((o as any).gross_sales || 0), 0),
    discount: paidAndFulfilled.reduce((sum, o) => sum + parseFloat((o as any).discount_total || 0), 0),
    refund: paidAndFulfilled.reduce((sum, o) => sum + parseFloat((o as any).total_refunds || 0), 0),
    net: paidAndFulfilled.reduce((sum, o) => sum + parseFloat((o as any).net_sales || 0), 0),
  };

  console.log('\n=== PAID + FULFILLED ORDERS ===');
  console.log(`Orders: ${paidAndFulfilled.length}`);
  console.log(`Gross Sales: ${paidAndFulfilledTotal.gross.toFixed(2)} kr`);
  console.log(`Discounts: ${paidAndFulfilledTotal.discount.toFixed(2)} kr`);
  console.log(`Refunds: ${paidAndFulfilledTotal.refund.toFixed(2)} kr`);
  console.log(`Net Sales: ${paidAndFulfilledTotal.net.toFixed(2)} kr`);
  
  console.log('\n=== EXPECTED (from Shopify Finance Report) ===');
  console.log(`Gross Sales: 108958.02 kr`);
  console.log(`Discounts: -18885.13 kr`);
  console.log(`Refunds: -3938.15 kr`);
  console.log(`Net Sales: 86134.74 kr`);
  
  console.log('\n=== DIFF ===');
  console.log(`Gross Sales: ${(paidAndFulfilledTotal.gross - 108958.02).toFixed(2)} kr`);
  console.log(`Discounts: ${(paidAndFulfilledTotal.discount - (-18885.13)).toFixed(2)} kr`);
  console.log(`Refunds: ${(paidAndFulfilledTotal.refund - (-3938.15)).toFixed(2)} kr`);
  console.log(`Net Sales: ${(paidAndFulfilledTotal.net - 86134.74).toFixed(2)} kr`);
}

check();

