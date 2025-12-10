/**
 * Quick test to verify customer scope after re-authorization
 */

import { createClient } from '@supabase/supabase-js';
import { getShopifyAccessToken } from '@/lib/integrations/shopify';

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
  console.log('CUSTOMER SCOPE VERIFICATION AFTER RE-AUTHORIZATION');
  console.log('='.repeat(80));
  console.log('');

  // Get tenant
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, slug')
    .eq('slug', 'skinome')
    .single();

  if (!tenant) {
    console.error('❌ Tenant not found');
    process.exit(1);
  }

  console.log(`✅ Tenant: ${tenant.name} (${tenant.slug})\n`);

  // Get connection
  const { data: connection } = await supabase
    .from('connections')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('source', 'shopify')
    .single();

  if (!connection) {
    console.error('❌ Connection not found');
    process.exit(1);
  }

  // Check stored scopes
  console.log('='.repeat(80));
  console.log('1. CHECKING STORED SCOPES');
  console.log('='.repeat(80));
  console.log('');
  
  const storedScopes = connection.meta?.scope || connection.meta?.scopes;
  if (storedScopes) {
    if (typeof storedScopes === 'string') {
      const scopeList = storedScopes.split(',').map((s: string) => s.trim());
      console.log('Scopes:', scopeList.join(', '));
      console.log('  ✓ read_orders:', scopeList.includes('read_orders') ? 'YES ✅' : 'NO ❌');
      console.log('  ✓ read_customers:', scopeList.includes('read_customers') ? 'YES ✅' : 'NO ❌');
    } else {
      console.log('Scopes:', JSON.stringify(storedScopes));
    }
  } else {
    console.log('⚠️  No scope information found in metadata');
    console.log('   (This might be OK - scopes might not be stored in metadata)');
  }
  console.log('');

  // Get access token
  const accessToken = await getShopifyAccessToken(tenant.id);
  if (!accessToken) {
    console.error('❌ No access token found');
    process.exit(1);
  }

  console.log('='.repeat(80));
  console.log('2. TESTING GRAPHQL QUERY FOR CUSTOMER DATA');
  console.log('='.repeat(80));
  console.log('');

  const shopDomain = connection.meta?.store_domain || connection.meta?.shop;
  const normalizedShop = shopDomain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();

  const testQuery = `
    query TestCustomerData {
      orders(first: 10, query: "created_at:>=2025-11-30 AND created_at:<=2025-11-30") {
        edges {
          node {
            id
            name
            createdAt
            customer {
              id
              email
              numberOfOrders
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(`https://${normalizedShop}/admin/api/2023-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        query: testQuery,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`❌ API Error: ${response.status}`);
      console.error(`Response: ${body}`);
      process.exit(1);
    }

    const result = await response.json();

    if (result.errors) {
      console.error('❌ GraphQL Errors:');
      for (const error of result.errors) {
        console.error(`  - ${error.message}`);
      }
      
      const hasCustomerError = result.errors.some((e: any) => 
        e.message?.toLowerCase().includes('customer') || 
        e.message?.toLowerCase().includes('permission')
      );
      
      if (hasCustomerError) {
        console.log('');
        console.log('⚠️  ERROR: Customer scope does not seem to be working!');
        console.log('   The access token might not have read_customers permission.');
      }
      
      process.exit(1);
    }

    const orders = result.data?.orders?.edges || [];
    console.log(`✅ Successfully fetched ${orders.length} orders\n`);

    console.log('='.repeat(80));
    console.log('3. CUSTOMER DATA ANALYSIS');
    console.log('='.repeat(80));
    console.log('');

    let ordersWithCustomer = 0;
    let ordersWithNumberOfOrders = 0;
    let newCustomers = 0;
    let returningCustomers = 0;
    let guestCheckouts = 0;

    for (const edge of orders) {
      const order = edge.node;
      
      if (order.customer?.id) {
        ordersWithCustomer++;
        if (order.customer?.numberOfOrders !== undefined && order.customer?.numberOfOrders !== null) {
          ordersWithNumberOfOrders++;
          const numOrders = parseInt(order.customer.numberOfOrders, 10);
          if (!isNaN(numOrders)) {
            if (numOrders === 1) {
              newCustomers++;
            } else {
              returningCustomers++;
            }
          }
        }
      } else {
        guestCheckouts++;
      }
    }

    console.log(`Total orders: ${orders.length}`);
    console.log(`  - Orders with customer.id: ${ordersWithCustomer}`);
    console.log(`  - Orders with customer.numberOfOrders: ${ordersWithNumberOfOrders}`);
    console.log(`  - NEW customers (numberOfOrders=1): ${newCustomers}`);
    console.log(`  - RETURNING customers (numberOfOrders>1): ${returningCustomers}`);
    console.log(`  - GUEST checkouts: ${guestCheckouts}`);
    console.log('');

    // Show examples
    if (ordersWithNumberOfOrders > 0) {
      console.log('Examples of orders with customer data:');
      console.log('');
      let shown = 0;
      for (const edge of orders) {
        const order = edge.node;
        if (order.customer?.id && order.customer?.numberOfOrders) {
          const numOrders = parseInt(order.customer.numberOfOrders, 10);
          const customerType = !isNaN(numOrders) && numOrders === 1 ? 'NEW' : 'RETURNING';
          console.log(`  ${order.name}:`);
          console.log(`    Customer: ${order.customer.email || order.customer.id.substring(0, 20)}...`);
          console.log(`    numberOfOrders: "${order.customer.numberOfOrders}"`);
          console.log(`    Type: ${customerType}`);
          console.log('');
          shown++;
          if (shown >= 5) break;
        }
      }
    }

    // Final verdict
    console.log('='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log('');

    if (ordersWithNumberOfOrders > 0) {
      console.log('✅ SUCCESS: read_customers scope is working!');
      console.log(`   Found ${ordersWithNumberOfOrders} orders with customer.numberOfOrders data.`);
    } else if (ordersWithCustomer > 0) {
      console.log('⚠️  PARTIAL: Customer IDs are returned, but numberOfOrders is missing.');
      console.log('   This might mean the scope is partially working or numberOfOrders is not available.');
    } else if (guestCheckouts === orders.length) {
      console.log('ℹ️  INFO: All orders are guest checkouts (no customer data).');
      console.log('   Scope appears to be working, but all orders for this date have no customer.');
    } else {
      console.log('❌ ERROR: read_customers scope does not appear to be working.');
      console.log('   No customer data is being returned from the API.');
    }
    console.log('');

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});


