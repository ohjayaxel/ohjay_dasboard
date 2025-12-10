#!/usr/bin/env tsx

/**
 * Test country fields using resourceName parsing and available view fields
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
  console.log(`\n🧪 ${name}`);
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
      let errorData: any = {};
      try {
        errorData = JSON.parse(errorText);
      } catch {}

      const errorMsg = errorData.error?.details?.[0]?.errors?.[0]?.message || errorData.error?.message || 'Unknown error';
      const errorCode = errorData.error?.details?.[0]?.errors?.[0]?.errorCode || {};
      console.log(`❌ FAILED: ${errorMsg}`);
      console.log(`   Error Code: ${JSON.stringify(errorCode)}`);
      return { success: false, rows: [] };
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
    return { success: true, rows: allRows };
  } catch (error) {
    console.log(`❌ EXCEPTION: ${error}`);
    return { success: false, rows: [] };
  }
}

async function main() {
  console.log('\n🔍 Testing Country Fields in Views (v2)');
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
  const targetCustomerId = '1183912529';

  // Test various field selections
  const tests = [
    {
      name: 'user_location_view - select all available fields',
      query: `
SELECT
  segments.date,
  user_location_view.resource_name,
  user_location_view.country_criterion_id,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros
FROM user_location_view
WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
LIMIT 10
      `.trim(),
    },
    {
      name: 'user_location_view - try target_location field',
      query: `
SELECT
  segments.date,
  user_location_view.resource_name,
  user_location_view.targeting_location,
  metrics.impressions
FROM user_location_view
WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
LIMIT 10
      `.trim(),
    },
    {
      name: 'geographic_view - select all available fields',
      query: `
SELECT
  segments.date,
  geographic_view.resource_name,
  geographic_view.country_criterion_id,
  geographic_view.location_type,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros
FROM geographic_view
WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
LIMIT 10
      `.trim(),
    },
    {
      name: 'geographic_view - select location_type',
      query: `
SELECT
  segments.date,
  geographic_view.resource_name,
  geographic_view.location_type,
  metrics.impressions
FROM geographic_view
WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
  AND geographic_view.location_type = 'COUNTRY'
LIMIT 10
      `.trim(),
    },
  ];

  for (const test of tests) {
    const result = await testQuery(test.name, test.query, targetCustomerId, loginCustomerId, accessToken);
    if (result.success && result.rows.length > 0) {
      console.log(`\nSample row structure:`);
      console.log(JSON.stringify(result.rows[0], null, 2));
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n' + '='.repeat(80) + '\n');
}

main().catch(console.error);


