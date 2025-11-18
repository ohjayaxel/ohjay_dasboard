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

async function count() {
  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0';
  
  const { data: orders, error } = await supabase
    .from('shopify_orders')
    .select('gross_sales')
    .eq('tenant_id', tenantId)
    .eq('processed_at', '2025-11-17');

  if (error) {
    console.error('Error:', error);
    return;
  }

  const totalOrders = orders.length;
  const ordersWithGrossSales = orders.filter(o => parseFloat((o as any).gross_sales || 0) > 0);
  const gross = ordersWithGrossSales.reduce((sum, o) => sum + parseFloat((o as any).gross_sales || 0), 0);

  console.log(`Total orders: ${totalOrders}`);
  console.log(`Orders with gross_sales > 0: ${ordersWithGrossSales.length}`);
  console.log(`Gross Sales: ${gross.toFixed(2)} kr`);
}

count();
