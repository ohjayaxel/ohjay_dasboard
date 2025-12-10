#!/usr/bin/env tsx

/**
 * Test script to fetch actual data from Google Ads API using the corrected endpoint format
 */

import { createClient } from '@supabase/supabase-js';
import { decryptSecret } from '@/lib/integrations/crypto';

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

  if (process.env.SUPABASE_URL && !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
  }
}

loadEnvFile();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_DEVELOPER_TOKEN = process.env.GOOGLE_DEVELOPER_TOKEN;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ENCRYPTION_KEY) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const GOOGLE_REPORTING_ENDPOINT = 'https://googleads.googleapis.com/v21/customers';

async function main() {
  console.log('\n🧪 Testing Google Ads API Data Fetch');
  console.log('='.repeat(80));

  const tenantSlug = process.argv[2] || 'skinome';
  console.log(`\n📋 Testing for tenant: ${tenantSlug}\n`);

  // Get tenant
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, slug')
    .eq('slug', tenantSlug)
    .maybeSingle();

  if (!tenant) {
    console.error(`❌ Tenant not found: ${tenantSlug}`);
    process.exit(1);
  }

  console.log(`✅ Found tenant: ${tenant.name} (${tenant.id})\n`);

  // Get connection
  const { data: connection } = await supabase
    .from('connections')
    .select('id, meta, access_token_enc')
    .eq('tenant_id', tenant.id)
    .eq('source', 'google_ads')
    .eq('status', 'connected')
    .maybeSingle();

  if (!connection?.access_token_enc) {
    console.error('❌ No Google Ads connection found');
    process.exit(1);
  }

  const accessToken = decryptSecret(connection.access_token_enc);
  const meta = (connection.meta || {}) as Record<string, unknown>;
  const selectedCustomerId = typeof meta.selected_customer_id === 'string' 
    ? meta.selected_customer_id.replace(/-/g, '') 
    : typeof meta.customer_id === 'string' 
    ? meta.customer_id.replace(/-/g, '') 
    : null;

  console.log('📊 Connection Info:');
  console.log(`   Selected Customer ID: ${selectedCustomerId || 'Not set'}`);
  console.log(`   Access Token: ${accessToken.substring(0, 20)}...\n`);

  if (!selectedCustomerId) {
    console.log('⚠️ No customer ID selected. Testing with manager account from listAccessibleCustomers...\n');
    
    // Get manager account from listAccessibleCustomers
    const listResponse = await fetch(`${GOOGLE_REPORTING_ENDPOINT}:listAccessibleCustomers`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
      },
    });

    if (!listResponse.ok) {
      console.error('❌ Failed to list accessible customers');
      process.exit(1);
    }

    const listData = await listResponse.json();
    const resourceNames = listData.resourceNames || [];
    
    if (resourceNames.length === 0) {
      console.error('❌ No accessible customers found');
      process.exit(1);
    }

    const managerId = resourceNames[0].replace('customers/', '');
    console.log(`   Using manager account: ${managerId}\n`);
    
    await testFetchCustomerClients(accessToken, managerId, managerId);
  } else {
    // Use selected customer ID
    const managerId = typeof meta.login_customer_id === 'string' 
      ? meta.login_customer_id.replace(/-/g, '') 
      : null;
    
    console.log(`📡 Testing data fetch for customer: ${selectedCustomerId}`);
    if (managerId) {
      console.log(`   Using login-customer-id: ${managerId} (manager account)\n`);
    } else {
      console.log(`   No manager account specified\n`);
    }

    // Test 1: Fetch customer details via searchStream
    await testFetchCustomerDetails(accessToken, selectedCustomerId, managerId);

    // Test 2: Fetch customer clients (if it's a manager account)
    if (managerId === selectedCustomerId) {
      await testFetchCustomerClients(accessToken, selectedCustomerId, managerId);
    }

    // Test 3: Fetch campaign data
    if (managerId === selectedCustomerId) {
      // For manager accounts, try first child account for campaigns
      const childId = '1183912529'; // Known child account
      console.log(`📡 Testing campaigns with child account: ${childId}\n`);
      await testFetchCampaigns(accessToken, childId, managerId);
    } else {
      await testFetchCampaigns(accessToken, selectedCustomerId, managerId);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('✅ Test completed\n');
}

async function testFetchCustomerDetails(
  accessToken: string,
  customerId: string,
  loginCustomerId: string | null
) {
  console.log('🧪 Test 1: Fetch Customer Details');
  console.log('-'.repeat(80));

  // Note: Cannot query customer resource directly from itself, need to use a different approach
  // For manager accounts, we can query customer_client with clientCustomer = customers/{customerId}
  const query = `SELECT customer_client.descriptive_name, customer_client.manager, customer_client.currency_code FROM customer_client WHERE customer_client.client_customer = 'customers/${customerId}' LIMIT 1`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
    'Content-Type': 'application/json',
  };

  if (loginCustomerId) {
    headers['login-customer-id'] = loginCustomerId;
  }

  try {
    const response = await fetch(
      `${GOOGLE_REPORTING_ENDPOINT}/${customerId}/googleAds:searchStream`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ query }),
      },
    );

    if (response.ok) {
      const text = await response.text();
      
      // Try parsing as JSON array first (searchStream may return array)
      let results: any[] = [];
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          results = parsed;
        } else if (parsed.results) {
          results = [parsed];
        }
      } catch {
        // Fallback to newline-delimited JSON
        const lines = text.trim().split('\n').filter(line => line.trim());
        results = lines.map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }).filter(r => r !== null);
      }

      console.log(`✅ SUCCESS - Received ${results.length} result(s)\n`);

      for (const result of results) {
        const customer = result.results?.[0]?.customer || result.customer;
        if (customer) {
          console.log('   Customer Details:');
          console.log(`      ID: ${customer.id || customerId}`);
          console.log(`      Name: ${customer.descriptiveName || customer.companyName || 'N/A'}`);
          console.log(`      Manager: ${customer.manager ? 'Yes (MCC)' : 'No (Regular)'}`);
          console.log(`      Currency: ${customer.currencyCode || 'N/A'}`);
          console.log(`      Time Zone: ${customer.timeZone || 'N/A'}`);
          break; // Only show first result
        }
      }
    } else {
      const errorText = await response.text();
      console.error(`❌ FAILED: ${response.status} ${response.statusText}`);
      console.error(`   Error: ${errorText.substring(0, 300)}`);
    }
  } catch (error) {
    console.error(`❌ Exception: ${error}`);
  }

  console.log('');
}

