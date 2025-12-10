/**
 * Verification Script for Shopify Customer Scope
 * 
 * Verifierar att read_customers scope fungerar och att customer-data
 * hämtas korrekt från Shopify GraphQL API.
 */

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrdersGraphQL } from '@/lib/integrations/shopify-graphql';
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
  const args = process.argv.slice(2);
  const tenantSlug = args.find((arg) => arg.startsWith('--tenant='))?.split('=')[1] || 'skinome';

  console.log('='.repeat(80));
  console.log('Shopify Customer Scope Verification');
  console.log('='.repeat(80));
  console.log(`Tenant: ${tenantSlug}\n`);

  // Step 1: Get tenant and connection
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, slug')
    .eq('slug', tenantSlug)
    .maybeSingle();

  if (!tenant) {
    console.error(`❌ Tenant "${tenantSlug}" not found`);
    process.exit(1);
  }

  console.log(`✅ Found tenant: ${tenant.name} (${tenant.slug})\n`);

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

  // Step 2: Check stored scopes in connection metadata
  console.log('='.repeat(80));
  console.log('1. CHECKING CONNECTION METADATA');
  console.log('='.repeat(80));
  console.log('');
  
  const storedScopes = connection.meta?.scope || connection.meta?.scopes;
  console.log('Stored scopes in connection metadata:');
  if (storedScopes) {
    if (typeof storedScopes === 'string') {
      const scopeList = storedScopes.split(',').map((s: string) => s.trim());
      console.log(`  ${scopeList.join(', ')}`);
      console.log(`  ✓ read_orders: ${scopeList.includes('read_orders') ? 'YES' : 'NO'}`);
      console.log(`  ✓ read_customers: ${scopeList.includes('read_customers') ? 'YES' : 'NO'}`);
    } else if (Array.isArray(storedScopes)) {
      console.log(`  ${storedScopes.join(', ')}`);
      console.log(`  ✓ read_orders: ${storedScopes.includes('read_orders') ? 'YES' : 'NO'}`);
      console.log(`  ✓ read_customers: ${storedScopes.includes('read_customers') ? 'YES' : 'NO'}`);
    } else {
      console.log(`  ${JSON.stringify(storedScopes)} (unknown format)`);
    }
  } else {
    console.log('  ⚠️  No scope information found in metadata');
  }
  console.log('');

  // Step 3: Get access token and verify with Shopify API
  console.log('='.repeat(80));
  console.log('2. VERIFYING ACCESS TOKEN WITH SHOPIFY API');
  console.log('='.repeat(80));
  console.log('');

  const accessToken = await getShopifyAccessToken(tenant.id);
  if (!accessToken) {
    console.error('❌ No access token found');
    process.exit(1);
  }

  console.log(`✅ Access token found (${accessToken.substring(0, 20)}...)\n`);

  // Step 4: Test GraphQL query with customer data
  console.log('='.repeat(80));
  console.log('3. TESTING GRAPHQL QUERY WITH CUSTOMER DATA');
  console.log('='.repeat(80));
  console.log('');

  // Test query to fetch orders with customer data
  const testQuery = `
    query TestCustomerData($query: String) {
      orders(first: 10, query: $query) {
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

  const normalizedShop = shopDomain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();

  const url = `https://${normalizedShop}/admin/api/2023-10/graphql.json`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        query: testQuery,
        variables: {
          query: 'created_at:>=2025-11-01 AND -test:true',
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`❌ Shopify GraphQL API error: ${response.status}`);
      console.error(`Response: ${body}`);
      process.exit(1);
    }

    const result = await response.json();

    if (result.errors) {
      console.error('❌ GraphQL Errors:');
      for (const error of result.errors) {
        console.error(`  - ${error.message}`);
        if (error.extensions) {
          console.error(`    Extensions: ${JSON.stringify(error.extensions, null, 2)}`);
        }
      }
      console.log('');
      
      // Check if error is related to customer access
      const hasCustomerError = result.errors.some((e: any) => 
        e.message?.toLowerCase().includes('customer') || 
        e.message?.toLowerCase().includes('permission') ||
        e.message?.toLowerCase().includes('access')
      );
      
      if (hasCustomerError) {
        console.log('⚠️  ERROR: Det verkar som att read_customers scope saknas eller är ogiltigt!');
        console.log('   Du behöver troligen omauktorisera Shopify-anslutningen med read_customers scope.\n');
      }
      
      process.exit(1);
    }

    const orders = result.data?.orders?.edges || [];
    console.log(`✅ Successfully fetched ${orders.length} orders\n`);

    // Step 5: Analyze customer data in results
    console.log('='.repeat(80));
    console.log('4. ANALYZING CUSTOMER DATA IN RESULTS');
    console.log('='.repeat(80));
    console.log('');

    let ordersWithCustomer = 0;
    let ordersWithNumberOfOrders = 0;
    let ordersWithoutCustomer = 0;

    const customerDataExamples: Array<{
      orderName: string;
      customerId: string | null;
      customerEmail: string | null;
      numberOfOrders: string | null;
    }> = [];

    for (const edge of orders) {
      const order = edge.node;
      
      customerDataExamples.push({
        orderName: order.name,
        customerId: order.customer?.id || null,
        customerEmail: order.customer?.email || null,
        numberOfOrders: order.customer?.numberOfOrders || null,
      });

      if (order.customer?.id) {
        ordersWithCustomer++;
        if (order.customer?.numberOfOrders !== undefined && order.customer?.numberOfOrders !== null) {
          ordersWithNumberOfOrders++;
        }
      } else {
        ordersWithoutCustomer++;
      }
    }

    console.log(`Total orders analyzed: ${orders.length}`);
    console.log(`  - Orders with customer.id: ${ordersWithCustomer}`);
    console.log(`  - Orders with customer.numberOfOrders: ${ordersWithNumberOfOrders}`);
    console.log(`  - Orders without customer (guest): ${ordersWithoutCustomer}`);
    console.log('');

    // Show examples
    console.log('Examples of customer data:');
    console.log('');
    for (let i = 0; i < Math.min(10, customerDataExamples.length); i++) {
      const ex = customerDataExamples[i];
      console.log(`Order ${ex.orderName}:`);
      console.log(`  Customer ID: ${ex.customerId || 'null (GUEST)'}`);
      console.log(`  Customer Email: ${ex.customerEmail || 'null'}`);
      console.log(`  numberOfOrders: ${ex.numberOfOrders !== null ? `"${ex.numberOfOrders}"` : 'null'}`);
      
      if (ex.customerId && ex.numberOfOrders !== null) {
        const numOrders = parseInt(ex.numberOfOrders, 10);
        if (!isNaN(numOrders)) {
          const customerType = numOrders === 1 ? 'NEW' : 'RETURNING';
          console.log(`  → Customer Type: ${customerType} (${numOrders} ${numOrders === 1 ? 'order' : 'orders'})`);
        }
      }
      console.log('');
    }

    // Step 6: Test with specific order from 2025-11-30
    console.log('='.repeat(80));
    console.log('5. TESTING SPECIFIC DATE (2025-11-30)');
    console.log('='.repeat(80));
    console.log('');

    const ordersForDate = await fetchShopifyOrdersGraphQL({
      tenantId: tenant.id,
      shopDomain,
      since: '2025-11-30',
      until: '2025-11-30',
      excludeTest: true,
    });

    console.log(`Fetched ${ordersForDate.length} orders for 2025-11-30\n`);

    let dateOrdersWithCustomer = 0;
    let dateOrdersWithNumberOfOrders = 0;
    let dateOrdersNewCustomer = 0;
    let dateOrdersReturningCustomer = 0;
    let dateOrdersGuest = 0;

    for (const order of ordersForDate) {
      if (order.customer?.id) {
        dateOrdersWithCustomer++;
        if (order.customer?.numberOfOrders !== undefined && order.customer?.numberOfOrders !== null) {
          dateOrdersWithNumberOfOrders++;
          const numOrders = parseInt(order.customer.numberOfOrders, 10);
          if (!isNaN(numOrders)) {
            if (numOrders === 1) {
              dateOrdersNewCustomer++;
            } else {
              dateOrdersReturningCustomer++;
            }
          }
        }
      } else {
        dateOrdersGuest++;
      }
    }

    console.log(`Customer breakdown for 2025-11-30:`);
    console.log(`  - Total orders: ${ordersForDate.length}`);
    console.log(`  - Orders with customer.id: ${dateOrdersWithCustomer}`);
    console.log(`  - Orders with customer.numberOfOrders: ${dateOrdersWithNumberOfOrders}`);
    console.log(`  - NEW customers (numberOfOrders=1): ${dateOrdersNewCustomer}`);
    console.log(`  - RETURNING customers (numberOfOrders>1): ${dateOrdersReturningCustomer}`);
    console.log(`  - GUEST checkouts: ${dateOrdersGuest}`);
    console.log('');

    // Show first 5 orders with customer data
    const ordersWithCustomerData = ordersForDate.filter(
      o => o.customer?.id && o.customer?.numberOfOrders !== undefined
    );

    if (ordersWithCustomerData.length > 0) {
      console.log(`First ${Math.min(5, ordersWithCustomerData.length)} orders with customer data:`);
      for (const order of ordersWithCustomerData.slice(0, 5)) {
        const numOrders = parseInt(order.customer!.numberOfOrders!, 10);
        const customerType = !isNaN(numOrders) && numOrders === 1 ? 'NEW' : 'RETURNING';
        console.log(`  ${order.name}: customerId=${order.customer!.id.substring(0, 30)}..., numberOfOrders="${order.customer!.numberOfOrders}", type=${customerType}`);
      }
      console.log('');
    } else {
      console.log('⚠️  WARNING: No orders with customer.numberOfOrders found for 2025-11-30!');
      console.log('   This could mean:');
      console.log('   1. read_customers scope is not properly authorized');
      console.log('   2. All orders for this date are guest checkouts');
      console.log('   3. Customer data is not being returned by the API\n');
    }

    // Final summary
    console.log('='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log('');

    const scopeWorking = dateOrdersWithNumberOfOrders > 0 || ordersWithNumberOfOrders > 0;
    
    if (scopeWorking) {
      console.log('✅ read_customers scope appears to be working correctly!');
      console.log(`   Found ${dateOrdersWithNumberOfOrders} orders with numberOfOrders data for 2025-11-30`);
    } else {
      console.log('❌ read_customers scope does NOT appear to be working!');
      console.log('   No orders with customer.numberOfOrders found.');
      console.log('   Action required: Re-authorize Shopify connection with read_customers scope');
    }
    console.log('');

  } catch (error) {
    console.error('❌ Error testing GraphQL query:');
    if (error instanceof Error) {
      console.error(`  ${error.message}`);
      if (error.stack) {
        console.error(`\nStack trace:\n${error.stack}`);
      }
    } else {
      console.error(`  ${JSON.stringify(error, null, 2)}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  if (error instanceof Error) {
    console.error('Stack:', error.stack);
  }
  process.exit(1);
});
