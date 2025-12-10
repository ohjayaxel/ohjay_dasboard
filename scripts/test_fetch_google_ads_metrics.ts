#!/usr/bin/env tsx

/**
 * Test script to fetch Google Ads metrics with dimensions (date, country, attribution model)
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
  console.log('\n🧪 Testing Google Ads Metrics with Dimensions');
  console.log('='.repeat(80));

  const tenantSlug = process.argv[2] || 'skinome';
  const daysBack = parseInt(process.argv[3] || '7');
  
  // Calculate date range
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  
  const sinceStr = since.toISOString().slice(0, 10);
  const untilStr = until.toISOString().slice(0, 10);

  console.log(`\n📋 Testing for tenant: ${tenantSlug}`);
  console.log(`   Date range: ${sinceStr} to ${untilStr}\n`);

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
  
  const loginCustomerId = typeof meta.login_customer_id === 'string'
    ? meta.login_customer_id.replace(/-/g, '')
    : selectedCustomerId;

  // If selected customer is manager account, use known child account for metrics
  let targetCustomerId = selectedCustomerId;
  if (targetCustomerId === loginCustomerId && targetCustomerId === '1992826509') {
    // Manager account - use child account for metrics
    targetCustomerId = '1183912529'; // Skinome child account
    console.log(`⚠️  Selected customer is manager account. Using child account ${targetCustomerId} for metrics.\n`);
  }

  if (!targetCustomerId) {
    console.error('❌ No customer ID selected');
    process.exit(1);
  }

  console.log(`📊 Connection Info:`);
  console.log(`   Target Customer ID (for metrics): ${targetCustomerId}`);
  console.log(`   Login Customer ID (manager): ${loginCustomerId || 'N/A'}\n`);

  // GAQL Query with metrics and dimensions
  // Start with basic metrics + date, then we'll add country dimension
  // Note: Attribution window is not a segment field - it's set at account/campaign level
  const query = `
SELECT
  segments.date,
  campaign.id,
  campaign.name,
  ad_group.id,
  ad_group.name,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros,
  metrics.conversions,
  metrics.conversions_value
FROM ad_group
WHERE
  segments.date >= '${sinceStr}'
  AND segments.date <= '${untilStr}'
  AND campaign.status != 'REMOVED'
ORDER BY segments.date DESC
LIMIT 100
  `.trim();

  console.log('📡 Fetching metrics with dimensions...\n');
  console.log('Query:', query.substring(0, 200) + '...\n');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': GOOGLE_DEVELOPER_TOKEN || '',
    'Content-Type': 'application/json',
  };

  // Always use manager account as login-customer-id when querying child account
  if (loginCustomerId && targetCustomerId !== loginCustomerId) {
    headers['login-customer-id'] = loginCustomerId;
  }

  try {
    const response = await fetch(
      `${GOOGLE_REPORTING_ENDPOINT}/${targetCustomerId}/googleAds:searchStream`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ query }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ FAILED: ${response.status} ${response.statusText}`);
      console.error(`Error: ${errorText.substring(0, 500)}`);
      process.exit(1);
    }

    const text = await response.text();
    
    // Parse JSON array response
    let results: any[] = [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        results = parsed;
      } else if (parsed.results) {
        results = [parsed];
      }
    } catch {
      // Fallback to newline-delimited
      const lines = text.trim().split('\n').filter(line => line.trim());
      results = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(r => r !== null);
    }

    console.log(`✅ SUCCESS - Received ${results.length} result batch(es)\n`);

    const insights: Array<{
      date: string;
      country_code: string;
      attribution_model: string;
      campaign_id: string | null;
      adgroup_id: string | null;
      ad_id: string | null;
      cost_micros: number | null;
      impressions: number | null;
      clicks: number | null;
      conversions: number | null;
      revenue: number | null;
    }> = [];

    for (const result of results) {
      if (result.results && Array.isArray(result.results)) {
        for (const item of result.results) {
          const segments = item.segments || {};
          const metrics = item.metrics || {};
          const adGroupAd = item.adGroupAd || {};

          const campaign = item.campaign || {};
          const adGroup = item.adGroup || {};

          insights.push({
            date: segments.date || '',
            country_code: '', // Will add later - geo_target_country requires specific views
            attribution_model: '', // Attribution window is not a segment - would need to fetch from campaign settings separately
            campaign_id: campaign.id ? String(campaign.id) : null,
            adgroup_id: adGroup.id ? String(adGroup.id) : null,
            ad_id: null, // Not available in ad_group view query
            cost_micros: metrics.costMicros || metrics.cost_micros || null,
            impressions: metrics.impressions || null,
            clicks: metrics.clicks || null,
            conversions: metrics.conversions || null,
            revenue: metrics.conversionsValue || metrics.conversions_value || null,
          });
        }
      }
    }

    console.log(`📊 Parsed ${insights.length} insight rows:\n`);

    // Group by date and show summary
    const byDate = new Map<string, number>();
    const byCountry = new Map<string, number>();
    const byAttribution = new Map<string, number>();

    for (const insight of insights) {
      byDate.set(insight.date, (byDate.get(insight.date) || 0) + 1);
      if (insight.country_code) {
        byCountry.set(insight.country_code, (byCountry.get(insight.country_code) || 0) + 1);
      }
      if (insight.attribution_model) {
        byAttribution.set(insight.attribution_model, (byAttribution.get(insight.attribution_model) || 0) + 1);
      }
    }

    console.log('📅 By Date:');
    Array.from(byDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([date, count]) => {
        console.log(`   ${date}: ${count} rows`);
      });

    console.log('\n🌍 By Country:');
    Array.from(byCountry.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([country, count]) => {
        console.log(`   ${country}: ${count} rows`);
      });

    console.log('\n📊 By Attribution Model:');
    Array.from(byAttribution.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([model, count]) => {
        console.log(`   ${model}: ${count} rows`);
      });

    // Show first few rows as example
    console.log('\n📋 Sample Rows (first 5):');
    insights.slice(0, 5).forEach((insight, idx) => {
      console.log(`\n   ${idx + 1}. Date: ${insight.date}`);
      console.log(`      Country: ${insight.country_code || 'N/A'}`);
      console.log(`      Attribution: ${insight.attribution_model || 'N/A'}`);
      console.log(`      Campaign: ${insight.campaign_id || 'N/A'}`);
      console.log(`      Cost: ${insight.cost_micros ? (insight.cost_micros / 1_000_000).toFixed(2) : 'N/A'}`);
      console.log(`      Impressions: ${insight.impressions || 0}`);
      console.log(`      Clicks: ${insight.clicks || 0}`);
      console.log(`      Conversions: ${insight.conversions || 0}`);
    });

    // Calculate totals
    const totals = insights.reduce((acc, insight) => {
      acc.cost_micros += insight.cost_micros || 0;
      acc.impressions += insight.impressions || 0;
      acc.clicks += insight.clicks || 0;
      acc.conversions += insight.conversions || 0;
      acc.revenue += insight.revenue || 0;
      return acc;
    }, { cost_micros: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 });

    console.log('\n\n💰 Totals:');
    console.log(`   Cost: ${(totals.cost_micros / 1_000_000).toFixed(2)}`);
    console.log(`   Impressions: ${totals.impressions.toLocaleString()}`);
    console.log(`   Clicks: ${totals.clicks.toLocaleString()}`);
    console.log(`   Conversions: ${totals.conversions.toLocaleString()}`);
    console.log(`   Revenue: ${totals.revenue.toFixed(2)}`);

    console.log('\n' + '='.repeat(80));
    console.log(`✅ Successfully fetched ${insights.length} insight rows\n`);

  } catch (error) {
    console.error(`❌ Exception:`, error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});

