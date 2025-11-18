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

async function analyze() {
  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0';
  
  const { data: orders, error } = await supabase
    .from('shopify_orders')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('processed_at', '2025-11-17')
    .order('gross_sales', { ascending: false });

  if (error) {
    console.error('Error:', error);
    return;
  }

  const validStatuses = new Set(['paid', 'partially_paid', 'partially_refunded', 'refunded']);
  const validOrders = orders.filter(o => validStatuses.has((o as any).financial_status || ''));

  const expectedGross = 108958.02;
  let cumulativeGross = 0;
  const includedOrders: any[] = [];
  const excludedOrders: any[] = [];

  // Find which orders to include to match Shopify Finance
  for (const order of validOrders) {
    const gross = parseFloat((order as any).gross_sales || 0);
    
    if (cumulativeGross < expectedGross) {
      cumulativeGross += gross;
      includedOrders.push(order);
    } else {
      excludedOrders.push(order);
    }
  }

  console.log(`Total orders: ${validOrders.length}`);
  console.log(`Included orders: ${includedOrders.length}`);
  console.log(`Excluded orders: ${excludedOrders.length}\n`);

  // Group by fulfillment_status
  console.log('=== BY FULFILLMENT_STATUS ===\n');
  
  const byFulfillment: Record<string, { included: number; excluded: number; gross: { included: number; excluded: number } }> = {};
  
  [includedOrders, excludedOrders].forEach((orderList, index) => {
    const isIncluded = index === 0;
    orderList.forEach(order => {
      const o = order as any;
      const status = o.fulfillment_status || 'null';
      if (!byFulfillment[status]) {
        byFulfillment[status] = { included: 0, excluded: 0, gross: { included: 0, excluded: 0 } };
      }
      if (isIncluded) {
        byFulfillment[status].included++;
        byFulfillment[status].gross.included += parseFloat(o.gross_sales || 0);
      } else {
        byFulfillment[status].excluded++;
        byFulfillment[status].gross.excluded += parseFloat(o.gross_sales || 0);
      }
    });
  });

  Object.entries(byFulfillment).forEach(([status, data]) => {
    console.log(`${status || 'null'}:`);
    console.log(`  Included: ${data.included} orders (${data.gross.included.toFixed(2)} kr)`);
    console.log(`  Excluded: ${data.excluded} orders (${data.gross.excluded.toFixed(2)} kr)`);
    console.log(`  Total: ${data.included + data.excluded} orders`);
    console.log('');
  });

  // Group by source_name
  console.log('=== BY SOURCE_NAME ===\n');
  
  const bySource: Record<string, { included: number; excluded: number; gross: { included: number; excluded: number } }> = {};
  
  [includedOrders, excludedOrders].forEach((orderList, index) => {
    const isIncluded = index === 0;
    orderList.forEach(order => {
      const o = order as any;
      const source = o.source_name || 'null';
      if (!bySource[source]) {
        bySource[source] = { included: 0, excluded: 0, gross: { included: 0, excluded: 0 } };
      }
      if (isIncluded) {
        bySource[source].included++;
        bySource[source].gross.included += parseFloat(o.gross_sales || 0);
      } else {
        bySource[source].excluded++;
        bySource[source].gross.excluded += parseFloat(o.gross_sales || 0);
      }
    });
  });

  Object.entries(bySource).forEach(([source, data]) => {
    console.log(`${source || 'null'}:`);
    console.log(`  Included: ${data.included} orders (${data.gross.included.toFixed(2)} kr)`);
    console.log(`  Excluded: ${data.excluded} orders (${data.gross.excluded.toFixed(2)} kr)`);
    console.log(`  Total: ${data.included + data.excluded} orders`);
    console.log('');
  });

  // Combined analysis
  console.log('=== COMBINED FULFILLMENT_STATUS + SOURCE_NAME ===\n');
  
  const byCombined: Record<string, { included: number; excluded: number; gross: { included: number; excluded: number } }> = {};
  
  [includedOrders, excludedOrders].forEach((orderList, index) => {
    const isIncluded = index === 0;
    orderList.forEach(order => {
      const o = order as any;
      const fulfillment = o.fulfillment_status || 'null';
      const source = o.source_name || 'null';
      const key = `${fulfillment} / ${source}`;
      if (!byCombined[key]) {
        byCombined[key] = { included: 0, excluded: 0, gross: { included: 0, excluded: 0 } };
      }
      if (isIncluded) {
        byCombined[key].included++;
        byCombined[key].gross.included += parseFloat(o.gross_sales || 0);
      } else {
        byCombined[key].excluded++;
        byCombined[key].gross.excluded += parseFloat(o.gross_sales || 0);
      }
    });
  });

  Object.entries(byCombined)
    .sort((a, b) => (b[1].included + b[1].excluded) - (a[1].included + a[1].excluded))
    .forEach(([key, data]) => {
      const total = data.included + data.excluded;
      if (total > 5) { // Only show categories with more than 5 orders
        console.log(`${key}:`);
        console.log(`  Included: ${data.included} orders (${data.gross.included.toFixed(2)} kr)`);
        console.log(`  Excluded: ${data.excluded} orders (${data.gross.excluded.toFixed(2)} kr)`);
        const exclusionRate = (data.excluded / total * 100).toFixed(1);
        console.log(`  Exclusion rate: ${exclusionRate}%`);
        console.log('');
      }
    });

  // Summary
  console.log('=== SUMMARY ===\n');
  console.log(`Expected Gross Sales (Shopify Finance): ${expectedGross.toFixed(2)} kr`);
  console.log(`Included Gross Sales: ${cumulativeGross.toFixed(2)} kr`);
  console.log(`Excluded Gross Sales: ${excludedOrders.reduce((sum, o) => sum + parseFloat((o as any).gross_sales || 0), 0).toFixed(2)} kr`);
  console.log(`\nDiff: ${(cumulativeGross - expectedGross).toFixed(2)} kr`);
}

analyze();

