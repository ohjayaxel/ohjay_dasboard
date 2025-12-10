/**
 * Diagnostic Script: Check Skinome Data Flow
 * 
 * This script verifies:
 * 1. Data exists in kpi_daily for Meta and Google Ads
 * 2. Semantic views (v_marketing_spend_daily, v_daily_metrics) contain correct data
 * 3. Backend functions (getOverviewData, getMarketsData) return correct data
 */

// Load environment variables BEFORE any imports
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
    }
  }
}

loadEnvFile();

async function main() {
  const { getSupabaseServiceClient } = await import('@/lib/supabase/server');
  const { getOverviewData } = await import('@/lib/data/agg');
  const { getMarketsData } = await import('@/lib/data/agg');
  const { getDailyMetricsFromView } = await import('@/lib/data/daily-metrics');
  const { getMarketingSpendFromView } = await import('@/lib/data/daily-metrics');

  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0';
  const tenantSlug = 'skinome';
  
  // Use a recent date range
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const from = thirtyDaysAgo.toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);

  console.log(`\n=== Skinome Data Diagnosis ===\n`);
  console.log(`Tenant ID: ${tenantId}`);
  console.log(`Date Range: ${from} → ${to}\n`);

  const supabase = getSupabaseServiceClient();

  // 1. Check kpi_daily for Meta and Google Ads
  console.log('--- STEP 1: Check kpi_daily ---');
  
  const { data: metaKpi, error: metaError } = await supabase
    .from('kpi_daily')
    .select('date, spend, source')
    .eq('tenant_id', tenantId)
    .eq('source', 'meta')
    .gte('date', from)
    .lte('date', to)
    .order('date', { ascending: false })
    .limit(10);

  if (metaError) {
    console.error('❌ Error fetching Meta kpi_daily:', metaError.message);
  } else {
    console.log(`✅ Meta kpi_daily rows: ${metaKpi?.length ?? 0}`);
    if (metaKpi && metaKpi.length > 0) {
      const totalMetaSpend = metaKpi.reduce((sum, row) => sum + (row.spend ?? 0), 0);
      console.log(`   Total Meta spend in sample: ${totalMetaSpend.toFixed(2)}`);
      console.log(`   Sample dates: ${metaKpi.slice(0, 3).map(r => r.date).join(', ')}`);
    }
  }

  const { data: googleKpi, error: googleError } = await supabase
    .from('kpi_daily')
    .select('date, spend, source')
    .eq('tenant_id', tenantId)
    .eq('source', 'google_ads')
    .gte('date', from)
    .lte('date', to)
    .order('date', { ascending: false })
    .limit(10);

  if (googleError) {
    console.error('❌ Error fetching Google Ads kpi_daily:', googleError.message);
  } else {
    console.log(`✅ Google Ads kpi_daily rows: ${googleKpi?.length ?? 0}`);
    if (googleKpi && googleKpi.length > 0) {
      const totalGoogleSpend = googleKpi.reduce((sum, row) => sum + (row.spend ?? 0), 0);
      console.log(`   Total Google Ads spend in sample: ${totalGoogleSpend.toFixed(2)}`);
      console.log(`   Sample dates: ${googleKpi.slice(0, 3).map(r => r.date).join(', ')}`);
    } else {
      console.log('   ⚠️  No Google Ads spend found in kpi_daily!');
    }
  }

  // 2. Check v_marketing_spend_daily
  console.log('\n--- STEP 2: Check v_marketing_spend_daily ---');
  
  const { data: marketingSpend, error: marketingSpendError } = await supabase
    .from('v_marketing_spend_daily')
    .select('date, meta_spend, google_ads_spend, total_marketing_spend')
    .eq('tenant_id', tenantId)
    .gte('date', from)
    .lte('date', to)
    .order('date', { ascending: false })
    .limit(10);

  if (marketingSpendError) {
    console.error('❌ Error fetching v_marketing_spend_daily:', marketingSpendError.message);
  } else {
    console.log(`✅ v_marketing_spend_daily rows: ${marketingSpend?.length ?? 0}`);
    if (marketingSpend && marketingSpend.length > 0) {
      const sample = marketingSpend[0];
      console.log(`   Sample row:`);
      console.log(`     date: ${sample.date}`);
      console.log(`     meta_spend: ${sample.meta_spend ?? 0}`);
      console.log(`     google_ads_spend: ${sample.google_ads_spend ?? 0}`);
      console.log(`     total_marketing_spend: ${sample.total_marketing_spend ?? 0}`);
      const expectedTotal = (sample.meta_spend ?? 0) + (sample.google_ads_spend ?? 0);
      if (Math.abs((sample.total_marketing_spend ?? 0) - expectedTotal) > 0.01) {
        console.log(`     ⚠️  WARNING: total_marketing_spend (${sample.total_marketing_spend}) != meta + google (${expectedTotal})`);
      } else {
        console.log(`     ✅ total_marketing_spend matches meta + google`);
      }
    }
  }

  // 3. Check v_daily_metrics
  console.log('\n--- STEP 3: Check v_daily_metrics ---');
  
  const { data: dailyMetrics, error: dailyMetricsError } = await supabase
    .from('v_daily_metrics')
    .select('date, net_sales, new_customer_net_sales, meta_spend, google_ads_spend, total_marketing_spend, amer')
    .eq('tenant_id', tenantId)
    .gte('date', from)
    .lte('date', to)
    .order('date', { ascending: false })
    .limit(10);

  if (dailyMetricsError) {
    console.error('❌ Error fetching v_daily_metrics:', dailyMetricsError.message);
  } else {
    console.log(`✅ v_daily_metrics rows: ${dailyMetrics?.length ?? 0}`);
    if (dailyMetrics && dailyMetrics.length > 0) {
      const sample = dailyMetrics[0];
      console.log(`   Sample row:`);
      console.log(`     date: ${sample.date}`);
      console.log(`     net_sales: ${sample.net_sales ?? 0}`);
      console.log(`     new_customer_net_sales: ${sample.new_customer_net_sales ?? 0}`);
      console.log(`     meta_spend: ${sample.meta_spend ?? 0}`);
      console.log(`     google_ads_spend: ${sample.google_ads_spend ?? 0}`);
      console.log(`     total_marketing_spend: ${sample.total_marketing_spend ?? 0}`);
      console.log(`     amer: ${sample.amer ?? 'null'}`);
      
      // Verify aMER calculation
      if (sample.total_marketing_spend && sample.total_marketing_spend > 0 && sample.new_customer_net_sales) {
        const expectedAmer = sample.new_customer_net_sales / sample.total_marketing_spend;
        if (sample.amer && Math.abs(sample.amer - expectedAmer) > 0.01) {
          console.log(`     ⚠️  WARNING: amer (${sample.amer}) != expected (${expectedAmer.toFixed(4)})`);
        } else {
          console.log(`     ✅ amer calculation matches`);
        }
      }
    }
  }

  // 4. Check getMarketingSpendFromView helper
  console.log('\n--- STEP 4: Check getMarketingSpendFromView() ---');
  
  try {
    const spendAgg = await getMarketingSpendFromView({ tenantId, from, to });
    console.log(`✅ getMarketingSpendFromView():`);
    console.log(`     meta_spend: ${spendAgg.meta_spend.toFixed(2)}`);
    console.log(`     google_ads_spend: ${spendAgg.google_ads_spend.toFixed(2)}`);
    console.log(`     total_marketing_spend: ${spendAgg.total_marketing_spend.toFixed(2)}`);
    const expectedTotal = spendAgg.meta_spend + spendAgg.google_ads_spend;
    if (Math.abs(spendAgg.total_marketing_spend - expectedTotal) > 0.01) {
      console.log(`     ⚠️  WARNING: total != meta + google`);
    } else {
      console.log(`     ✅ total matches meta + google`);
    }
  } catch (error) {
    console.error('❌ Error calling getMarketingSpendFromView():', error);
  }

  // 5. Check getOverviewData()
  console.log('\n--- STEP 5: Check getOverviewData() ---');
  
  try {
    const overview = await getOverviewData({ tenantId, from, to });
    console.log(`✅ getOverviewData() returned:`);
    console.log(`     Series rows: ${overview.series.length}`);
    console.log(`     Totals:`);
    console.log(`       net_sales: ${overview.totals.net_sales.toFixed(2)}`);
    console.log(`       new_customer_net_sales: ${overview.totals.new_customer_net_sales.toFixed(2)}`);
    console.log(`       marketing_spend: ${overview.totals.marketing_spend.toFixed(2)}`);
    console.log(`       amer: ${overview.totals.amer ?? 'null'}`);
    console.log(`       currency: ${overview.currency ?? 'null'}`);
    
    // Check if marketing spend looks like it's missing Google Ads
    if (overview.series.length > 0) {
      const sampleDate = overview.series[0];
      console.log(`\n     Sample daily row (${sampleDate.date}):`);
      console.log(`       marketing_spend: ${sampleDate.marketing_spend.toFixed(2)}`);
      
      // Compare with semantic layer for same date
      const { data: semanticRow } = await supabase
        .from('v_daily_metrics')
        .select('meta_spend, google_ads_spend, total_marketing_spend')
        .eq('tenant_id', tenantId)
        .eq('date', sampleDate.date)
        .single();
      
      if (semanticRow) {
        console.log(`       v_daily_metrics for same date:`);
        console.log(`         meta_spend: ${semanticRow.meta_spend ?? 0}`);
        console.log(`         google_ads_spend: ${semanticRow.google_ads_spend ?? 0}`);
        console.log(`         total_marketing_spend: ${semanticRow.total_marketing_spend ?? 0}`);
        if (Math.abs(sampleDate.marketing_spend - (semanticRow.total_marketing_spend ?? 0)) > 0.01) {
          console.log(`       ⚠️  WARNING: getOverviewData marketing_spend (${sampleDate.marketing_spend}) != v_daily_metrics total (${semanticRow.total_marketing_spend ?? 0})`);
        } else {
          console.log(`       ✅ marketing_spend matches semantic layer`);
        }
      }
    }
  } catch (error) {
    console.error('❌ Error calling getOverviewData():', error);
    if (error instanceof Error) {
      console.error('   Message:', error.message);
      console.error('   Stack:', error.stack);
    }
  }

  // 6. Check getMarketsData()
  console.log('\n--- STEP 6: Check getMarketsData() ---');
  
  try {
    const markets = await getMarketsData({ tenantId, from, to });
    console.log(`✅ getMarketsData() returned:`);
    console.log(`     Markets (countries): ${markets.series.length}`);
    console.log(`     Totals:`);
    console.log(`       net_sales: ${markets.totals.net_sales.toFixed(2)}`);
    console.log(`       new_customer_net_sales: ${markets.totals.new_customer_net_sales.toFixed(2)}`);
    console.log(`       marketing_spend: ${markets.totals.marketing_spend.toFixed(2)}`);
    console.log(`       amer: ${markets.totals.amer ?? 'null'}`);
    
    if (markets.series.length === 0) {
      console.log(`\n     ⚠️  WARNING: No markets returned!`);
      console.log(`     This suggests either:`);
      console.log(`       - No orders with country data in the date range`);
      console.log(`       - All orders filtered out by country check`);
      console.log(`       - Transaction data not matching orders`);
    } else {
      console.log(`\n     Sample markets (top 3):`);
      markets.series.slice(0, 3).forEach(m => {
        console.log(`       ${m.country}: net_sales=${m.net_sales.toFixed(2)}, marketing_spend=${m.marketing_spend.toFixed(2)}, amer=${m.amer ?? 'null'}`);
      });
    }
  } catch (error) {
    console.error('❌ Error calling getMarketsData():', error);
    if (error instanceof Error) {
      console.error('   Message:', error.message);
      console.error('   Stack:', error.stack);
    }
  }

  console.log('\n=== Diagnosis Complete ===\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

