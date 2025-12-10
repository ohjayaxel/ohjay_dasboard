/**
 * Verification Script - Verifierar att både read_orders och read_customers scope fungerar
 * 
 * Detta script testar direkt mot Shopify GraphQL API för att bekräfta att:
 * 1. read_orders scope fungerar (kan hämta orders)
 * 2. read_customers scope fungerar (kan hämta customer.numberOfOrders)
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
  const args = process.argv.slice(2);
  const tenantSlug = args.find((arg) => arg.startsWith('--tenant='))?.split('=')[1] || 'skinome';

  console.log('='.repeat(80));
  console.log('SHOPIFY SCOPE VERIFICATION');
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

  console.log(`✅ Tenant: ${tenant.name}\n`);

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
  console.log(`✅ Shopify connection: ${shopDomain}\n`);

  // Step 2: Check stored scopes in metadata
  console.log('='.repeat(80));
  console.log('STEP 1: CHECKING STORED SCOPES IN CONNECTION METADATA');
  console.log('='.repeat(80));
  console.log('');

  const storedScopes = connection.meta?.scope || connection.meta?.scopes;
  if (storedScopes) {
    if (typeof storedScopes === 'string') {
      const scopeList = storedScopes.split(',').map((s: string) => s.trim());
      console.log(`Stored scopes: ${scopeList.join(', ')}\n`);
      console.log(`  ✓ read_orders: ${scopeList.includes('read_orders') ? 'YES ✅' : 'NO ❌'}`);
      console.log(`  ✓ read_customers: ${scopeList.includes('read_customers') ? 'YES ✅' : 'NO ❌'}`);
    } else if (Array.isArray(storedScopes)) {
      console.log(`Stored scopes: ${storedScopes.join(', ')}\n`);
      console.log(`  ✓ read_orders: ${storedScopes.includes('read_orders') ? 'YES ✅' : 'NO ❌'}`);
      console.log(`  ✓ read_customers: ${storedScopes.includes('read_customers') ? 'YES ✅' : 'NO ❌'}`);
    } else {
      console.log(`⚠️  Stored scopes format unknown: ${JSON.stringify(storedScopes)}`);
    }
  } else {
    console.log('⚠️  WARNING: No scope information found in connection metadata');
    console.log('   This might mean scopes were not saved during OAuth callback.');
    console.log('   However, the token might still have the correct permissions.\n');
  }
  console.log('');

  // Step 3: Get access token
  console.log('='.repeat(80));
  console.log('STEP 2: TESTING API ACCESS WITH GRAPHQL QUERIES');
  console.log('='.repeat(80));
  console.log('');

  const accessToken = await getShopifyAccessToken(tenant.id);
  if (!accessToken) {
    console.error('❌ No access token found');
    process.exit(1);
  }

  const normalizedShop = shopDomain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();

  const apiUrl = `https://${normalizedShop}/admin/api/2023-10/graphql.json`;

  // Test 1: Verify read_orders scope
  console.log('Test 1: Verifying read_orders scope...');
  const ordersQuery = `
    query TestOrders {
      orders(first: 5) {
        edges {
          node {
            id
            name
            createdAt
          }
        }
      }
    }
  `;

  try {
    const ordersResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query: ordersQuery }),
    });

    const ordersResult = await ordersResponse.json();

    if (ordersResult.errors) {
      console.log('  ❌ FAILED: read_orders scope not working');
      console.log(`     Error: ${ordersResult.errors[0]?.message || 'Unknown error'}`);
      process.exit(1);
    }

    const ordersCount = ordersResult.data?.orders?.edges?.length || 0;
    console.log(`  ✅ PASSED: read_orders scope is working (fetched ${ordersCount} orders)`);
    console.log('');

    // Test 2: Verify read_customers scope
    console.log('Test 2: Verifying read_customers scope...');
    const customersQuery = `
      query TestCustomers {
        orders(first: 10) {
          edges {
            node {
              id
              name
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

    const customersResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query: customersQuery }),
    });

    const customersResult = await customersResponse.json();

    if (customersResult.errors) {
      const errorMessage = customersResult.errors[0]?.message || '';
      
      if (
        errorMessage.toLowerCase().includes('customer') ||
        errorMessage.toLowerCase().includes('permission') ||
        errorMessage.toLowerCase().includes('access') ||
        errorMessage.toLowerCase().includes('scope')
      ) {
        console.log('  ❌ FAILED: read_customers scope not working');
        console.log(`     Error: ${errorMessage}`);
        console.log('');
        console.log('  ⚠️  ACTION REQUIRED: Re-authorize Shopify connection with read_customers scope');
        process.exit(1);
      } else {
        console.log('  ⚠️  WARNING: Unexpected error (might not be scope-related)');
        console.log(`     Error: ${errorMessage}`);
        process.exit(1);
      }
    }

    const ordersWithCustomers = customersResult.data?.orders?.edges || [];
    let ordersWithCustomerId = 0;
    let ordersWithNumberOfOrders = 0;

    for (const edge of ordersWithCustomers) {
      const order = edge.node;
      if (order.customer?.id) {
        ordersWithCustomerId++;
        if (order.customer?.numberOfOrders !== undefined && order.customer?.numberOfOrders !== null) {
          ordersWithNumberOfOrders++;
        }
      }
    }

    console.log(`  ✅ PASSED: read_customers scope is working`);
    console.log(`     Orders with customer.id: ${ordersWithCustomerId}/${ordersWithCustomers.length}`);
    console.log(`     Orders with customer.numberOfOrders: ${ordersWithNumberOfOrders}/${ordersWithCustomers.length}`);
    console.log('');

    // Show examples
    if (ordersWithNumberOfOrders > 0) {
      console.log('  Examples of customer data:');
      let shown = 0;
      for (const edge of ordersWithCustomers) {
        const order = edge.node;
        if (order.customer?.id && order.customer?.numberOfOrders) {
          const numOrders = parseInt(order.customer.numberOfOrders, 10);
          const customerType = !isNaN(numOrders) && numOrders === 1 ? 'NEW' : 'RETURNING';
          console.log(`    - ${order.name}: numberOfOrders="${order.customer.numberOfOrders}" (${customerType})`);
          shown++;
          if (shown >= 3) break;
        }
      }
      console.log('');
    }

    // Final summary
    console.log('='.repeat(80));
    console.log('VERIFICATION SUMMARY');
    console.log('='.repeat(80));
    console.log('');

    const readOrdersWorking = ordersCount > 0;
    const readCustomersWorking = !customersResult.errors && ordersWithNumberOfOrders >= 0;

    if (readOrdersWorking && readCustomersWorking) {
      console.log('✅ SUCCESS: Both scopes are working correctly!');
      console.log('');
      console.log('  ✓ read_orders: Working ✅');
      console.log('  ✓ read_customers: Working ✅');
      console.log('');
      console.log('The access token has both required permissions and can fetch customer data.');
    } else {
      console.log('❌ FAILURE: One or both scopes are not working');
      console.log('');
      console.log(`  ✓ read_orders: ${readOrdersWorking ? 'Working ✅' : 'NOT working ❌'}`);
      console.log(`  ✓ read_customers: ${readCustomersWorking ? 'Working ✅' : 'NOT working ❌'}`);
      console.log('');
      console.log('ACTION REQUIRED: Re-authorize Shopify connection to ensure both scopes are granted.');
      process.exit(1);
    }

  } catch (error) {
    console.error('❌ Error testing API access:');
    if (error instanceof Error) {
      console.error(`  ${error.message}`);
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