async function testFetchCustomerClients(
  accessToken: string,
  managerId: string,
  loginCustomerId: string
) {
  console.log('🧪 Test 2: Fetch Customer Clients from Manager Account');
  console.log('-'.repeat(80));

  const query = `SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.manager FROM customer_client WHERE customer_client.status = 'ENABLED' AND customer_client.manager = FALSE LIMIT 10`;

  try {
    const response = await fetch(
      `${GOOGLE_REPORTING_ENDPOINT}/${managerId}/googleAds:searchStream`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
          'login-customer-id': loginCustomerId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      },
    );

    if (response.ok) {
      const text = await response.text();
      
      // Try parsing as JSON array first
      let results: any[] = [];
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          results = parsed;
        } else if (parsed.results) {
          results = [parsed];
        }
      } catch {
        // Fallback to newline-delimited JSON
        const lines = text.trim().split('\n').filter(line => line.trim());
        results = lines.map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }).filter(r => r !== null);
      }

      console.log(`✅ SUCCESS - Received ${results.length} result(s)\n`);

      const clients: Array<{ id: string; name: string; manager: boolean }> = [];

      for (const result of results) {
        // Handle different response structures
        if (result.results && Array.isArray(result.results)) {
          // Standard structure: { results: [{ customerClient: {...} }] }
          for (const item of result.results) {
            const client = item.customerClient;
            if (client && client.clientCustomer) {
              const clientId = client.clientCustomer.replace('customers/', '').trim();
              clients.push({
                id: clientId,
                name: client.descriptiveName || clientId,
                manager: client.manager === true,
              });
            }
          }
        } else if (result.customerClient) {
          // Direct structure: { customerClient: {...} }
          const client = result.customerClient;
          if (client.clientCustomer) {
            const clientId = client.clientCustomer.replace('customers/', '').trim();
            clients.push({
              id: clientId,
              name: client.descriptiveName || clientId,
              manager: client.manager === true,
            });
          }
        }
      }

      if (clients.length > 0) {
        console.log(`   Found ${clients.length} child account(s):\n`);
        clients.forEach((client, idx) => {
          console.log(`   ${idx + 1}. ${client.name} (${client.id})`);
        });
      } else {
        console.log('   No child accounts found');
      }
    } else {
      const errorText = await response.text();
      console.error(`❌ FAILED: ${response.status} ${response.statusText}`);
      console.error(`   Error: ${errorText.substring(0, 300)}`);
    }
  } catch (error) {
    console.error(`❌ Exception: ${error}`);
  }

  console.log('');
}

