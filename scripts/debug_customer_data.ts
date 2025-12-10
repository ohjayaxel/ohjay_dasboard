/**
 * Debug script - Identifierar varför customer-data alltid är null
 * 
 * Steg för steg debugging:
 * 1. Verifierar endpoint (Admin GraphQL API)
 * 2. Kontrollerar att samma token används
 * 3. Verifierar scopes
 * 4. Loggar RAW GraphQL response för att se om customer finns i rådata
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
  console.log('DEBUG: CUSTOMER DATA PROBLEM');
  console.log('='.repeat(80));
  console.log('');

  // Step 1: Get tenant and connection
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
  const normalizedShop = shopDomain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();

  // Step 1: Verify endpoint
  console.log('='.repeat(80));
  console.log('STEP 1: VERIFY ENDPOINT');
  console.log('='.repeat(80));
  console.log('');
  
  const apiVersion = '2023-10'; // Check what version we're using
  const endpoint = `https://${normalizedShop}/admin/api/${apiVersion}/graphql.json`;
  
  console.log(`Endpoint: ${endpoint}`);
  console.log(`✅ Using Admin GraphQL API (not Storefront)`);
  console.log(`   Admin API: /admin/api/${apiVersion}/graphql.json`);
  console.log(`   Storefront: /api/${apiVersion}/graphql.json (NOT this)`);
  console.log('');

  // Step 2: Get access token
  console.log('='.repeat(80));
  console.log('STEP 2: VERIFY ACCESS TOKEN');
  console.log('='.repeat(80));
  console.log('');

  const accessToken = await getShopifyAccessToken(tenant.id);
  if (!accessToken) {
    console.error('❌ No access token found');
    process.exit(1);
  }

  console.log(`✅ Access token found`);
  console.log(`   Token preview: ${accessToken.substring(0, 20)}...${accessToken.substring(accessToken.length - 10)}`);
  console.log(`   Token length: ${accessToken.length} characters`);
  console.log('');

  // Step 3: Check scopes in metadata
  console.log('='.repeat(80));
  console.log('STEP 3: CHECK SCOPES IN METADATA');
  console.log('='.repeat(80));
  console.log('');

  const storedScopes = connection.meta?.scope || connection.meta?.scopes;
  if (storedScopes) {
    const scopeList = typeof storedScopes === 'string' 
      ? storedScopes.split(',').map((s: string) => s.trim())
      : storedScopes;
    console.log(`Stored scopes: ${scopeList.join(', ')}`);
    console.log(`  ✓ read_orders: ${scopeList.includes('read_orders') ? 'YES ✅' : 'NO ❌'}`);
    console.log(`  ✓ read_customers: ${scopeList.includes('read_customers') ? 'YES ✅' : 'NO ❌'}`);
  } else {
    console.log('⚠️  No scope information in metadata (but token might still have correct scopes)');
  }
  console.log('');

  // Step 4: Test with same query that works in scope verification
  console.log('='.repeat(80));
  console.log('STEP 4: TEST WITH SIMPLE QUERY (like scope verification)');
  console.log('='.repeat(80));
  console.log('');

  const simpleQuery = `
    query TestSimple {
      orders(first: 5, reverse: true) {
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

  try {
    const simpleResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query: simpleQuery }),
    });

    const simpleResult = await simpleResponse.json();

    if (simpleResult.errors) {
      console.log('❌ Errors in simple query:');
      for (const error of simpleResult.errors) {
        console.log(`  - ${error.message}`);
      }
      console.log('');
    }

    const simpleOrders = simpleResult.data?.orders?.edges || [];
    console.log(`✅ Fetched ${simpleOrders.length} orders with simple query`);
    
    let simpleWithCustomer = 0;
    for (const edge of simpleOrders) {
      const order = edge.node;
      if (order.customer?.id) {
        simpleWithCustomer++;
      }
    }
    console.log(`   Orders with customer.id: ${simpleWithCustomer}/${simpleOrders.length}`);
    console.log('');

    // Step 5: Test with date-filtered query (like we use in production)
    console.log('='.repeat(80));
    console.log('STEP 5: TEST WITH DATE-FILTERED QUERY (production query)');
    console.log('='.repeat(80));
    console.log('');

    const dateQuery = `
      query TestDateFiltered($query: String) {
        orders(first: 5, query: $query) {
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

    const dateResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        query: dateQuery,
        variables: {
          query: 'created_at:>=2025-11-30 AND created_at:<=2025-11-30',
        },
      }),
    });

    const dateResult = await dateResponse.json();

    if (dateResult.errors) {
      console.log('❌ Errors in date-filtered query:');
      for (const error of dateResult.errors) {
        console.log(`  - ${error.message}`);
      }
      console.log('');
    }

    const dateOrders = dateResult.data?.orders?.edges || [];
    console.log(`✅ Fetched ${dateOrders.length} orders with date-filtered query`);

    let dateWithCustomer = 0;
    for (const edge of dateOrders) {
      const order = edge.node;
      if (order.customer?.id) {
        dateWithCustomer++;
      }
    }
    console.log(`   Orders with customer.id: ${dateWithCustomer}/${dateOrders.length}`);
    console.log('');

    // Step 6: LOG RAW RESPONSE
    console.log('='.repeat(80));
    console.log('STEP 6: RAW GRAPHQL RESPONSE (first order)');
    console.log('='.repeat(80));
    console.log('');

    if (dateOrders.length > 0) {
      const firstOrder = dateOrders[0].node;
      console.log('First order from date-filtered query:');
      console.log(JSON.stringify(firstOrder, null, 2));
      console.log('');
      
      if (firstOrder.customer === null) {
        console.log('⚠️  customer is explicitly null (not missing, but null)');
      } else if (firstOrder.customer === undefined) {
        console.log('⚠️  customer is undefined (field not returned)');
      } else if (firstOrder.customer) {
        console.log('✅ customer object exists:', JSON.stringify(firstOrder.customer, null, 2));
      }
    } else {
      console.log('⚠️  No orders found for date filter');
      
      // Try with simple query instead
      if (simpleOrders.length > 0) {
        console.log('');
        console.log('Using first order from simple query instead:');
        const firstOrder = simpleOrders[0].node;
        console.log(JSON.stringify(firstOrder, null, 2));
        console.log('');
        
        if (firstOrder.customer === null) {
          console.log('⚠️  customer is explicitly null');
        } else if (firstOrder.customer === undefined) {
          console.log('⚠️  customer is undefined');
        } else if (firstOrder.customer) {
          console.log('✅ customer object exists:', JSON.stringify(firstOrder.customer, null, 2));
        }
      }
    }

    console.log('');

    // Step 7: Test with exact ORDERS_QUERY from shopify-graphql.ts
    console.log('='.repeat(80));
    console.log('STEP 7: TEST WITH EXACT PRODUCTION QUERY');
    console.log('='.repeat(80));
    console.log('');

    const productionQuery = `
      query OrdersForPeriod($cursor: String, $query: String) {
        orders(first: 3, after: $cursor, query: $query) {
          edges {
            cursor
            node {
              id
              name
              legacyResourceId
              createdAt
              processedAt
              currencyCode
              customer {
                id
                email
                numberOfOrders
              }
              lineItems(first: 1) {
                edges {
                  node {
                    id
                    sku
                    name
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const prodResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        query: productionQuery,
        variables: {
          query: 'created_at:>=2025-11-01 AND created_at:<=2025-11-30',
        },
      }),
    });

    const prodResult = await prodResponse.json();

    if (prodResult.errors) {
      console.log('❌ Errors in production query:');
      for (const error of prodResult.errors) {
        console.log(`  - ${error.message}`);
      }
      console.log('');
    }

    const prodOrders = prodResult.data?.orders?.edges || [];
    console.log(`✅ Fetched ${prodOrders.length} orders with production query`);

    let prodWithCustomer = 0;
    for (const edge of prodOrders) {
      const order = edge.node;
      if (order.customer?.id) {
        prodWithCustomer++;
      }
    }
    console.log(`   Orders with customer.id: ${prodWithCustomer}/${prodOrders.length}`);
    console.log('');

    if (prodOrders.length > 0) {
      console.log('RAW response for first production order:');
      console.log(JSON.stringify(prodOrders[0].node, null, 2));
      console.log('');
    }

    // Final summary
    console.log('='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log('');
    console.log('Endpoint verification:');
    console.log(`  - Using: ${endpoint}`);
    console.log(`  - Type: Admin GraphQL API ✅`);
    console.log('');
    console.log('Token verification:');
    console.log(`  - Same token used for all queries ✅`);
    console.log(`  - Token length: ${accessToken.length} chars`);
    console.log('');
    console.log('Scope verification:');
    if (storedScopes) {
      const scopeList = typeof storedScopes === 'string' 
        ? storedScopes.split(',').map((s: string) => s.trim())
        : storedScopes;
      console.log(`  - Stored: ${scopeList.join(', ')}`);
      console.log(`  - read_orders: ${scopeList.includes('read_orders') ? '✅' : '❌'}`);
      console.log(`  - read_customers: ${scopeList.includes('read_customers') ? '✅' : '❌'}`);
    } else {
      console.log(`  - Not stored in metadata (verify via API test)`);
    }
    console.log('');
    console.log('Query results:');
    console.log(`  - Simple query: ${simpleWithCustomer}/${simpleOrders.length} with customer`);
    console.log(`  - Date-filtered: ${dateWithCustomer}/${dateOrders.length} with customer`);
    console.log(`  - Production query: ${prodWithCustomer}/${prodOrders.length} with customer`);
    console.log('');

    if (simpleWithCustomer > 0 || prodWithCustomer > 0) {
      console.log('✅ Customer data IS available - problem might be with date filtering or specific orders');
    } else {
      console.log('❌ Customer data NOT available in any query - problem with token/scopes');
      console.log('   ACTION: Re-install app with read_customers scope');
    }
    console.log('');

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error('Stack:', error.stack);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});



