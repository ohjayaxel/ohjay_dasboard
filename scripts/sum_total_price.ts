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

async function sum() {
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

  console.log(`Total orders: ${orders.length}\n`);

  // Sum all total_price (no filtering)
  const sumAll = orders.reduce((sum, o) => sum + parseFloat((o as any).total_price || 0), 0);

  // Filter by financial_status
  const validStatuses = new Set(['paid', 'partially_paid', 'partially_refunded', 'refunded']);
  const validOrders = orders.filter(o => validStatuses.has((o as any).financial_status || ''));
  const sumValid = validOrders.reduce((sum, o) => sum + parseFloat((o as any).total_price || 0), 0);

  console.log('=== SUM OF total_price ===');
  console.log(`All orders: ${sumAll.toFixed(2)} kr`);
  console.log(`Valid financial_status only (paid/partially_paid/partially_refunded/refunded): ${sumValid.toFixed(2)} kr`);
  console.log(`\nExpected Gross Sales (Shopify Finance): 108958.02 kr`);
  console.log(`\nDiff (all orders): ${(sumAll - 108958.02).toFixed(2)} kr`);
  console.log(`Diff (valid status): ${(sumValid - 108958.02).toFixed(2)} kr`);
}

sum();

