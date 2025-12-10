#!/usr/bin/env tsx

/**
 * Test script to directly query Google Ads API for customer 118-391-2529
 * This helps debug issues with API calls and header requirements
 */

import { createClient } from '@supabase/supabase-js';
import { decryptSecret } from '@/lib/integrations/crypto';

// Load environment variables
function loadEnvFile() {
  const fs = require('fs');
  const path = require('path');
  
  // Try loading from env/local.prod.sh first
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
  
  // Fallback to .env.local
  const envLocalPath = path.join(process.cwd(), '.env.local');
  if (fs.existsSync(envLocalPath)) {
    const content = fs.readFileSync(envLocalPath, 'utf-8');
    content.split('\n').forEach((line: string) => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const [, key, value] = match;
        const trimmedKey = key.trim();
        const trimmedValue = value.trim().replace(/^["']|["']$/g, '');
        if (!process.env[trimmedKey]) {
          process.env[trimmedKey] = trimmedValue;
        }
      }
    });
  }

  // Map SUPABASE_URL to NEXT_PUBLIC_SUPABASE_URL if needed
  if (process.env.SUPABASE_URL && !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
  }
}

loadEnvFile();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_DEVELOPER_TOKEN = process.env.GOOGLE_DEVELOPER_TOKEN;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing Supabase environment variables.');
  process.exit(1);
}

if (!ENCRYPTION_KEY) {
  console.error('❌ Missing ENCRYPTION_KEY environment variable.');
  process.exit(1);
}

