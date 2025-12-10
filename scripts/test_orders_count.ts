/**
 * Test script to verify that customer.ordersCount is correctly fetched from Shopify GraphQL API
 */

import { createClient } from '@supabase/supabase-js';
import { decryptSecret } from '@/lib/integrations/crypto';
import { fetchShopifyOrdersGraphQL } from '@/lib/integrations/shopify-graphql';
import { resolve } from 'path';

// Load environment variables from env/local.prod.sh
const envPath = resolve(process.cwd(), 'env', 'local.prod.sh');
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

async function testOrdersCount() {
  console.log('🧪 Testing customer.ordersCount fetching from Shopify GraphQL API...\n');

  // Get tenant and connection
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, slug')
    .eq('slug', 'skinome')
    .maybeSingle();

  if (!tenant) {
    console.error('❌ Tenant "skinome" not found');
    process.exit(1);
  }

  console.log(`✅ Found tenant: ${tenant.name} (${tenant.slug})`);

  const { data: connection } = await supabase
    .from('connections')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('source', 'shopify')
    .maybeSingle();

  if (!connection) {
    console.error('❌ Shopify connection not found');
    process.exit(1);
  }

  const shopDomain = connection.meta?.store_domain || connection.meta?.shop;
  console.log(`✅ Found Shopify connection: ${shopDomain}\n`);

  // Test fetching orders for 2025-11-30 (same date as reconciliation test)
  const testDate = '2025-11-30';
  const testDateEnd = '2025-11-30';
  
  console.log(`📥 Fetching orders for ${testDate}...`);

  try {
    const orders = await fetchShopifyOrdersGraphQL({
      tenantId: tenant.id,
      shopDomain,
      since: testDate,
      until: testDateEnd,
      excludeTest: true,
    });

    console.log(`✅ Fetched ${orders.length} orders\n`);

    if (orders.length === 0) {
      console.log('⚠️  No orders found for this date. Trying a broader date range...');
      
      // Try a broader date range
      const orders2 = await fetchShopifyOrdersGraphQL({
        tenantId: tenant.id,
        shopDomain,
        since: '2025-11-01',
        until: '2025-11-30',
        excludeTest: true,
      });
      
      if (orders2.length > 0) {
        console.log(`✅ Found ${orders2.length} orders in November 2025. Analyzing first 10 orders...\n`);
        analyzeOrders(orders2.slice(0, 10));
      } else {
        console.log('❌ No orders found in November 2025');
      }
      return;
    }

    analyzeOrders(orders);
  } catch (error) {
    console.error('❌ Error fetching orders:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

function analyzeOrders(orders: any[]) {
  console.log('📊 ANALYZING ORDERS:\n');
  console.log('=' .repeat(80));

  let ordersWithCustomer = 0;
  let ordersWithOrdersCount = 0;
  let newCustomers = 0;
  let returningCustomers = 0;
  let ordersWithoutCustomer = 0;

  const sampleOrders: Array<{
    orderName: string;
    customerId: string | null;
    ordersCount: number | null;
    isNewCustomer: boolean | null;
  }> = [];

  for (const order of orders) {
    const customerId = order.customer?.id || null;
    const ordersCount = order.customer?.ordersCount ?? null;
    const email = order.customer?.email || null;

    if (customerId) {
      ordersWithCustomer++;
      if (ordersCount !== null && ordersCount !== undefined) {
        ordersWithOrdersCount++;
        if (ordersCount === 1) {
          newCustomers++;
        } else if (ordersCount > 1) {
          returningCustomers++;
        }
      }
    } else {
      ordersWithoutCustomer++;
    }

    // Store first 10 orders for detailed display
    if (sampleOrders.length < 10) {
      sampleOrders.push({
        orderName: order.name,
        customerId,
        ordersCount,
        isNewCustomer: ordersCount === 1,
      });
    }
  }

  console.log(`\n📈 SUMMARY:\n`);
  console.log(`  Total orders analyzed: ${orders.length}`);
  console.log(`  Orders with customer: ${ordersWithCustomer}`);
  console.log(`  Orders with ordersCount: ${ordersWithOrdersCount}`);
  console.log(`  Orders without customer: ${ordersWithoutCustomer}`);
  console.log(`\n  New customers (ordersCount === 1): ${newCustomers}`);
  console.log(`  Returning customers (ordersCount > 1): ${returningCustomers}`);

  console.log(`\n📋 SAMPLE ORDERS (first ${sampleOrders.length}):\n`);
  console.log('Order Name'.padEnd(20) + ' | Customer ID'.padEnd(25) + ' | Orders Count'.padEnd(15) + ' | Type');
  console.log('-'.repeat(80));

  for (const order of sampleOrders) {
    const orderName = (order.orderName || 'N/A').padEnd(20);
    const customerId = (order.customerId ? order.customerId.substring(0, 24) : 'N/A (no customer)').padEnd(25);
    const ordersCount = (order.ordersCount !== null ? String(order.ordersCount) : 'N/A').padEnd(15);
    const type = order.ordersCount === 1 ? '🆕 NEW' : order.ordersCount && order.ordersCount > 1 ? '🔄 RETURNING' : '❓ UNKNOWN';
    
    console.log(`${orderName} | ${customerId} | ${ordersCount} | ${type}`);
  }

  console.log('\n' + '='.repeat(80));

  // Validation
  if (ordersWithCustomer > 0 && ordersWithOrdersCount === 0) {
    console.log('\n⚠️  WARNING: Orders have customers but ordersCount is missing!');
    console.log('   This might mean:');
    console.log('   1. The GraphQL query is not fetching ordersCount correctly');
    console.log('   2. The read_customers scope is not properly configured');
    console.log('   3. The Shopify API version does not support ordersCount field');
  } else if (ordersWithOrdersCount === ordersWithCustomer) {
    console.log('\n✅ SUCCESS: All orders with customers have ordersCount!');
  } else if (ordersWithOrdersCount > 0) {
    console.log(`\n⚠️  PARTIAL: ${ordersWithOrdersCount} out of ${ordersWithCustomer} orders have ordersCount`);
  }
}

// Run the test
testOrdersCount().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

