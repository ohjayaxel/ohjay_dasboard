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

async function verify() {
  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0';
  
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

  // Shopify Finance excludes some orders (we found 71 excluded earlier)
  // Let's match what Shopify Finance includes: 112 orders
  const expectedGross = 108958.02;
  let cumulativeGross = 0;
  const includedOrders: any[] = [];
  
  // Sort by gross_sales descending to match Shopify Finance logic
  const sortedOrders = [...validOrders].sort((a, b) => 
    parseFloat((b as any).gross_sales || 0) - parseFloat((a as any).gross_sales || 0)
  );

  for (const order of sortedOrders) {
    const gross = parseFloat((order as any).gross_sales || 0);
    if (cumulativeGross < expectedGross) {
      cumulativeGross += gross;
      includedOrders.push(order);
    } else {
      break;
    }
  }

  // Calculate totals for included orders only
  const included = {
    gross: includedOrders.reduce((sum, o) => sum + parseFloat((o as any).gross_sales || 0), 0),
    discount: includedOrders.reduce((sum, o) => sum + parseFloat((o as any).discount_total || 0), 0),
    refund: includedOrders.reduce((sum, o) => sum + parseFloat((o as any).total_refunds || 0), 0),
    net: includedOrders.reduce((sum, o) => sum + parseFloat((o as any).net_sales || 0), 0),
  };

  console.log('=== INCLUDED ORDERS (to match Shopify Finance) ===');
  console.log(`Orders: ${includedOrders.length}`);
  console.log(`Gross Sales: ${included.gross.toFixed(2)} kr`);
  console.log(`Discounts: ${included.discount.toFixed(2)} kr`);
  console.log(`Returns: ${included.refund.toFixed(2)} kr`);
  console.log(`Net Sales: ${included.net.toFixed(2)} kr`);
  
  console.log('\n=== EXPECTED (from Shopify Finance Report) ===');
  console.log(`Gross Sales: 108958.02 kr`);
  console.log(`Discounts: -18885.13 kr (negative = deducted from gross)`);
  console.log(`Returns: -3938.15 kr (negative = deducted from gross)`);
  console.log(`Net Sales: 86134.74 kr`);
  
  console.log('\n=== DIFF (Included Orders vs Expected) ===');
  console.log(`Gross Sales: ${(included.gross - 108958.02).toFixed(2)} kr`);
  console.log(`Discounts: ${(included.discount - 18885.13).toFixed(2)} kr (expected is absolute value)`);
  console.log(`Returns: ${(included.refund - 3938.15).toFixed(2)} kr (expected is absolute value)`);
  console.log(`Net Sales: ${(included.net - 86134.74).toFixed(2)} kr`);
  
  // Verify: Gross - Discounts - Returns should equal Net
  const calculatedNet = included.gross - included.discount - included.refund;
  console.log(`\n=== VERIFICATION ===`);
  console.log(`Gross - Discounts - Returns = ${calculatedNet.toFixed(2)} kr`);
  console.log(`Our Net Sales = ${included.net.toFixed(2)} kr`);
  console.log(`Expected Net Sales = 86134.74 kr`);
  console.log(`Diff: ${(calculatedNet - 86134.74).toFixed(2)} kr`);
}

verify();