if (!GOOGLE_DEVELOPER_TOKEN) {
  console.warn('⚠️ GOOGLE_DEVELOPER_TOKEN not set. API calls may fail.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GOOGLE_REPORTING_ENDPOINT = 'https://googleads.googleapis.com/v21/customers';
const TEST_CUSTOMER_ID = '1183912529'; // 118-391-2529 without dashes

async function main() {
  console.log('\n🔍 Google Ads API Test Script');
  console.log('=' .repeat(50));
  console.log(`Target Customer ID: ${TEST_CUSTOMER_ID} (118-391-2529)\n`);

  // Get tenant slug from args or default
  const tenantSlug = process.argv[2] || 'skinome';
  console.log(`📋 Testing for tenant: ${tenantSlug}\n`);

  // Get tenant ID
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, name, slug')
    .eq('slug', tenantSlug)
    .maybeSingle();

  if (tenantError || !tenant) {
    console.error(`❌ Failed to find tenant: ${tenantSlug}`);
    console.error(tenantError?.message);
    process.exit(1);
  }

  console.log(`✅ Found tenant: ${tenant.name} (${tenant.id})\n`);

  // Get Google Ads connection
  const { data: connection, error: connectionError } = await supabase
    .from('connections')
    .select('id, meta, access_token_enc')
    .eq('tenant_id', tenant.id)
    .eq('source', 'google_ads')
    .eq('status', 'connected')
    .maybeSingle();

  if (connectionError || !connection) {
    console.error('❌ Failed to find connected Google Ads connection');
    console.error(connectionError?.message);
    process.exit(1);
  }

  console.log('✅ Found Google Ads connection\n');

  // Decrypt access token
  if (!connection.access_token_enc) {
    console.error('❌ No access token found in connection');
    process.exit(1);
  }

  let accessToken: string;
  try {
    accessToken = decryptSecret(connection.access_token_enc);
  } catch (error) {
    console.error('❌ Failed to decrypt access token');
    console.error(error);
    process.exit(1);
  }

  console.log('✅ Access token decrypted\n');

  // Get login_customer_id from meta if available
  const meta = (connection.meta || {}) as Record<string, unknown>;
  const loginCustomerId = typeof meta.login_customer_id === 'string' ? meta.login_customer_id : null;
  const managerAccountId = loginCustomerId ? loginCustomerId.replace(/-/g, '') : null;

  console.log('📊 Connection Metadata:');
  console.log(`   login_customer_id: ${loginCustomerId || 'Not set'}`);
  console.log(`   managerAccountId (normalized): ${managerAccountId || 'Not set'}\n`);

  // Test 1: List accessible customers
  console.log('🧪 Test 1: List Accessible Customers');
  console.log('-'.repeat(50));
  let resourceNames: string[] = [];
  try {
    const response = await fetch(`${GOOGLE_REPORTING_ENDPOINT}:listAccessibleCustomers`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
      },
    });

    console.log(`Status: ${response.status} ${response.statusText}`);

    if (response.ok) {
      const data = await response.json();
      resourceNames = data.resourceNames || [];
      console.log(`✅ Found ${resourceNames.length} accessible customer(s):`);
      resourceNames.forEach((name: string, idx: number) => {
        const id = name.replace('customers/', '');
        console.log(`   ${idx + 1}. ${id} (${name})`);
      });
    } else {
      const errorText = await response.text();
      console.error(`❌ Failed: ${errorText.substring(0, 500)}`);
    }
  } catch (error) {
    console.error('❌ Error:', error);
  }

  console.log('\n');

  // Determine manager ID from accessible customers (from Test 1)
  let managerId: string | null = null;
  if (resourceNames.length > 0) {
    managerId = resourceNames[0].replace('customers/', '');
  } else {
    managerId = managerAccountId || '1992826509';
  }

  console.log(`🧪 Test 2: Get Manager Account Details (ID: ${managerId})`);
  console.log('-'.repeat(50));
  try {
    const response = await fetch(`${GOOGLE_REPORTING_ENDPOINT}/${managerId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
        'login-customer-id': managerId, // Use manager ID as login-customer-id
      },
    });

    console.log(`Status: ${response.status} ${response.statusText}`);
    console.log(`Using login-customer-id: ${managerId}`);

    if (response.ok) {
      const data = await response.json();
      const customer = data.customer;
      console.log('✅ Manager account details retrieved:');
      console.log(`   ID: ${customer?.id || managerId}`);
      console.log(`   Descriptive Name: ${customer?.descriptiveName || 'N/A'}`);
      console.log(`   Company Name: ${customer?.companyName || 'N/A'}`);
      console.log(`   Manager: ${customer?.manager ? 'Yes (MCC)' : 'No (Regular)'}`);
      console.log(`   Currency Code: ${customer?.currencyCode || 'N/A'}`);
      console.log(`   Time Zone: ${customer?.timeZone || 'N/A'}`);
    } else {
      const errorText = await response.text();
      console.error(`❌ Failed: ${errorText.substring(0, 500)}`);
    }
  } catch (error) {
    console.error('❌ Error:', error);
  }

  console.log('\n');

  // Test 3: Get TEST_CUSTOMER_ID details using manager as login-customer-id
  // (This simulates trying to access a child account through the manager)
  console.log(`🧪 Test 3: Get Child Account Details (${TEST_CUSTOMER_ID}) via Manager`);
  console.log('-'.repeat(50));
  if (managerId) {
    try {
      const response = await fetch(`${GOOGLE_REPORTING_ENDPOINT}/${TEST_CUSTOMER_ID}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
          'login-customer-id': managerId, // Use manager ID to access child account
        },
      });

      console.log(`Status: ${response.status} ${response.statusText}`);
      console.log(`Target customer: ${TEST_CUSTOMER_ID}`);
      console.log(`Using login-customer-id: ${managerId}`);

      if (response.ok) {
        const data = await response.json();
        const customer = data.customer;
        console.log('✅ Child account details retrieved:');
        console.log(`   ID: ${customer?.id || TEST_CUSTOMER_ID}`);
        console.log(`   Descriptive Name: ${customer?.descriptiveName || 'N/A'}`);
        console.log(`   Company Name: ${customer?.companyName || 'N/A'}`);
        console.log(`   Manager: ${customer?.manager ? 'Yes (MCC)' : 'No (Regular)'}`);
        console.log(`   Currency Code: ${customer?.currencyCode || 'N/A'}`);
      } else {
        const errorText = await response.text();
        console.error(`❌ Failed: ${errorText.substring(0, 500)}`);
      }
    } catch (error) {
      console.error('❌ Error:', error);
    }
    console.log('\n');
  }

  // Test 4: SearchStream query using manager account
  console.log('🧪 Test 4: SearchStream - Get Customer Clients (using manager account)');
  console.log('-'.repeat(50));
  if (managerId) {
    const query = `SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.manager FROM customer_client WHERE customer_client.status = 'ENABLED' AND customer_client.manager = false LIMIT 10`;

    try {
      const response = await fetch(
        `${GOOGLE_REPORTING_ENDPOINT}/${managerId}:googleAds:searchStream`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
            'login-customer-id': managerId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query }),
        },
      );

      console.log(`Status: ${response.status} ${response.statusText}`);
      console.log(`Using manager ID as login-customer-id: ${managerId}`);
      console.log(`Query: ${query}\n`);

      if (response.ok) {
        const responseText = await response.text();
        const lines = responseText.trim().split('\n').filter((line) => line.trim());

        console.log(`✅ Received ${lines.length} result line(s)\n`);

        let clientCount = 0;
        for (const line of lines) {
          try {
            const result = JSON.parse(line);
            const client = result.results?.[0]?.customerClient || result.customerClient;

            if (client) {
              clientCount++;
              const clientId = (client.clientCustomer || '').replace('customers/', '').trim();
              console.log(`   Client ${clientCount}:`);
              console.log(`      ID: ${clientId}`);
              console.log(`      Name: ${client.descriptiveName || 'N/A'}`);
              console.log(`      Manager: ${client.manager ? 'Yes' : 'No'}`);
              console.log('');
            }
          } catch (parseError) {
            // Skip invalid JSON lines
            continue;
          }
        }

        if (clientCount === 0) {
          console.log('⚠️ No customer clients found in response');
          console.log('Raw response (first 500 chars):');
          console.log(responseText.substring(0, 500));
        }
      } else {
        const errorText = await response.text();
        console.error(`❌ Failed: ${errorText.substring(0, 1000)}`);
      }
    } catch (error) {
      console.error('❌ Error:', error);
    }
    console.log('\n');
  }

  // Test 5: Alternative searchStream endpoint format
  console.log('🧪 Test 5: SearchStream - Alternative endpoint format');
  console.log('-'.repeat(50));
  if (managerId) {
    // Try using the manager ID in the path instead of customer-client query
    const query2 = `SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.manager FROM customer_client WHERE customer_client.status = 'ENABLED' AND customer_client.manager = false LIMIT 10`;

    try {
      // Try with manager ID in path AND as login-customer-id
      const response = await fetch(
        `${GOOGLE_REPORTING_ENDPOINT}/${managerId}/customerClients:searchStream`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
            'login-customer-id': managerId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: query2 }),
        },
      );

      console.log(`Status: ${response.status} ${response.statusText}`);
      console.log(`Endpoint: ${GOOGLE_REPORTING_ENDPOINT}/${managerId}/customerClients:searchStream`);
      console.log(`Using login-customer-id: ${managerId}\n`);

      if (response.ok) {
        const responseText = await response.text();
        const lines = responseText.trim().split('\n').filter((line) => line.trim());

        console.log(`✅ Received ${lines.length} result line(s)\n`);

        let clientCount = 0;
        for (const line of lines) {
          try {
            const result = JSON.parse(line);
            const client = result.results?.[0]?.customerClient || result.customerClient;

            if (client) {
              clientCount++;
              const clientId = (client.clientCustomer || '').replace('customers/', '').trim();
              console.log(`   Client ${clientCount}:`);
              console.log(`      ID: ${clientId}`);
              console.log(`      Name: ${client.descriptiveName || 'N/A'}`);
              console.log(`      Manager: ${client.manager ? 'Yes' : 'No'}`);
              console.log('');
            }
          } catch (parseError) {
            // Skip invalid JSON lines
            continue;
          }
        }

        if (clientCount === 0) {
          console.log('ℹ️ No customer clients found in alternative endpoint format');
          console.log('Raw response (first 500 chars):');
          console.log(responseText.substring(0, 500));
        }
      } else {
        const errorText = await response.text();
        console.log(`ℹ️ Response: ${errorText.substring(0, 500)}`);
        console.log('   (Alternative endpoint format may not be supported)');
      }
    } catch (error) {
      console.error('❌ Error:', error);
    }
    console.log('\n');
  }

  console.log('\n' + '='.repeat(50));
  console.log('✅ Test script completed\n');
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});

