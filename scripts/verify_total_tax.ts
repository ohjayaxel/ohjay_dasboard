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

  console.log(`Total orders: ${orders.length}`);
  console.log(`Valid status orders: ${validOrders.length}\n`);

  // Check how many have total_tax
  const withTax = validOrders.filter(o => (o as any).total_tax !== null && parseFloat((o as any).total_tax || '0') > 0);
  const withoutTax = validOrders.filter(o => !(o as any).total_tax || parseFloat((o as any).total_tax || '0') === 0);

  console.log(`Orders with total_tax > 0: ${withTax.length}`);
  console.log(`Orders without total_tax: ${withoutTax.length}\n`);

  // Calculate using total_price - total_tax
  const calculatedGross = validOrders.reduce((sum, o) => {
    const totalPrice = parseFloat((o as any).total_price || 0);
    const totalTax = parseFloat((o as any).total_tax || 0);
    return sum + (totalPrice - totalTax);
  }, 0);

  // Current gross_sales in DB
  const dbGross = validOrders.reduce((sum, o) => sum + parseFloat((o as any).gross_sales || 0), 0);

  // Sum of total_price
  const sumTotalPrice = validOrders.reduce((sum, o) => sum + parseFloat((o as any).total_price || 0), 0);
  
  // Sum of total_tax
  const sumTotalTax = validOrders.reduce((sum, o) => sum + parseFloat((o as any).total_tax || 0), 0);

  console.log('=== CALCULATION VERIFICATION ===');
  console.log(`Sum of total_price: ${sumTotalPrice.toFixed(2)} kr`);
  console.log(`Sum of total_tax: ${sumTotalTax.toFixed(2)} kr`);
  console.log(`Sum of (total_price - total_tax): ${calculatedGross.toFixed(2)} kr`);
  console.log(`Sum of gross_sales (from DB): ${dbGross.toFixed(2)} kr`);
  console.log(`Expected Gross Sales: 108958.02 kr`);
  
  console.log('\n=== DIFF ===');
  console.log(`Calculated vs DB gross_sales: ${(calculatedGross - dbGross).toFixed(2)} kr`);
  console.log(`Calculated vs Expected: ${(calculatedGross - 108958.02).toFixed(2)} kr`);
  console.log(`DB gross_sales vs Expected: ${(dbGross - 108958.02).toFixed(2)} kr`);

  if (withoutTax.length > 0) {
    console.log(`\n⚠️  WARNING: ${withoutTax.length} orders have no total_tax!`);
    console.log('   This could cause incorrect calculations.');
  }

  // Check if orders without tax have zero price
  const zeroPriceNoTax = withoutTax.filter(o => parseFloat((o as any).total_price || 0) === 0);
  const nonZeroPriceNoTax = withoutTax.filter(o => parseFloat((o as any).total_price || 0) > 0);
  
  if (nonZeroPriceNoTax.length > 0) {
    console.log(`\n⚠️  ${nonZeroPriceNoTax.length} orders have total_price > 0 but total_tax is null/0!`);
    console.log('   Sample order IDs:');
    nonZeroPriceNoTax.slice(0, 5).forEach(o => {
      const order = o as any;
      console.log(`     Order ${order.order_id}: total_price=${order.total_price}, total_tax=${order.total_tax || 'null'}`);
    });
  }
}

verify();

