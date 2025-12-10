/**
 * Test script to diagnose Google Ads child account detection
 * Tests the actual endpoint and query format used in production
 */

import { createClient } from '@supabase/supabase-js';

// Load environment variables
function loadEnvFile() {
  const fs = require('fs');
  const path = require('path');
  
  const envShPath = path.join(process.cwd(), 'env', 'local.prod.sh');
  if (fs.existsSync(envShPath)) {
    const content = fs.readFileSync(envShPath, 'utf-8');
    content.split('\n').forEach((line: string) => {
      const match = line.match(/^export\s+(\w+)="?([^"]+)"?$/);
      if (match) {
        const [, key, value] = match;
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    });
  }
  
  try {
    require('dotenv').config({ path: '.env.local' });
  } catch {
    // dotenv not available, skip
  }
}

loadEnvFile();

const GOOGLE_REPORTING_ENDPOINT = 'https://googleads.googleapis.com/v21/customers';

import { decryptSecret } from '../lib/integrations/crypto';

async function main() {
  console.log('\n🔍 Google Ads Child Account Detection Test');
  console.log('='.repeat(80));
  
  const GOOGLE_DEVELOPER_TOKEN = process.env.GOOGLE_DEVELOPER_TOKEN;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing SUPABASE environment variables');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  
  // Get tenant (default: skinome)
  const tenantSlug = process.argv[2] || 'skinome';
  console.log(`\n📋 Testing for tenant: ${tenantSlug}\n`);

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, slug')
    .eq('slug', tenantSlug)
    .maybeSingle();

  if (!tenant) {
    console.error(`❌ Tenant not found: ${tenantSlug}`);
    process.exit(1);
  }

  const { data: connection } = await supabase
    .from('connections')
    .select('access_token_enc, meta')
    .eq('tenant_id', tenant.id)
    .eq('source', 'google_ads')
    .eq('status', 'connected')
    .maybeSingle();

  if (!connection?.access_token_enc) {
    console.error('❌ No access token found for this tenant');
    process.exit(1);
  }

  const accessToken = decryptSecret(connection.access_token_enc);
  if (!accessToken) {
    console.error('❌ Failed to decrypt access token');
    process.exit(1);
  }

  console.log('✅ Access token retrieved\n');

  // Step 1: List accessible customers
  console.log('🧪 Step 1: List Accessible Customers');
  console.log('-'.repeat(80));
  
  const listResponse = await fetch(
    `${GOOGLE_REPORTING_ENDPOINT}:listAccessibleCustomers`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
      },
    },
  );

  if (!listResponse.ok) {
    const errorText = await listResponse.text();
    console.error(`❌ Failed to list accessible customers: ${listResponse.status}`);
    console.error(`   Error: ${errorText.substring(0, 500)}`);
    process.exit(1);
  }

  const listData = await listResponse.json();
  const resourceNames = listData.resourceNames || [];
  
  console.log(`✅ Found ${resourceNames.length} accessible customer(s):`);
  for (const resourceName of resourceNames) {
    const customerId = resourceName.replace('customers/', '');
    console.log(`   - ${customerId}`);
  }

  // Step 2: Check which ones are manager accounts
  console.log('\n🧪 Step 2: Check Manager Status');
  console.log('-'.repeat(80));
  
  const managerAccountIds: string[] = [];
  const regularAccountIds: string[] = [];

  for (const resourceName of resourceNames) {
    const customerId = resourceName.replace('customers/', '');
    
    try {
      const customerResponse = await fetch(`${GOOGLE_REPORTING_ENDPOINT}/${customerId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
          'login-customer-id': customerId,
        },
      });

      if (customerResponse.ok) {
        const customerData = await customerResponse.json();
        const customer = customerData.customer;
        
        const isManager = customer?.manager === true;
        console.log(`   ${customerId}: ${isManager ? 'MANAGER (MCC)' : 'Regular'}`);
        
        if (isManager) {
          managerAccountIds.push(customerId);
        } else {
          regularAccountIds.push(customerId);
        }
      } else {
        console.log(`   ${customerId}: Failed to fetch details (${customerResponse.status})`);
      }
    } catch (error) {
      console.error(`   ${customerId}: Error - ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Manager accounts: ${managerAccountIds.length}`);
  console.log(`   Regular accounts: ${regularAccountIds.length}`);

  // Step 3: If we have manager accounts, try to fetch child accounts
  if (managerAccountIds.length > 0 && regularAccountIds.length === 0) {
    console.log('\n🧪 Step 3: Fetch Child Accounts from Manager');
    console.log('-'.repeat(80));
    
    for (const managerId of managerAccountIds) {
      console.log(`\n   Testing manager: ${managerId}`);
      
      // Test different endpoint formats and queries
      const tests = [
        {
          name: 'customer_client query (current production)',
          endpoint: `${GOOGLE_REPORTING_ENDPOINT}/${managerId}/googleAds:searchStream`,
          query: `SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.manager FROM customer_client WHERE customer_client.status = 'ENABLED' AND customer_client.manager = false LIMIT 100`,
        },
        {
          name: 'customer_client query (alternative)',
          endpoint: `${GOOGLE_REPORTING_ENDPOINT}/${managerId}/googleAds:searchStream`,
          query: `SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.manager = false LIMIT 100`,
        },
        {
          name: 'customer_client query (no status filter)',
          endpoint: `${GOOGLE_REPORTING_ENDPOINT}/${managerId}/googleAds:searchStream`,
          query: `SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.manager FROM customer_client WHERE customer_client.manager = false LIMIT 100`,
        },
      ];

      for (const test of tests) {
        console.log(`\n      Testing: ${test.name}`);
        console.log(`      Endpoint: ${test.endpoint}`);
        console.log(`      Query: ${test.query.substring(0, 80)}...`);
        
        try {
          const searchResponse = await fetch(test.endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
              'login-customer-id': managerId,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: test.query }),
          });

          const status = searchResponse.status;
          console.log(`      Status: ${status} ${searchResponse.statusText}`);

          if (searchResponse.ok) {
            const responseText = await searchResponse.text();
            console.log(`      Response length: ${responseText.length} bytes`);
            console.log(`      Response preview (first 500 chars):`);
            console.log(`      ${responseText.substring(0, 500)}`);
            
            // Try to parse
            try {
              // Try JSON array first
              const parsed = JSON.parse(responseText);
              if (Array.isArray(parsed)) {
                console.log(`      ✅ Parsed as JSON array with ${parsed.length} items`);
                for (let i = 0; i < Math.min(3, parsed.length); i++) {
                  console.log(`      Item ${i}: ${JSON.stringify(parsed[i]).substring(0, 200)}`);
                }
              } else if (parsed.results && Array.isArray(parsed.results)) {
                console.log(`      ✅ Parsed as object with results array (${parsed.results.length} items)`);
                for (let i = 0; i < Math.min(3, parsed.results.length); i++) {
                  const result = parsed.results[i];
                  const client = result.customerClient || result.results?.[0]?.customerClient;
                  console.log(`      Result ${i}:`, JSON.stringify(client).substring(0, 200));
                }
              } else {
                console.log(`      ⚠️  Parsed as single object:`, JSON.stringify(parsed).substring(0, 300));
              }
            } catch (parseError) {
              // Try newline-delimited JSON
              const lines = responseText.trim().split('\n').filter(line => line.trim());
              console.log(`      📝 Detected ${lines.length} newline-delimited JSON lines`);
              
              for (let i = 0; i < Math.min(3, lines.length); i++) {
                try {
                  const parsed = JSON.parse(lines[i]);
                  console.log(`      Line ${i}:`, JSON.stringify(parsed).substring(0, 200));
                } catch {
                  console.log(`      Line ${i} (raw):`, lines[i].substring(0, 200));
                }
              }
            }
          } else {
            const errorText = await searchResponse.text();
            console.log(`      ❌ Error response: ${errorText.substring(0, 500)}`);
          }
        } catch (error) {
          console.error(`      ❌ Exception: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } else {
    console.log('\n✅ No need to fetch child accounts - regular accounts found directly');
  }

  console.log('\n' + '='.repeat(80) + '\n');
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});

