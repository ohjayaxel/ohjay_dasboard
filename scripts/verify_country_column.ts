#!/usr/bin/env -S tsx

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function verify() {
  console.log('=== Verifierar Country-kolumn ===\n');

  // Get Skinome tenant ID
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, slug, name')
    .eq('slug', 'skinome')
    .single();

  if (!tenant) {
    console.error('Tenant skinome not found');
    return;
  }

  console.log(`Tenant: ${tenant.name} (${tenant.slug})\n`);

  // Check total orders
  const { count: totalOrdersCount, error: error2 } = await supabase
    .from('shopify_orders')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenant.id);

  if (error2) {
    console.error('Error getting total count:', error2);
    return;
  }

  // Get sample of orders with country
  const { data: sampleWithCountry, error: error3 } = await supabase
    .from('shopify_orders')
    .select('country')
    .eq('tenant_id', tenant.id)
    .not('country', 'is', null)
    .limit(1000);

  if (error3) {
    console.error('Error getting orders with country:', error3);
    return;
  }

  // Get sample of orders without country
  const { data: sampleWithoutCountry, error: error4 } = await supabase
    .from('shopify_orders')
    .select('country')
    .eq('tenant_id', tenant.id)
    .is('country', null)
    .limit(100);

  if (error4) {
    console.error('Error getting orders without country:', error4);
    return;
  }

  const ordersWithCountryCount = sampleWithCountry?.length || 0;
  const ordersWithoutCountryCount = sampleWithoutCountry?.length || 0;

  console.log(`Totalt antal orders: ${totalOrdersCount || 0}`);
  console.log(`Orders med country (sample): ${ordersWithCountryCount}`);
  console.log(`Orders utan country (sample): ${ordersWithoutCountryCount}\n`);

  // Get unique countries
  const countries = new Set(sampleWithCountry?.map((o) => o.country).filter(Boolean) || []);
  console.log(`Unika länder (i sample): ${countries.size}`);
  if (countries.size > 0) {
    console.log(`Länder: ${Array.from(countries).sort().join(', ')}\n`);
  }

  // Sample a few orders with country
  const { data: sample, error: error5 } = await supabase
    .from('shopify_orders')
    .select('order_id, country, processed_at')
    .eq('tenant_id', tenant.id)
    .not('country', 'is', null)
    .limit(10);

  if (error5) {
    console.error('Error getting sample orders:', error5);
    return;
  }

  console.log('Exempel orders med country:');
  sample?.forEach((order) => {
    console.log(`  Order ${order.order_id} (${order.processed_at}): ${order.country}`);
  });
}

verify().catch(console.error);
