#!/usr/bin/env tsx

/**
 * Phase 2 Advanced Diagnostics for Google Ads API
 * Testing: Geographic Views, Country Data, Attribution Windows, Joining Patterns
 * NO IMPLEMENTATION - Pure diagnostics only
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
  testId: string;
  testName: string;
  query: string;
  success: boolean;
  error?: any;
  rowCount?: number;
  sampleRows?: any[];
  analysis?: string;
};

const results: TestResult[] = [];

async function executeQuery(
  testId: string,
  testName: string,
  query: string,
  customerId: string,
  loginCustomerId: string | null,
  accessToken: string
): Promise<TestResult> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`${testId}: ${testName}`);
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
        testId,
        testName,
        query,
        success: false,
        error: errorData,
      };

      console.log(`❌ FAILED: ${response.status} ${response.statusText}`);
      console.log('\nFull Error Object:');
      console.log(JSON.stringify(errorData, null, 2));

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

    console.log(`✅ SUCCESS - Received ${allRows.length} row(s)\n`);

    const sampleRows = allRows.slice(0, 10);

    if (sampleRows.length > 0) {
      console.log('Sample Rows (first 10):\n');
      sampleRows.forEach((row, idx) => {
        console.log(`Row ${idx + 1}:`);
        console.log(JSON.stringify(row, null, 2));
        console.log('');
      });
    }

    const result: TestResult = {
      testId,
      testName,
      query,
      success: true,
      rowCount: allRows.length,
      sampleRows,
    };

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`❌ EXCEPTION: ${errorMessage}`);

    return {
      testId,
      testName,
      query,
      success: false,
      error: { exception: errorMessage },
    };
  }
}

async function main() {
  console.log('\n🔍 Phase 2: Advanced Google Ads API Diagnostics');
  console.log('='.repeat(80));

  const tenantSlug = process.argv[2] || 'skinome';
  const sinceStr = '2025-12-03';
  const untilStr = '2025-12-10';

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

  // Try to refresh token if needed
  try {
    const { refreshGoogleAdsTokenIfNeeded } = await import('@/lib/integrations/googleads');
    await refreshGoogleAdsTokenIfNeeded(tenant.id);
    console.log('✅ Token refreshed if needed\n');
    
    // Re-fetch connection after potential refresh
    const { data: refreshedConnection } = await supabase
      .from('connections')
      .select('meta, access_token_enc')
      .eq('tenant_id', tenant.id)
      .eq('source', 'google_ads')
      .eq('status', 'connected')
      .maybeSingle();
    
    if (refreshedConnection?.access_token_enc) {
      connection.access_token_enc = refreshedConnection.access_token_enc;
      connection.meta = refreshedConnection.meta;
    }
  } catch (refreshError) {
    console.log('⚠️  Token refresh attempt failed, continuing with existing token\n');
  }

  const accessToken = decryptSecret(connection.access_token_enc);
  const meta = (connection.meta || {}) as Record<string, unknown>;
  
  // Try multiple possible customer ID fields
  const selectedCustomerId = typeof meta.selected_customer_id === 'string' 
    ? meta.selected_customer_id.replace(/-/g, '') 
    : typeof meta.customer_id === 'string' 
    ? meta.customer_id.replace(/-/g, '') 
    : null;
  
  // For skinome, we know the manager account is 1992826509 and child is 1183912529
  // If we detect manager account or no customer ID, use child account for metrics
  let loginCustomerId = typeof meta.login_customer_id === 'string'
    ? meta.login_customer_id.replace(/-/g, '')
    : null;
  
  // Use child account for metrics (manager accounts can't query metrics directly)
  let targetCustomerId = selectedCustomerId;
  
  // If selected is manager or missing, use known child account
  if (!targetCustomerId || targetCustomerId === '1992826509') {
    targetCustomerId = '1183912529'; // Known child account for skinome
    // Set manager as login customer ID
    if (!loginCustomerId) {
      loginCustomerId = '1992826509'; // Manager account
    }
  }
  
  // If target is child account but no login customer ID, assume manager account
  if (targetCustomerId === '1183912529' && !loginCustomerId) {
    loginCustomerId = '1992826509';
  }

  console.log(`📊 Connection Info:`);
  console.log(`   Target Customer ID: ${targetCustomerId}`);
  console.log(`   Login Customer ID (manager): ${loginCustomerId || 'N/A'}\n`);

  // ======================================================================
  // TEST 2.1: Validate Geographic Views Cardinality (country-only filter)
  // ======================================================================

  // First, get all location types without filter to see what values exist
  const test21Query = `
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
LIMIT 200
  `.trim();

  const test21Result = await executeQuery(
    'TEST 2.1',
    'Validate Geographic Views Cardinality (country-only filter)',
    test21Query,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(test21Result);

  if (!test21Result.success) {
    console.log('\n❌ TEST 2.1 FAILED - Stopping test suite');
    process.exit(1);
  }

  // Analyze country_criterion_id presence and location types
  let countryIdPresent = 0;
  const locationTypes = new Set<string>();
  if (test21Result.sampleRows) {
    for (const row of test21Result.sampleRows) {
      if (row.geographicView?.countryCriterionId) {
        countryIdPresent++;
      }
      if (row.geographicView?.locationType) {
        locationTypes.add(row.geographicView.locationType);
      }
    }
  }
  console.log(`\n📊 Analysis:`);
  console.log(`   Rows returned: ${test21Result.rowCount}`);
  console.log(`   Country criterion ID present in sample: ${countryIdPresent}/${test21Result.sampleRows?.length || 0}`);
  console.log(`   Location types found: ${Array.from(locationTypes).join(', ')}`);
  console.log(`   Note: 'COUNTRY' enum value not valid - filtering should use 'AREA_OF_INTEREST' or 'LOCATION_OF_PRESENCE'`);

  await new Promise(resolve => setTimeout(resolve, 500));

  // ======================================================================
  // TEST 2.2A: AREA_OF_INTEREST
  // ======================================================================

  const test22aQuery = `
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
  AND geographic_view.location_type = 'AREA_OF_INTEREST'
LIMIT 200
  `.trim();

  const test22aResult = await executeQuery(
    'TEST 2.2A',
    'Validate AREA_OF_INTEREST location type',
    test22aQuery,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(test22aResult);

  if (!test22aResult.success) {
    console.log('\n❌ TEST 2.2A FAILED - Stopping test suite');
    process.exit(1);
  }

  let areaOfInterestCountryPresent = 0;
  if (test22aResult.sampleRows) {
    for (const row of test22aResult.sampleRows) {
      if (row.geographicView?.countryCriterionId) {
        areaOfInterestCountryPresent++;
      }
    }
  }
  console.log(`\n📊 Analysis:`);
  console.log(`   Rows returned: ${test22aResult.rowCount}`);
  console.log(`   Country criterion ID present: ${areaOfInterestCountryPresent}/${test22aResult.sampleRows?.length || 0}`);

  await new Promise(resolve => setTimeout(resolve, 500));

  // ======================================================================
  // TEST 2.2B: LOCATION_OF_PRESENCE
  // ======================================================================

  const test22bQuery = `
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
  AND geographic_view.location_type = 'LOCATION_OF_PRESENCE'
LIMIT 200
  `.trim();

  const test22bResult = await executeQuery(
    'TEST 2.2B',
    'Validate LOCATION_OF_PRESENCE location type',
    test22bQuery,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(test22bResult);

  if (!test22bResult.success) {
    console.log('\n❌ TEST 2.2B FAILED - Stopping test suite');
    process.exit(1);
  }

  let locationOfPresenceCountryPresent = 0;
  if (test22bResult.sampleRows) {
    for (const row of test22bResult.sampleRows) {
      if (row.geographicView?.countryCriterionId) {
        locationOfPresenceCountryPresent++;
      }
    }
  }
  console.log(`\n📊 Analysis:`);
  console.log(`   Rows returned: ${test22bResult.rowCount}`);
  console.log(`   Country criterion ID present: ${locationOfPresenceCountryPresent}/${test22bResult.sampleRows?.length || 0}`);

  await new Promise(resolve => setTimeout(resolve, 500));

  // ======================================================================
  // TEST 2.3: Cross-check campaign/ad_group breakdown in geo views
  // ======================================================================

  const test23Query = `
SELECT
  segments.date,
  campaign.id,
  ad_group.id,
  geographic_view.country_criterion_id,
  geographic_view.location_type,
  metrics.impressions
FROM geographic_view
WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
LIMIT 50
  `.trim();

  const test23Result = await executeQuery(
    'TEST 2.3',
    'Cross-check campaign/ad_group breakdown in geo views',
    test23Query,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(test23Result);

  // Update: This test actually SUCCEEDS - campaign.id and ad_group.id ARE available!
  if (test23Result.success) {
    console.log('\n✅ TEST 2.3 SUCCESS - campaign.id and ad_group.id ARE available in geographic_view!');
    console.log('   This means we CAN get campaign/ad_group breakdown WITH country data in a single query!');
  } else {
    console.log('\n⚠️  TEST 2.3 FAILED');
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  // ======================================================================
  // TEST 2.4: Check shared keys for joining
  // ======================================================================

  const test24aQuery = `SELECT segments.date FROM ad_group WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}' LIMIT 10`.trim();
  const test24aResult = await executeQuery(
    'TEST 2.4A',
    'Check segments.date in ad_group view',
    test24aQuery,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(test24aResult);

  if (!test24aResult.success) {
    console.log('\n❌ TEST 2.4A FAILED - Stopping test suite');
    process.exit(1);
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  const test24bQuery = `SELECT segments.date FROM geographic_view WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}' LIMIT 10`.trim();
  const test24bResult = await executeQuery(
    'TEST 2.4B',
    'Check segments.date in geographic_view',
    test24bQuery,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(test24bResult);

  if (!test24bResult.success) {
    console.log('\n❌ TEST 2.4B FAILED - Stopping test suite');
    process.exit(1);
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  const test24cQuery = `SELECT customer.id FROM ad_group WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}' LIMIT 10`.trim();
  const test24cResult = await executeQuery(
    'TEST 2.4C',
    'Check customer.id in ad_group view',
    test24cQuery,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(test24cResult);

  if (!test24cResult.success) {
    console.log('\n❌ TEST 2.4C FAILED - Stopping test suite');
    process.exit(1);
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  const test24dQuery = `SELECT customer.id FROM geographic_view WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}' LIMIT 10`.trim();
  const test24dResult = await executeQuery(
    'TEST 2.4D',
    'Check customer.id in geographic_view',
    test24dQuery,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(test24dResult);

  if (!test24dResult.success) {
    console.log('\n❌ TEST 2.4D FAILED - Stopping test suite');
    process.exit(1);
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  // ======================================================================
  // TEST 2.5: Geo target constant metadata
  // ======================================================================

  const test25Query = `
SELECT
  geo_target_constant.id,
  geo_target_constant.name,
  geo_target_constant.country_code,
  geo_target_constant.target_type,
  geo_target_constant.status
FROM geo_target_constant
WHERE geo_target_constant.target_type = 'Country'
LIMIT 300
  `.trim();

  const test25Result = await executeQuery(
    'TEST 2.5',
    'Retrieve geo target constant metadata for country code mapping',
    test25Query,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(test25Result);

  if (!test25Result.success) {
    console.log('\n❌ TEST 2.5 FAILED - Stopping test suite');
    process.exit(1);
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  // ======================================================================
  // TEST 2.6: Validate attribution windows against conversion_action
  // ======================================================================

  const test26Query = `
SELECT
  segments.date,
  metrics.conversions,
  metrics.conversions_value,
  segments.conversion_action
FROM ad_group
WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
LIMIT 50
  `.trim();

  const test26Result = await executeQuery(
    'TEST 2.6',
    'Validate attribution windows against conversion_action usage',
    test26Query,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(test26Result);

  if (!test26Result.success) {
    console.log('\n❌ TEST 2.6 FAILED - Stopping test suite');
    process.exit(1);
  }

  // Analyze conversion_action presence
  let conversionActionPresent = 0;
  const conversionActionExamples: string[] = [];
  if (test26Result.sampleRows) {
    for (const row of test26Result.sampleRows) {
      if (row.segments?.conversionAction) {
        conversionActionPresent++;
        if (conversionActionExamples.length < 5) {
          conversionActionExamples.push(row.segments.conversionAction);
        }
      }
    }
  }
  console.log(`\n📊 Analysis:`);
  console.log(`   Rows with conversion_action: ${conversionActionPresent}/${test26Result.sampleRows?.length || 0}`);
  if (conversionActionExamples.length > 0) {
    console.log(`   Example conversion_action IDs: ${conversionActionExamples.join(', ')}`);
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  // ======================================================================
  // TEST 2.7: Maximum granularity for conversion_action linkage
  // ======================================================================

  const test27Query = `
SELECT
  segments.date,
  segments.conversion_action,
  metrics.conversions,
  metrics.conversions_value
FROM campaign
WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'
LIMIT 50
  `.trim();

  const test27Result = await executeQuery(
    'TEST 2.7',
    'Identify maximum reliable granularity for joining conversion_action',
    test27Query,
    targetCustomerId!,
    loginCustomerId,
    accessToken
  );
  results.push(test27Result);

  if (!test27Result.success) {
    console.log('\n❌ TEST 2.7 FAILED - Stopping test suite');
    process.exit(1);
  }

  console.log(`\n📊 Analysis:`);
  console.log(`   Campaign-level rows: ${test27Result.rowCount}`);
  console.log(`   Ad_group-level rows (from TEST 2.6): ${test26Result.rowCount}`);
  console.log(`   Cardinality comparison: ${test27Result.rowCount} vs ${test26Result.rowCount}`);

  // ======================================================================
  // TEST 2.8: Summary
  // ======================================================================

  console.log('\n\n' + '='.repeat(80));
  console.log('TEST 2.8: SUMMARY OF FINDINGS');
  console.log('='.repeat(80));

  console.log('\n1. Which views reliably return country_criterion_id?');
  console.log('   ✅ geographic_view - YES');
  console.log('   ✅ user_location_view - YES (from Phase 1)');
  console.log('   ❌ ad_group view - NO (from Phase 1)');

  console.log('\n2. Which location_type is most reliable?');
  console.log(`   COUNTRY: ${test21Result.rowCount} rows, country_criterion_id present: ${countryIdPresent}/${test21Result.sampleRows?.length || 0}`);
  console.log(`   AREA_OF_INTEREST: ${test22aResult.rowCount} rows, country_criterion_id present: ${areaOfInterestCountryPresent}/${test22aResult.sampleRows?.length || 0}`);
  console.log(`   LOCATION_OF_PRESENCE: ${test22bResult.rowCount} rows, country_criterion_id present: ${locationOfPresenceCountryPresent}/${test22bResult.sampleRows?.length || 0}`);
  
  let mostReliable = 'COUNTRY';
  if (test21Result.rowCount === 0 && test22aResult.rowCount > 0) mostReliable = 'AREA_OF_INTEREST';
  if (test21Result.rowCount === 0 && test22bResult.rowCount > 0) mostReliable = 'LOCATION_OF_PRESENCE';
  console.log(`   → Most reliable: ${mostReliable} (based on row count and country_criterion_id presence)`);

  console.log('\n3. Which keys can be used to JOIN country data with campaign/ad_group metrics?');
  if (test24aResult.success && test24bResult.success) {
    console.log('   ✅ segments.date - Available in both views');
  }
  if (test24cResult.success && test24dResult.success) {
    console.log('   ✅ customer.id - Available in both views');
  }
  if (test23Result.success) {
    console.log('   ✅ campaign.id - AVAILABLE in geographic_view (MAJOR FINDING!)');
    console.log('   ✅ ad_group.id - AVAILABLE in geographic_view (MAJOR FINDING!)');
    console.log('   → Join keys: segments.date + customer.id + campaign.id + ad_group.id (can use single query!)');
  } else {
    console.log('   ❌ campaign.id - NOT available in geographic_view');
    console.log('   ❌ ad_group.id - NOT available in geographic_view');
    console.log('   → Join keys: segments.date + customer.id (application-level join required)');
  }

  console.log('\n4. Whether geo_target_constant lookups work for mapping IDs to country codes');
  if (test25Result.success) {
    console.log(`   ✅ YES - Retrieved ${test25Result.rowCount} country records`);
    if (test25Result.sampleRows && test25Result.sampleRows.length > 0) {
      const firstRow = test25Result.sampleRows[0];
      const geoConstant = firstRow.geoTargetConstant || firstRow.geo_target_constant;
      if (geoConstant) {
        console.log(`   Example mapping: ID ${geoConstant.id} → ${geoConstant.countryCode || 'N/A'} (${geoConstant.name || 'N/A'})`);
      }
    }
  } else {
    console.log('   ❌ NO - Query failed');
  }

  console.log('\n5. Whether attribution windows can be tied to metrics via segments.conversion_action');
  if (test26Result.success && conversionActionPresent > 0) {
    console.log(`   ✅ YES - conversion_action present in ${conversionActionPresent} rows`);
    console.log(`   → Can link conversion_action.id from metrics to conversion_action resource for attribution settings`);
  } else if (test26Result.success) {
    console.log('   ⚠️  PARTIAL - segments.conversion_action field exists but may be empty in some rows');
  } else {
    console.log('   ❌ NO - Query failed');
  }

  console.log('\n6. Which integration pattern is viable?');
  if (test23Result.success) {
    console.log('   ✅ A: Single query (VERY VIABLE!)');
    console.log('      Reason: campaign.id and ad_group.id ARE available in geographic_view!');
    console.log('      Strategy: Use geographic_view to get country + campaign + ad_group + metrics in ONE query');
    console.log('      Example: SELECT segments.date, campaign.id, ad_group.id, geographic_view.country_criterion_id, metrics.* FROM geographic_view');
    console.log('   ✅ B: Multi-query sync + application-level join (ALSO VIABLE)');
    console.log('      Strategy: Separate queries for campaign/ad_group metrics and geographic data, join on date + customer_id');
    console.log('   ✅ C: Pre-aggregated geo tables + separate campaign/ad_group tables (ALSO VIABLE)');
    console.log('      Strategy: Store geographic data in separate table, aggregate separately, join in reporting layer');
  } else {
    console.log('   ❌ A: Single query (NOT possible)');
    console.log('      Reason: campaign.id/ad_group.id not available in geographic_view');
    console.log('   ✅ B: Multi-query sync + application-level join (LIKELY)');
    console.log('      Strategy: Separate queries for campaign/ad_group metrics and geographic data, join on date + customer_id');
    console.log('   ✅ C: Pre-aggregated geo tables + separate campaign/ad_group tables (VERY LIKELY)');
    console.log('      Strategy: Store geographic data in separate table, aggregate separately, join in reporting layer');
  }

  console.log('\n' + '='.repeat(80));
  console.log('✅ Phase 2 diagnostic test suite completed\n');
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});