async function testFetchCampaigns(
  accessToken: string,
  customerId: string,
  loginCustomerId: string | null
) {
  console.log('🧪 Test 3: Fetch Campaigns');
  console.log('-'.repeat(80));

  const query = `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.id LIMIT 5`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
    'Content-Type': 'application/json',
  };

  if (loginCustomerId) {
    headers['login-customer-id'] = loginCustomerId;
  }

  try {
    const response = await fetch(
      `${GOOGLE_REPORTING_ENDPOINT}/${customerId}/googleAds:searchStream`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ query }),
      },
    );

    if (response.ok) {
      const text = await response.text();
      
      // Try parsing as JSON array first
      let results: any[] = [];
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          results = parsed;
        } else if (parsed.results) {
          results = [parsed];
        }
      } catch {
        // Fallback to newline-delimited JSON
        const lines = text.trim().split('\n').filter(line => line.trim());
        results = lines.map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }).filter(r => r !== null);
      }

      console.log(`✅ SUCCESS - Received ${results.length} result(s)\n`);

      const campaigns: Array<{ id: string; name: string; status: string; channel: string }> = [];

      for (const result of results) {
        // Handle different response structures
        if (result.results && Array.isArray(result.results)) {
          for (const item of result.results) {
            const campaign = item.campaign;
            if (campaign) {
              campaigns.push({
                id: String(campaign.id || ''),
                name: campaign.name || 'N/A',
                status: campaign.status || 'N/A',
                channel: campaign.advertisingChannelType || 'N/A',
              });
            }
          }
        } else if (result.campaign) {
          campaigns.push({
            id: String(result.campaign.id || ''),
            name: result.campaign.name || 'N/A',
            status: result.campaign.status || 'N/A',
            channel: result.campaign.advertisingChannelType || 'N/A',
          });
        }
      }

      if (campaigns.length > 0) {
        console.log(`   Found ${campaigns.length} campaign(s):\n`);
        campaigns.forEach((campaign, idx) => {
          console.log(`   ${idx + 1}. ${campaign.name} (ID: ${campaign.id})`);
          console.log(`      Status: ${campaign.status}, Channel: ${campaign.channel}`);
        });
      } else {
        console.log('   No campaigns found');
      }
    } else {
      const errorText = await response.text();
      console.error(`❌ FAILED: ${response.status} ${response.statusText}`);
      console.error(`   Error: ${errorText.substring(0, 300)}`);
    }
  } catch (error) {
    console.error(`❌ Exception: ${error}`);
  }

  console.log('');
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});

