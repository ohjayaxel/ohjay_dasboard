#!/usr/bin/env tsx

/**
 * Diagnostic test suite for Google Ads API dimensions
 * Tests: Country data, Attribution Window, Query compatibility
 * NO CODE CHANGES - Pure diagnostics only
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

type TestResult = {
  phase: string;
  testName: string;
  query: string;
  success: boolean;
  error?: any;
  sampleRows?: any[];
  rowCount?: number;
};

const results: TestResult[] = [];

async function executeQuery(
  phase: string,
  testName: string,
  query: string,
  customerId: string,
  loginCustomerId: string | null,
  accessToken: string
): Promise<TestResult> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`${phase}: ${testName}`);
  console.log('='.repeat(80));
  console.log(`\nQuery:\n${query}\n`);

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
      } catch {
        // Keep raw text if not JSON
      }

      const result: TestResult = {
        phase,
        testName,
        query,
        success: false,
        error: errorData,
      };

      console.log(`❌ FAILED: ${response.status} ${response.statusText}`);
      console.log('\nFull Error Object:');
      console.log(JSON.stringify(errorData, null, 2));

      if (errorData.error) {
        console.log(`\nError Code: ${errorData.error.code}`);
        console.log(`Error Message: ${errorData.error.message}`);
        console.log(`Error Status: ${errorData.error.status}`);
        
        if (errorData.error.details) {
          console.log('\nError Details:');
          console.log(JSON.stringify(errorData.error.details, null, 2));
        }
      }

      return result;
    }

    const text = await response.text();
    
    // Parse JSON array response
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

    const sampleRows = allRows.slice(0, 5);

    console.log(`✅ SUCCESS - Received ${allRows.length} row(s)\n`);

    if (sampleRows.length > 0) {
      console.log('Sample Rows (first 5):\n');
      sampleRows.forEach((row, idx) => {
        console.log(`Row ${idx + 1}:`);
        console.log(JSON.stringify(row, null, 2));
        console.log('');
      });
    }

    const result: TestResult = {
      phase,
      testName,
      query,
      success: true,
      sampleRows,
      rowCount: allRows.length,
    };

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`❌ EXCEPTION: ${errorMessage}`);

    return {
      phase,
      testName,
      query,
      success: false,
      error: { exception: errorMessage },
    };
  }
}

async function main() {
  console.log('\n🔍 Google Ads API Dimensions Diagnostic Test Suite');
  console.log('='.repeat(80));

  const tenantSlug = process.argv[2] || 'skinome';
  
  // Calculate date range (same as working test)
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - 7);
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

  // Use child account for metrics (manager accounts can't query metrics)
  let targetCustomerId = selectedCustomerId;
  if (targetCustomerId === loginCustomerId && targetCustomerId === '1992826509') {
    targetCustomerId = '1183912529'; // Skinome child account
  }

  console.log(`📊 Connection Info:`);
  console.log(`   Target Customer ID: ${targetCustomerId}`);
  console.log(`   Login Customer ID (manager): ${loginCustomerId || 'N/A'}\n`);

  // ======================================================================
  // PHASE 1: Test Country via Existing Query
  // ======================================================================

  console.log('\n' + '='.repeat(80));
  console.log('PHASE 1: TEST COUNTRY VIA EXISTING QUERY');
  console.log('='.repeat(80));

  // Current working query + segments.country_criterion_id
  const phase1Query = `
SELECT
  segments.date,
  segments.country_criterion_id,
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

  const phase1Result = await executeQuery(
    'PHASE 1',
    'Add segments.country_criterion_id to existing query',
    phase1Query,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(phase1Result);

  // Small delay
  await new Promise(resolve => setTimeout(resolve, 500));

  // ======================================================================
  // PHASE 2A: Test Country via user_location_view
  // ======================================================================

  console.log('\n' + '='.repeat(80));
  console.log('PHASE 2A: TEST COUNTRY VIA user_location_view');
  console.log('='.repeat(80));

  const phase2aQuery = `
SELECT
  segments.date,
  user_location_view.country_criterion_id,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros,
  metrics.conversions,
  metrics.conversions_value
FROM user_location_view
WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
LIMIT 100
  `.trim();

  const phase2aResult = await executeQuery(
    'PHASE 2A',
    'Country via user_location_view',
    phase2aQuery,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(phase2aResult);

  await new Promise(resolve => setTimeout(resolve, 500));

  // ======================================================================
  // PHASE 2B: Test Country via geographic_view
  // ======================================================================

  console.log('\n' + '='.repeat(80));
  console.log('PHASE 2B: TEST COUNTRY VIA geographic_view');
  console.log('='.repeat(80));

  const phase2bQuery = `
SELECT
  segments.date,
  geographic_view.country_criterion_id,
  geographic_view.location_type,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros,
  metrics.conversions,
  metrics.conversions_value
FROM geographic_view
WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
LIMIT 100
  `.trim();

  const phase2bResult = await executeQuery(
    'PHASE 2B',
    'Country via geographic_view',
    phase2bQuery,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(phase2bResult);

  await new Promise(resolve => setTimeout(resolve, 500));

  // ======================================================================
  // PHASE 3: Test Attribution Window
  // ======================================================================

  console.log('\n' + '='.repeat(80));
  console.log('PHASE 3: TEST ATTRIBUTION WINDOW');
  console.log('='.repeat(80));

  const phase3Query = `
SELECT
  conversion_action.id,
  conversion_action.name,
  conversion_action.category,
  conversion_action.click_through_lookback_window_days,
  conversion_action.view_through_lookback_window_days,
  conversion_action.attribution_model_settings.attribution_model
FROM conversion_action
LIMIT 50
  `.trim();

  const phase3Result = await executeQuery(
    'PHASE 3',
    'Attribution Window via conversion_action',
    phase3Query,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(phase3Result);

  // ======================================================================
  // PHASE 4: Compatibility Analysis
  // ======================================================================

  console.log('\n\n' + '='.repeat(80));
  console.log('PHASE 4: COMPATIBILITY ANALYSIS');
  console.log('='.repeat(80));

  console.log('\n📊 TEST RESULTS SUMMARY:\n');

  results.forEach((result, idx) => {
    const status = result.success ? '✅ SUCCESS' : '❌ FAILED';
    console.log(`${idx + 1}. ${result.testName}: ${status}`);
    if (result.success && result.rowCount) {
      console.log(`   Rows returned: ${result.rowCount}`);
    }
    if (!result.success && result.error) {
      const errorCode = result.error?.error?.code || result.error?.exception || 'UNKNOWN';
      const errorMsg = result.error?.error?.message || result.error?.exception || 'No error message';
      console.log(`   Error: ${errorCode} - ${errorMsg.substring(0, 100)}`);
    }
  });

  console.log('\n\n🔍 COMPATIBILITY ANALYSIS:\n');

  // 1. Country data options
  console.log('1. COUNTRY DATA OPTIONS:');
  console.log('-'.repeat(80));
  
  if (phase1Result.success) {
    console.log('✅ Option A: Add segments.country_criterion_id to existing query');
    console.log('   Status: VIABLE');
    console.log('   Data shape: Same structure as existing query');
    console.log('   Cardinality: 1 row per (date, campaign, ad_group, country)');
    console.log('   Joining: Direct integration - no join needed\n');
  } else {
    console.log('❌ Option A: Add segments.country_criterion_id to existing query');
    console.log('   Status: NOT VIABLE');
    if (phase1Result.error?.error?.details) {
      const details = phase1Result.error.error.details[0];
      if (details.errors) {
        const errorMsg = details.errors[0]?.message || 'Unknown error';
        console.log(`   Reason: ${errorMsg}\n`);
      }
    }
  }

  if (phase2aResult.success) {
    console.log('✅ Option B: Query user_location_view separately');
    console.log('   Status: VIABLE');
    console.log('   Data shape: (date, country_criterion_id, metrics)');
    console.log('   Cardinality: 1 row per (date, country) - aggregated across campaigns');
    console.log('   Joining: Requires join on date & customer_id\n');
  } else {
    console.log('❌ Option B: Query user_location_view separately');
    console.log('   Status: NOT VIABLE');
    if (phase2aResult.error?.error?.details) {
      const details = phase2aResult.error.error.details[0];
      if (details.errors) {
        const errorMsg = details.errors[0]?.message || 'Unknown error';
        console.log(`   Reason: ${errorMsg}\n`);
      }
    }
  }

  if (phase2bResult.success) {
    console.log('✅ Option C: Query geographic_view separately');
    console.log('   Status: VIABLE');
    console.log('   Data shape: (date, country_criterion_id, metrics)');
    console.log('   Cardinality: 1 row per (date, country) - aggregated across campaigns');
    console.log('   Joining: Requires join on date & customer_id\n');
  } else {
    console.log('❌ Option C: Query geographic_view separately');
    console.log('   Status: NOT VIABLE');
    if (phase2bResult.error?.error?.details) {
      const details = phase2bResult.error.error.details[0];
      if (details.errors) {
        const errorMsg = details.errors[0]?.message || 'Unknown error';
        console.log(`   Reason: ${errorMsg}\n`);
      }
    }
  }

  // 2. Attribution window
  console.log('2. ATTRIBUTION WINDOW:');
  console.log('-'.repeat(80));
  
  if (phase3Result.success) {
    console.log('✅ Attribution window data IS available');
    console.log('   Source: conversion_action resource');
    console.log('   Fields available:');
    console.log('     - click_through_lookback_window_days');
    console.log('     - view_through_lookback_window_days');
    console.log('     - attribution_model');
    console.log('   Note: This is conversion-action level, not per-transaction');
    console.log('   Cardinality: 1 row per conversion action\n');
  } else {
    console.log('❌ Attribution window data NOT directly available via GAQL');
    if (phase3Result.error?.error?.details) {
      const details = phase3Result.error.error.details[0];
      if (details.errors) {
        const errorMsg = details.errors[0]?.message || 'Unknown error';
        console.log(`   Reason: ${errorMsg}\n`);
      }
    }
  }

  // 3. Recommendations
  console.log('3. RECOMMENDATIONS:');
  console.log('-'.repeat(80));
  
  const viableOptions: string[] = [];
  if (phase1Result.success) viableOptions.push('Add country_criterion_id to existing query');
  if (phase2aResult.success) viableOptions.push('Use user_location_view for country breakdown');
  if (phase2bResult.success) viableOptions.push('Use geographic_view for country breakdown');

  if (viableOptions.length > 0) {
    console.log('\nViable options for country data:');
    viableOptions.forEach((option, idx) => {
      console.log(`   ${idx + 1}. ${option}`);
    });
  } else {
    console.log('\n⚠️  No viable options found for country data segmentation');
  }

  console.log('\n' + '='.repeat(80));
  console.log('✅ Diagnostic test suite completed\n');
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});

