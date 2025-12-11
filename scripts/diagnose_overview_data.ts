/**
 * Diagnostic script to verify data flow from APIs → Database → Semantic Layer → Frontend
 * 
 * This script checks:
 * 1. Are sync jobs running successfully? (jobs_log)
 * 2. Is data being written to raw tables? (kpi_daily, shopify_daily_sales)
 * 3. Do semantic layer views have data? (v_daily_metrics, v_marketing_spend_daily)
 * 4. Does getOverviewData return data? (backend data access)
 * 
 * Usage:
 *   pnpm tsx scripts/diagnose_overview_data.ts <tenantSlug>
 * 
 * Example:
 *   pnpm tsx scripts/diagnose_overview_data.ts skinome
 */

function loadEnvFile() {
  const fs = require('fs');
  const path = require('path');
  const envFiles = ['.env.local', 'env/local.prod.sh'];
  for (const envFile of envFiles) {
    const filePath = path.join(process.cwd(), envFile);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const match = trimmed.match(/^export\s+([^=]+)=(.*)$/) || trimmed.match(/^([^=]+)=(.*)$/);
          if (match) {
            const key = match[1].trim();
            const value = match[2].trim().replace(/^["']|["']$/g, '');
            if (!process.env[key]) {
              process.env[key] = value;
            }
          }
        }
      }
      break; // Load first found file
    }
  }
}

loadEnvFile();

