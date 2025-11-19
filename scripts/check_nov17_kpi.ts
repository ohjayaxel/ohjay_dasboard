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

  // Check all KPI rows for this date
  const { data: kpiData, error } = await supabase
    .from('kpi_daily')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('date', date)
    .eq('source', 'shopify');

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log('=== KPI_DAILY rows for 2025-11-17 ===');
  console.log(`Total rows: ${kpiData?.length || 0}\n`);
  
  if (kpiData && kpiData.length > 0) {
    kpiData.forEach((row, idx) => {
      console.log(`Row ${idx + 1}:`);
      console.log(`  gross_sales: ${row.gross_sales}`);
      console.log(`  net_sales: ${row.net_sales}`);
      console.log(`  conversions: ${row.conversions}`);
      console.log(`  revenue: ${row.revenue}`);
      console.log('');
    });
  }

  // Sum all gross_sales
  const totalGrossSales = kpiData?.reduce((sum, row) => sum + (Number(row.gross_sales) || 0), 0) || 0;
  const totalNetSales = kpiData?.reduce((sum, row) => sum + (Number(row.net_sales) || 0), 0) || 0;
  
  console.log('=== Totals (sum of all KPI rows) ===');
  console.log(`Total Gross Sales: ${totalGrossSales}`);
  console.log(`Total Net Sales: ${totalNetSales}\n`);

  // Check orders count and calculation (match Orders page logic)
  const { data: orders } = await supabase
    .from('shopify_orders')
    .select('gross_sales, net_sales, total_tax, is_refund')
    .eq('tenant_id', tenantId)
    .eq('processed_at', date);

  if (orders) {
    // Match Orders page filter: include refunds always, non-refunds only if gross_sales > 0
    const includedOrders = orders.filter((o) => {
      const grossSales = Number(o.gross_sales) || 0;
      return o.is_refund || grossSales > 0;
    });

    let ordersTotalSales = 0;
    let ordersGrossSales = 0;
    let ordersNetSales = 0;
    let ordersTotalTax = 0;
    
    // Match Orders page calculation: add regular orders, subtract refunds
    for (const order of includedOrders) {
      const totalSales = Number(order.gross_sales) || 0;
      const tax = Number(order.total_tax) || 0;
      const net = Number(order.net_sales) || 0;
      const grossSales = totalSales - tax;

      if (order.is_refund) {
        // Subtract refunds
        ordersTotalSales -= totalSales;
        ordersTotalTax -= tax;
        ordersGrossSales -= grossSales;
        ordersNetSales -= net;
      } else {
        // Add regular orders
        ordersTotalSales += totalSales;
        ordersTotalTax += tax;
        ordersGrossSales += grossSales;
        ordersNetSales += net;
      }
    }

    const refunds = orders.filter(o => o.is_refund);
    const regularOrders = orders.filter(o => !o.is_refund);

    console.log('=== Orders calculation (from shopify_orders, matching Orders page) ===');
    console.log(`Total orders: ${orders.length}`);
    console.log(`Regular orders: ${regularOrders.length}`);
    console.log(`Refunds: ${refunds.length}`);
    console.log(`Included orders (refunds always + non-refunds with gross_sales > 0): ${includedOrders.length}\n`);
    console.log(`Total Sales (SUM, refunds subtracted): ${ordersTotalSales}`);
    console.log(`Total Tax: ${ordersTotalTax}`);
    console.log(`Gross Sales (Total Sales - Tax, refunds subtracted): ${ordersGrossSales}`);
    console.log(`Net Sales (refunds subtracted): ${ordersNetSales}\n`);
    
    console.log('=== Difference ===');
    console.log(`KPI Gross Sales: ${totalGrossSales}`);
    console.log(`Orders Gross Sales (with refunds subtracted): ${ordersGrossSales}`);
    console.log(`Difference: ${Math.abs(ordersGrossSales - totalGrossSales)}`);
  }
}

check().catch(console.error);

