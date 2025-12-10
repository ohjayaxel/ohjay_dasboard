/**
 * Debug script - Testar fetchShopifyOrdersGraphQL funktionen direkt
 * och loggar RAW response för att se om customer-data försvinner i mappningen
 */

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrdersGraphQL, type GraphQLOrder } from '@/lib/integrations/shopify-graphql';

// Load environment variables
const envPath = require('path').resolve(process.cwd(), 'env', 'local.prod.sh');
try {
  const envFile = require('fs').readFileSync(envPath, 'utf-8');
  envFile.split('\n').forEach((line: string) => {
    if (line && !line.startsWith('#') && line.includes('=')) {
      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=').replace(/^["']|["']$/g, '').trim();
      if (key && value) {
        process.env[key.trim()] = value;
      }
    }
  });
} catch (e) {
  console.warn('Could not load env file, using existing environment variables');
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log('='.repeat(80));
  console.log('DEBUG: fetchShopifyOrdersGraphQL FUNCTION');
  console.log('='.repeat(80));
  console.log('');

  // Get tenant and connection
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, slug')
    .eq('slug', 'skinome')
    .maybeSingle();

  if (!tenant) {
    console.error('❌ Tenant not found');
    process.exit(1);
  }

  const { data: connection } = await supabase
    .from('connections')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('source', 'shopify')
    .maybeSingle();

  if (!connection) {
    console.error('❌ Connection not found');
    process.exit(1);
  }

  const shopDomain = connection.meta?.store_domain || connection.meta?.shop;

  // Test 1: Fetch a small number of orders
  console.log('Test 1: Fetching 10 orders (no date filter)...');
  const orders1 = await fetchShopifyOrdersGraphQL({
    tenantId: tenant.id,
    shopDomain,
    excludeTest: true,
  });

  console.log(`✅ Fetched ${orders1.length} orders\n`);

  let withCustomer1 = 0;
  let withNumberOfOrders1 = 0;
  const samples1: Array<GraphQLOrder> = [];

  for (const order of orders1.slice(0, 10)) {
    if (order.customer?.id) {
      withCustomer1++;
      if (order.customer?.numberOfOrders) {
        withNumberOfOrders1++;
        if (samples1.length < 3) {
          samples1.push(order);
        }
      }
    }
  }

  console.log(`   Orders with customer.id: ${withCustomer1}/10`);
  console.log(`   Orders with numberOfOrders: ${withNumberOfOrders1}/10`);
  console.log('');

  if (samples1.length > 0) {
    console.log('RAW GraphQLOrder objects (first 3 with customer data):');
    for (const order of samples1) {
      console.log(JSON.stringify({
        id: order.id,
        name: order.name,
        customer: order.customer,
      }, null, 2));
      console.log('');
    }
  }

  // Test 2: Fetch with date filter for 2025-11-30
  console.log('='.repeat(80));
  console.log('Test 2: Fetching orders for 2025-11-30 (with date filter)...');
  console.log('='.repeat(80));
  console.log('');

  const orders2 = await fetchShopifyOrdersGraphQL({
    tenantId: tenant.id,
    shopDomain,
    since: '2025-11-30',
    until: '2025-11-30',
    excludeTest: true,
  });

  console.log(`✅ Fetched ${orders2.length} orders for 2025-11-30\n`);

  let withCustomer2 = 0;
  let withNumberOfOrders2 = 0;
  const samples2: Array<GraphQLOrder> = [];

  for (const order of orders2.slice(0, 10)) {
    if (order.customer?.id) {
      withCustomer2++;
      if (order.customer?.numberOfOrders) {
        withNumberOfOrders2++;
        if (samples2.length < 3) {
          samples2.push(order);
        }
      }
    }
  }

  console.log(`   Orders with customer.id: ${withCustomer2}/${Math.min(10, orders2.length)}`);
  console.log(`   Orders with numberOfOrders: ${withNumberOfOrders2}/${Math.min(10, orders2.length)}`);
  console.log('');

  if (samples2.length > 0) {
    console.log('RAW GraphQLOrder objects (first 3 with customer data):');
    for (const order of samples2) {
      console.log(JSON.stringify({
        id: order.id,
        name: order.name,
        customer: order.customer,
      }, null, 2));
      console.log('');
    }
  } else {
    console.log('⚠️  No orders with customer data found in first 10 orders');
    console.log('   Showing first 3 orders (even without customer):');
    for (const order of orders2.slice(0, 3)) {
      console.log(JSON.stringify({
        id: order.id,
        name: order.name,
        customer: order.customer,
      }, null, 2));
      console.log('');
    }
  }

  // Summary
  console.log('='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log('');
  console.log('Without date filter:');
  console.log(`  - Total orders: ${orders1.length}`);
  console.log(`  - With customer.id: ${withCustomer1}/10 checked`);
  console.log(`  - With numberOfOrders: ${withNumberOfOrders1}/10 checked`);
  console.log('');
  console.log('With date filter (2025-11-30):');
  console.log(`  - Total orders: ${orders2.length}`);
  console.log(`  - With customer.id: ${withCustomer2}/${Math.min(10, orders2.length)} checked`);
  console.log(`  - With numberOfOrders: ${withNumberOfOrders2}/${Math.min(10, orders2.length)} checked`);
  console.log('');

  if (withCustomer1 > 0 && withCustomer2 === 0) {
    console.log('🔍 INSIGHT: Customer data exists without date filter but NOT with date filter');
    console.log('   This suggests the orders for 2025-11-30 might actually be guest checkouts,');
    console.log('   OR there is an issue with how date filtering works.');
  } else if (withCustomer2 > 0) {
    console.log('✅ Customer data IS present in fetchShopifyOrdersGraphQL results!');
    console.log('   Problem must be elsewhere in the processing pipeline.');
  }
  console.log('');
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});