import { createClient } from '@supabase/supabase-js';
import { resolveTenantId } from '../lib/tenants/resolve-tenant';
import { getOverviewData } from '../lib/data/agg';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
  console.error('Make sure .env.local or env/local.prod.sh file exists with these variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const tenantSlug = process.argv[2];
  if (!tenantSlug) {
    console.error('Usage: pnpm tsx scripts/diagnose_overview_data.ts <tenantSlug>');
    process.exit(1);
  }

  const tenantId = await resolveTenantId(tenantSlug);
  console.log(`\n🔍 Diagnosing data flow for tenant: ${tenantSlug} (${tenantId})\n`);

  // Calculate date range (last 7 days)
  const today = new Date();
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const fromDate = sevenDaysAgo.toISOString().slice(0, 10);
  const toDate = today.toISOString().slice(0, 10);

  console.log(`📅 Date range: ${fromDate} to ${toDate}\n`);

  // ============================================================================
  // 1. Check sync jobs status
  // ============================================================================
  console.log('1️⃣  CHECKING SYNC JOBS STATUS');
  console.log('─'.repeat(80));
  
  const { data: recentJobs, error: jobsError } = await supabase
    .from('jobs_log')
    .select('source, status, started_at, finished_at, error, tenant_id')
    .eq('tenant_id', tenantId)
    .gte('started_at', sevenDaysAgo.toISOString())
    .order('started_at', { ascending: false })
    .limit(20);

  if (jobsError) {
    console.error('❌ Error fetching jobs:', jobsError);
  } else if (!recentJobs || recentJobs.length === 0) {
    console.warn('⚠️  No sync jobs found in the last 7 days');
  } else {
    const bySource = new Map<string, { total: number; succeeded: number; failed: number; lastRun: string | null }>();
    
    for (const job of recentJobs) {
      const source = job.source as string;
      if (!bySource.has(source)) {
        bySource.set(source, { total: 0, succeeded: 0, failed: 0, lastRun: null });
      }
      const stats = bySource.get(source)!;
      stats.total++;
      if (job.status === 'succeeded') {
        stats.succeeded++;
      } else if (job.status === 'failed') {
        stats.failed++;
      }
      if (!stats.lastRun) {
        stats.lastRun = job.started_at as string;
      }
    }

    for (const [source, stats] of bySource.entries()) {
      const successRate = stats.total > 0 ? (stats.succeeded / stats.total * 100).toFixed(1) : '0';
      console.log(`   ${source}:`);
      console.log(`      Total: ${stats.total}, Succeeded: ${stats.succeeded}, Failed: ${stats.failed} (${successRate}% success)`);
      console.log(`      Last run: ${stats.lastRun}`);
    }
  }

  console.log('');

  // ============================================================================
  // 2. Check raw data tables (kpi_daily for marketing spend)
  // ============================================================================
  console.log('2️⃣  CHECKING RAW DATA TABLES (kpi_daily)');
  console.log('─'.repeat(80));

  const { data: kpiRows, error: kpiError } = await supabase
    .from('kpi_daily')
    .select('date, source, spend, currency')
    .eq('tenant_id', tenantId)
    .gte('date', fromDate)
    .lte('date', toDate)
    .order('date', { ascending: false })
    .order('source', { ascending: true });

  if (kpiError) {
    console.error('❌ Error fetching kpi_daily:', kpiError);
  } else if (!kpiRows || kpiRows.length === 0) {
    console.warn('⚠️  No kpi_daily rows found in the last 7 days');
  } else {
    const byDate = new Map<string, { meta: number; google_ads: number; dates: Set<string> }>();
    
    for (const row of kpiRows) {
      const date = row.date as string;
      const source = row.source as string;
      const spend = (row.spend as number) ?? 0;

      if (!byDate.has(date)) {
        byDate.set(date, { meta: 0, google_ads: 0, dates: new Set() });
      }
      const day = byDate.get(date)!;
      day.dates.add(date);

      if (source === 'meta') {
        day.meta += spend;
      } else if (source === 'google_ads') {
        day.google_ads += spend;
      }
    }

    console.log(`   Found ${kpiRows.length} rows across ${byDate.size} dates:`);
    for (const [date, day] of Array.from(byDate.entries()).slice(0, 7)) {
      const total = day.meta + day.google_ads;
      console.log(`   ${date}: Meta=${day.meta.toFixed(2)}, Google Ads=${day.google_ads.toFixed(2)}, Total=${total.toFixed(2)}`);
    }
  }

  console.log('');

  // ============================================================================
  // 3. Check Shopify daily sales
  // ============================================================================
  console.log('3️⃣  CHECKING SHOPIFY DAILY SALES');
  console.log('─'.repeat(80));

  const { data: shopifyRows, error: shopifyError } = await supabase
    .from('shopify_daily_sales')
    .select('date, gross_sales, net_sales, new_customer_net_sales, orders')
    .eq('tenant_id', tenantId)
    .gte('date', fromDate)
    .lte('date', toDate)
    .order('date', { ascending: false })
    .limit(10);

  if (shopifyError) {
    console.error('❌ Error fetching shopify_daily_sales:', shopifyError);
  } else if (!shopifyRows || shopifyRows.length === 0) {
    console.warn('⚠️  No shopify_daily_sales rows found in the last 7 days');
  } else {
    console.log(`   Found ${shopifyRows.length} rows:`);
    for (const row of shopifyRows.slice(0, 7)) {
      console.log(
        `   ${row.date}: Gross=${row.gross_sales ?? 0}, Net=${row.net_sales ?? 0}, ` +
        `New Customer=${row.new_customer_net_sales ?? 0}, Orders=${row.orders ?? 0}`,
      );
    }
  }

  console.log('');

  // ============================================================================
  // 4. Check semantic layer view (v_daily_metrics)
  // ============================================================================
  console.log('4️⃣  CHECKING SEMANTIC LAYER VIEW (v_daily_metrics)');
  console.log('─'.repeat(80));

  const { data: dailyMetrics, error: metricsError } = await supabase
    .from('v_daily_metrics')
    .select('date, net_sales, new_customer_net_sales, total_marketing_spend, amer, orders, currency')
    .eq('tenant_id', tenantId)
    .gte('date', fromDate)
    .lte('date', toDate)
    .order('date', { ascending: false })
    .limit(10);

  if (metricsError) {
    console.error('❌ Error fetching v_daily_metrics:', metricsError);
    console.error('   This could indicate the view is missing or has errors');
  } else if (!dailyMetrics || dailyMetrics.length === 0) {
    console.warn('⚠️  No v_daily_metrics rows found in the last 7 days');
    console.warn('   This means the semantic layer view has no data, even if raw tables have data');
  } else {
    console.log(`   Found ${dailyMetrics.length} rows:`);
    for (const row of dailyMetrics.slice(0, 7)) {
      console.log(
        `   ${row.date}: Net Sales=${row.net_sales ?? 0}, ` +
        `New Customer=${row.new_customer_net_sales ?? 0}, ` +
        `Marketing=${row.total_marketing_spend ?? 0}, ` +
        `aMER=${row.amer?.toFixed(2) ?? 'null'}, ` +
        `Orders=${row.orders ?? 0}, ` +
        `Currency=${row.currency ?? 'null'}`,
      );
    }
  }

  console.log('');

  // ============================================================================
  // 5. Test backend data access (getOverviewData)
  // ============================================================================
  console.log('5️⃣  TESTING BACKEND DATA ACCESS (getOverviewData)');
  console.log('─'.repeat(80));

  try {
    const result = await getOverviewData({
      tenantId,
      from: fromDate,
      to: toDate,
    });

    console.log(`   ✅ getOverviewData succeeded`);
    console.log(`   Series points: ${result.series.length}`);
    console.log(`   Totals:`);
    console.log(`      Net Sales: ${result.totals.net_sales}`);
    console.log(`      New Customer Net Sales: ${result.totals.new_customer_net_sales}`);
    console.log(`      Marketing Spend: ${result.totals.marketing_spend}`);
    console.log(`      aMER: ${result.totals.amer?.toFixed(2) ?? 'null'}`);
    console.log(`      Orders: ${result.totals.orders}`);
    console.log(`      Currency: ${result.currency ?? 'null'}`);

    if (result.series.length > 0) {
      console.log(`\n   Last 5 days in series:`);
      for (const point of result.series.slice(-5)) {
        console.log(
          `   ${point.date}: Net=${point.net_sales}, Marketing=${point.marketing_spend}, aMER=${point.amer?.toFixed(2) ?? 'null'}`,
        );
      }
    } else {
      console.warn('   ⚠️  Series is empty - no data points returned');
    }
  } catch (error) {
    console.error('❌ Error calling getOverviewData:', error);
    console.error('   This indicates a problem in the backend data access layer');
  }

  console.log('\n' + '═'.repeat(80));
  console.log('✅ DIAGNOSIS COMPLETE');
  console.log('═'.repeat(80) + '\n');

  // Summary
  console.log('📊 SUMMARY:');
  console.log('─'.repeat(80));
  
  const hasRecentJobs = recentJobs && recentJobs.length > 0;
  const hasKpiData = kpiRows && kpiRows.length > 0;
  const hasShopifyData = shopifyRows && shopifyRows.length > 0;
  const hasSemanticData = dailyMetrics && dailyMetrics.length > 0;

  console.log(`   Sync Jobs: ${hasRecentJobs ? '✅' : '❌'}`);
  console.log(`   kpi_daily data: ${hasKpiData ? '✅' : '❌'}`);
  console.log(`   shopify_daily_sales data: ${hasShopifyData ? '✅' : '❌'}`);
  console.log(`   v_daily_metrics data: ${hasSemanticData ? '✅' : '❌'}`);

  if (!hasRecentJobs) {
    console.log('\n   ⚠️  ISSUE: No sync jobs running - check cron jobs and connections');
  }
  if (!hasKpiData && !hasShopifyData) {
    console.log('\n   ⚠️  ISSUE: No raw data in database - sync jobs may not be writing data');
  }
  if (hasKpiData && hasShopifyData && !hasSemanticData) {
    console.log('\n   ⚠️  ISSUE: Raw data exists but semantic layer view is empty - check view definition');
  }
  if (hasSemanticData && result.series.length === 0) {
    console.log('\n   ⚠️  ISSUE: Semantic layer has data but getOverviewData returns empty - check date range filtering');
  }

  console.log('');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

