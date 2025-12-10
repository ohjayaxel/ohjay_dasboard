#!/usr/bin/env tsx

/**
 * Test alternative field names for country dimension in Google Ads API
 */

import { createClient } from '@supabase/supabase-js';
import { decryptSecret } from '@/lib/integrations/crypto';

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

async function testQuery(name: string, query: string, customerId: string, loginCustomerId: string | null, accessToken: string) {
  console.log(`\n🧪 Test: ${name}`);
  console.log('-'.repeat(80));
  console.log(`Query:\n${query}\n`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
    'Content-Type': 'application/json',
  };

  if (loginCustomerId && customerId !== loginCustomerId) {
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

    if (!response.ok) {
      const errorText = await response.text();
      let errorData: any = { raw: errorText };
      try {
        errorData = JSON.parse(errorText);
      } catch {}

      console.log(`❌ FAILED: ${response.status} ${response.statusText}`);
      const errorMsg = errorData.error?.message || errorData.error?.details?.[0]?.errors?.[0]?.message || 'Unknown error';
      const errorCode = errorData.error?.details?.[0]?.errors?.[0]?.errorCode || {};
      console.log(`   Error Code: ${JSON.stringify(errorCode)}`);
      console.log(`   Error Message: ${errorMsg}`);
      console.log(`   Full Error: ${JSON.stringify(errorData, null, 2).substring(0, 500)}`);
      return false;
    }

    const text = await response.text();
    let parsedResults: any[] = [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        parsedResults = parsed;
      } else if (parsed.results) {
        parsedResults = [parsed];
      }
    } catch {
      const lines = text.trim().split('\n').filter(line => line.trim());
      parsedResults = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(r => r !== null);
    }

    const allRows: any[] = [];
    for (const result of parsedResults) {
      if (result.results && Array.isArray(result.results)) {
        allRows.push(...result.results);
      }
    }

    console.log(`✅ SUCCESS - ${allRows.length} rows`);
    if (allRows.length > 0) {
      console.log(`Sample row structure:\n${JSON.stringify(allRows[0], null, 2).substring(0, 500)}...`);
    }
    return true;
  } catch (error) {
    console.log(`❌ EXCEPTION: ${error}`);
    return false;
  }
}

async function main() {
  console.log('\n🔍 Testing Alternative Country Field Names');
  console.log('='.repeat(80));

  const tenantSlug = 'skinome';
  const sinceStr = '2025-12-03';
  const untilStr = '2025-12-10';

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', tenantSlug)
    .maybeSingle();

  if (!tenant) {
    console.error('❌ Tenant not found');
    process.exit(1);
  }

  const { data: connection } = await supabase
    .from('connections')
    .select('meta, access_token_enc')
    .eq('tenant_id', tenant.id)
    .eq('source', 'google_ads')
    .eq('status', 'connected')
    .maybeSingle();

  if (!connection?.access_token_enc) {
    console.error('❌ No connection found');
    process.exit(1);
  }

  const accessToken = decryptSecret(connection.access_token_enc);
  const meta = (connection.meta || {}) as Record<string, unknown>;
  const loginCustomerId = typeof meta.login_customer_id === 'string'
    ? meta.login_customer_id.replace(/-/g, '')
    : '1992826509';
  const targetCustomerId = '1183912529'; // Child account

  // Test various country field names
  const tests = [
    {
      name: 'user_location.country_criterion_id in user_location_view',
      query: `
SELECT
  segments.date,
  user_location.country_criterion_id,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros
FROM user_location_view
WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
LIMIT 10
      `.trim(),
    },
    {
      name: 'user_location.country_criterion_id in ad_group',
      query: `
SELECT
  segments.date,
  user_location.country_criterion_id,
  campaign.id,
  metrics.impressions
FROM ad_group
WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
LIMIT 10
      `.trim(),
    },
    {
      name: 'geo_target_constant.country_code in geographic_view',
      query: `
SELECT
  segments.date,
  geo_target_constant.country_code,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros
FROM geographic_view
WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
LIMIT 10
      `.trim(),
    },
    {
      name: 'segments.user_location in user_location_view',
      query: `
SELECT
  segments.date,
  segments.user_location,
  metrics.impressions,
  metrics.clicks
FROM user_location_view
WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
LIMIT 10
      `.trim(),
    },
    {
      name: 'geo_target_constant.resource_name in geographic_view',
      query: `
SELECT
  segments.date,
  geo_target_constant.resource_name,
  geo_target_constant.name,
  metrics.impressions
FROM geographic_view
WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
LIMIT 10
      `.trim(),
    },
  ];

  for (const test of tests) {
    await testQuery(test.name, test.query, targetCustomerId, loginCustomerId, accessToken);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n' + '='.repeat(80) + '\n');
}

main().catch(console.error);

