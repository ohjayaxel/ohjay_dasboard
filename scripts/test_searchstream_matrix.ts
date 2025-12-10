#!/usr/bin/env tsx

/**
 * Systematic test matrix for Google Ads API v21 SearchStream REST endpoints
 * Tests all possible path/header combinations to find the ONE valid pattern
 * 
 * DO NOT MODIFY - This is a diagnostic test script only
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
const { decryptSecret } = require('@/lib/integrations/crypto');

const GOOGLE_REPORTING_ENDPOINT = 'https://googleads.googleapis.com/v21/customers';

// Test parameters
const managerId = '1992826509';
const childId = '1183912529'; // Non-dashed format

// GAQL query to fetch customer clients from manager account
const GAQL_QUERY = `
SELECT
  customer_client.client_customer,
  customer_client.descriptive_name,
  customer_client.manager
FROM customer_client
WHERE
  customer_client.status = 'ENABLED'
  AND customer_client.manager = FALSE
LIMIT 10
`.trim();

type TestCase = {
  name: string;
  path: string;
  headers: Record<string, string>;
  description: string;
};

async function main() {
  console.log('\n🔍 Google Ads API v21 SearchStream REST Endpoint Test Matrix');
  console.log('='.repeat(80));
  console.log(`\nTest Parameters:`);
  console.log(`  Manager ID: ${managerId}`);
  console.log(`  Child ID: ${childId}`);
  console.log(`  GAQL Query: ${GAQL_QUERY.substring(0, 50)}...\n`);

  // Get tenant and access token
  const tenantSlug = process.argv[2] || 'skinome';
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', tenantSlug)
    .maybeSingle();

  if (!tenant) {
    console.error(`❌ Tenant not found: ${tenantSlug}`);
    process.exit(1);
  }

  const { data: connection } = await supabase
    .from('connections')
    .select('access_token_enc')
    .eq('tenant_id', tenant.id)
    .eq('source', 'google_ads')
    .eq('status', 'connected')
    .maybeSingle();

  if (!connection?.access_token_enc) {
    console.error('❌ No access token found');
    process.exit(1);
  }

  const accessToken = decryptSecret(connection.access_token_enc);
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
  };

  // Define test matrix: 6 path formats × 2 header variants = 12 combinations
  const testCases: TestCase[] = [
    // Path format 1: {managerId}:searchStream
    {
      name: '1A',
      path: `${GOOGLE_REPORTING_ENDPOINT}/${managerId}:searchStream`,
      headers: { ...baseHeaders },
      description: `POST /v21/customers/${managerId}:searchStream (no login-customer-id)`,
    },
    {
      name: '1B',
      path: `${GOOGLE_REPORTING_ENDPOINT}/${managerId}:searchStream`,
      headers: { ...baseHeaders, 'login-customer-id': managerId },
      description: `POST /v21/customers/${managerId}:searchStream (login-customer-id: ${managerId})`,
    },

    // Path format 2: {managerId}/googleAds:searchStream
    {
      name: '2A',
      path: `${GOOGLE_REPORTING_ENDPOINT}/${managerId}/googleAds:searchStream`,
      headers: { ...baseHeaders },
      description: `POST /v21/customers/${managerId}/googleAds:searchStream (no login-customer-id)`,
    },
    {
      name: '2B',
      path: `${GOOGLE_REPORTING_ENDPOINT}/${managerId}/googleAds:searchStream`,
      headers: { ...baseHeaders, 'login-customer-id': managerId },
      description: `POST /v21/customers/${managerId}/googleAds:searchStream (login-customer-id: ${managerId})`,
    },

    // Path format 3: {managerId}:googleAds:searchStream
    {
      name: '3A',
      path: `${GOOGLE_REPORTING_ENDPOINT}/${managerId}:googleAds:searchStream`,
      headers: { ...baseHeaders },
      description: `POST /v21/customers/${managerId}:googleAds:searchStream (no login-customer-id)`,
    },
    {
      name: '3B',
      path: `${GOOGLE_REPORTING_ENDPOINT}/${managerId}:googleAds:searchStream`,
      headers: { ...baseHeaders, 'login-customer-id': managerId },
      description: `POST /v21/customers/${managerId}:googleAds:searchStream (login-customer-id: ${managerId})`,
    },

    // Path format 4: {childId}:searchStream
    {
      name: '4A',
      path: `${GOOGLE_REPORTING_ENDPOINT}/${childId}:searchStream`,
      headers: { ...baseHeaders },
      description: `POST /v21/customers/${childId}:searchStream (no login-customer-id)`,
    },
    {
      name: '4B',
      path: `${GOOGLE_REPORTING_ENDPOINT}/${childId}:searchStream`,
      headers: { ...baseHeaders, 'login-customer-id': managerId },
      description: `POST /v21/customers/${childId}:searchStream (login-customer-id: ${managerId})`,
    },

    // Path format 5: {childId}/googleAds:searchStream
    {
      name: '5A',
      path: `${GOOGLE_REPORTING_ENDPOINT}/${childId}/googleAds:searchStream`,
      headers: { ...baseHeaders },
      description: `POST /v21/customers/${childId}/googleAds:searchStream (no login-customer-id)`,
    },
    {
      name: '5B',
      path: `${GOOGLE_REPORTING_ENDPOINT}/${childId}/googleAds:searchStream`,
      headers: { ...baseHeaders, 'login-customer-id': managerId },
      description: `POST /v21/customers/${childId}/googleAds:searchStream (login-customer-id: ${managerId})`,
    },

    // Path format 6: {childId}:googleAds:searchStream
    {
      name: '6A',
      path: `${GOOGLE_REPORTING_ENDPOINT}/${childId}:googleAds:searchStream`,
      headers: { ...baseHeaders },
      description: `POST /v21/customers/${childId}:googleAds:searchStream (no login-customer-id)`,
    },
    {
      name: '6B',
      path: `${GOOGLE_REPORTING_ENDPOINT}/${childId}:googleAds:searchStream`,
      headers: { ...baseHeaders, 'login-customer-id': managerId },
      description: `POST /v21/customers/${childId}:googleAds:searchStream (login-customer-id: ${managerId})`,
    },
  ];

  console.log('\n📊 TEST MATRIX RESULTS\n');
  console.log('-'.repeat(80));

  const results: Array<{
    name: string;
    status: number;
    statusText: string;
    error?: string;
    responsePreview?: string;
    description: string;
  }> = [];

  // Test each combination
  for (const testCase of testCases) {
    try {
      const response = await fetch(testCase.path, {
        method: 'POST',
        headers: {
          ...testCase.headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: GAQL_QUERY }),
      });

      const status = response.status;
      const statusText = response.statusText;
      let responsePreview = '';
      let error = '';

      if (response.ok) {
        const text = await response.text();
        responsePreview = text.substring(0, 200);
        
        // Try to parse if JSON
        try {
          const json = JSON.parse(text);
          responsePreview = JSON.stringify(json).substring(0, 200);
        } catch {
          // Keep as text
        }
      } else {
        const text = await response.text();
        error = text.substring(0, 300);
      }

      results.push({
        name: testCase.name,
        status,
        statusText,
        error: error || undefined,
        responsePreview: responsePreview || undefined,
        description: testCase.description,
      });

      // Status emoji
      const emoji = status === 200 ? '✅' : status === 404 ? '❌' : status === 401 || status === 403 ? '🔒' : '⚠️';
      
      console.log(`\n${emoji} ${testCase.name}: ${testCase.description}`);
      console.log(`   Status: ${status} ${statusText}`);
      
      if (status === 200) {
        console.log(`   ✅ SUCCESS - Response preview: ${responsePreview}`);
      } else if (status === 404) {
        console.log(`   ❌ 404 Not Found - Endpoint does not exist`);
      } else if (status === 401 || status === 403) {
        console.log(`   🔒 Auth/Permission Error - Endpoint may exist but access denied`);
        console.log(`   Error: ${error.substring(0, 100)}`);
      } else {
        console.log(`   ⚠️ Unexpected status: ${error.substring(0, 100)}`);
      }

      // Small delay between requests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`\n❌ ${testCase.name}: ${testCase.description}`);
      console.log(`   Exception: ${errorMsg}`);
      
      results.push({
        name: testCase.name,
        status: 0,
        statusText: 'EXCEPTION',
        error: errorMsg,
        description: testCase.description,
      });
    }
  }

  // Summary
  console.log('\n\n' + '='.repeat(80));
  console.log('📋 SUMMARY');
  console.log('='.repeat(80));

  const successful = results.filter(r => r.status === 200);
  const notFound = results.filter(r => r.status === 404);
  const authErrors = results.filter(r => r.status === 401 || r.status === 403);
  const otherErrors = results.filter(r => r.status > 0 && r.status !== 200 && r.status !== 404 && r.status !== 401 && r.status !== 403);

  console.log(`\n✅ Successful (200): ${successful.length}`);
  successful.forEach(r => {
    console.log(`   - ${r.name}: ${r.description}`);
  });

  console.log(`\n❌ Not Found (404): ${notFound.length}`);
  notFound.forEach(r => {
    console.log(`   - ${r.name}: ${r.description}`);
  });

  console.log(`\n🔒 Auth/Permission Errors (401/403): ${authErrors.length}`);
  authErrors.forEach(r => {
    console.log(`   - ${r.name}: ${r.description}`);
  });

  if (otherErrors.length > 0) {
    console.log(`\n⚠️ Other Errors: ${otherErrors.length}`);
    otherErrors.forEach(r => {
      console.log(`   - ${r.name} (${r.status}): ${r.description}`);
    });
  }

  // Identify the valid pattern
  if (successful.length > 0) {
    console.log('\n\n🎯 VALID PATTERN(S) IDENTIFIED:');
    console.log('='.repeat(80));
    successful.forEach(r => {
      console.log(`\n✅ Pattern ${r.name} WORKS:`);
      console.log(`   ${r.description}`);
      if (r.responsePreview) {
        console.log(`   Response preview: ${r.responsePreview.substring(0, 150)}...`);
      }
    });
  } else {
    console.log('\n\n⚠️ NO VALID PATTERNS FOUND');
    console.log('='.repeat(80));
    console.log('\nNone of the tested endpoint formats returned 200 OK.');
    console.log('\nPossible reasons:');
    console.log('1. None of these path formats are valid REST transcoding patterns');
    console.log('2. All endpoints require different authentication/permissions');
    console.log('3. REST transcoding for SearchStream may not be available in v21');
    console.log('4. The correct path format is not in this test matrix');
  }

  console.log('\n' + '='.repeat(80) + '\n');
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});


