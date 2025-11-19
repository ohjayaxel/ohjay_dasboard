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
    .eq('processed_at', date);

  if (!orders) return;

  const included = orders.filter((o) => {
    const grossSales = Number(o.gross_sales) || 0;
    return grossSales > 0;
  });

  const excluded = orders.filter((o) => {
    const grossSales = Number(o.gross_sales) || 0;
    return grossSales <= 0;
  });

  console.log(`Total orders: ${orders.length}`);
  console.log(`Included (gross_sales > 0): ${included.length}`);
  console.log(`Excluded (gross_sales <= 0): ${excluded.length}\n`);

  if (excluded.length > 0) {
    console.log('=== Excluded orders ===');
    excluded.forEach(o => {
      const grossSales = Number(o.gross_sales) || 0;
      const totalTax = Number(o.total_tax) || 0;
      const grossAfterTax = grossSales - totalTax;
      console.log(`Order ${o.order_id}:`);
      console.log(`  is_refund: ${o.is_refund}`);
      console.log(`  gross_sales: ${o.gross_sales}`);
      console.log(`  total_tax: ${o.total_tax}`);
      console.log(`  gross_sales - tax: ${grossAfterTax}`);
      console.log(`  net_sales: ${o.net_sales}`);
      console.log('');
    });
  }

  // Calculate sum of excluded non-refund orders
  let excludedTotalSales = 0;
  let excludedTotalTax = 0;
  let excludedGrossSales = 0;
  
  for (const order of excluded) {
    if (!order.is_refund) { // Only count non-refunds
      const totalSales = Number(order.gross_sales) || 0;
      const tax = Number(order.total_tax) || 0;
      excludedTotalSales += totalSales;
      excludedTotalTax += tax;
      excludedGrossSales += (totalSales - tax);
    }
  }

  console.log('=== Sum of excluded non-refund orders ===');
  console.log(`Total Sales: ${excludedTotalSales}`);
  console.log(`Total Tax: ${excludedTotalTax}`);
  console.log(`Gross Sales (Total Sales - Tax): ${excludedGrossSales}`);
}

check().catch(console.error);

