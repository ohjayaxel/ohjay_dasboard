#!/usr/bin/env -S tsx

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function check() {
  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0';
  const date = '2025-11-17';

  const { data: orders } = await supabase
    .from('shopify_orders')
    .select('order_id, gross_sales, net_sales, total_tax, is_refund')
    .eq('tenant_id', tenantId)
    .eq('processed_at', date)
    .order('gross_sales', { ascending: false });

  if (!orders) return;

  const regularOrders = orders.filter(o => !o.is_refund);
  const refunds = orders.filter(o => o.is_refund);

  console.log(`Total orders: ${orders.length}`);
  console.log(`Regular orders: ${regularOrders.length}`);
  console.log(`Refunds: ${refunds.length}\n`);

  // Check for orders with gross_sales = null
  const nullGrossSales = orders.filter(o => o.gross_sales === null || o.gross_sales === undefined);
  console.log(`Orders with gross_sales = null: ${nullGrossSales.length}`);
  if (nullGrossSales.length > 0) {
    nullGrossSales.forEach(o => {
      console.log(`  Order ${o.order_id}: is_refund=${o.is_refund}, gross_sales=${o.gross_sales}`);
    });
    console.log('');
  }

  // Check smallest gross_sales values
  console.log('=== Smallest gross_sales values (regular orders) ===');
  const sortedRegular = regularOrders
    .map(o => ({ ...o, grossSales: Number(o.gross_sales) || 0 }))
    .sort((a, b) => a.grossSales - b.grossSales)
    .slice(0, 5);
  
  sortedRegular.forEach(o => {
    const tax = Number(o.total_tax) || 0;
    const grossAfterTax = o.grossSales - tax;
    console.log(`Order ${o.order_id}:`);
    console.log(`  gross_sales: ${o.gross_sales}`);
    console.log(`  total_tax: ${o.total_tax}`);
    console.log(`  gross_sales - tax: ${grossAfterTax}`);
    console.log(`  net_sales: ${o.net_sales}`);
    console.log('');
  });

  // Sum of smallest orders
  const smallest5 = sortedRegular.map(o => {
    const totalSales = Number(o.gross_sales) || 0;
    const tax = Number(o.total_tax) || 0;
    return totalSales - tax;
  }).reduce((sum, val) => sum + val, 0);

  console.log(`Sum of 5 smallest gross_sales (after tax): ${smallest5}`);
}

check().catch(console.error);

