/**
 * Comparison Script: Overview vs Markets Totals
 * 
 * This script compares the global totals from getOverviewData() and getMarketsData()
 * to verify that both functions produce consistent results for:
 * - Net Sales
 * - New Customer Net Sales
 * - Marketing Spend
 * - aMER
 * 
 * Usage:
 *   pnpm tsx scripts/compare_overview_vs_markets.ts
 *   TENANT_ID=... pnpm tsx scripts/compare_overview_vs_markets.ts
 *   pnpm tsx scripts/compare_overview_vs_markets.ts 2024-11-01 2024-11-30
 * 
 * Both functions now use the semantic layer (v_daily_metrics, v_marketing_spend_daily)
 * for global marketing spend and aMER, so totals should match exactly.
 */

// Load environment variables BEFORE any imports that might need them
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

// Now import after environment is loaded
async function main() {
  const { getOverviewData } = await import('@/lib/data/agg');
  const { getMarketsData } = await import('@/lib/data/agg');

  // Configuration: tenant ID and date range
  const tenantId = process.env.TENANT_ID ?? '642af254-0c2c-4274-86ca-507398ecf9a0'; // Default: Skinome
  const from = process.argv[2] ?? '2024-11-01';
  const to = process.argv[3] ?? '2024-11-30';

  console.log(`\n=== Overview vs Markets Comparison ===\n`);
  console.log(`Tenant ID: ${tenantId}`);
  console.log(`Period: ${from} → ${to}\n`);

  try {
    // Fetch data from both functions
    const [overview, markets] = await Promise.all([
      getOverviewData({ tenantId, from, to }),
      getMarketsData({ tenantId, from, to }),
    ]);

    // Extract totals
    const overviewTotals = overview.totals;
    const marketsTotals = markets.totals;

    // Helper to calculate delta and format
    const compareMetric = (
      label: string,
      overviewValue: number | null,
      marketsValue: number | null,
      formatFn: (val: number | null) => string,
      epsilon: number = 0.01,
    ) => {
      const ov = overviewValue ?? 0;
      const mv = marketsValue ?? 0;
      const delta = Math.abs(ov - mv);
      const matches = delta < epsilon;

      console.log(`${label}:`);
      console.log(`  overview:  ${formatFn(overviewValue)}`);
      console.log(`  markets:   ${formatFn(marketsValue)}`);
      console.log(`  delta:     ${formatFn(delta)}`);
      console.log(`  ${matches ? '✅ MATCH' : '❌ MISMATCH'}`);
      console.log('');

      return matches;
    };

    // Compare metrics
    const formatCurrency = (val: number | null) => {
      if (val === null || !Number.isFinite(val)) return 'null';
      return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const formatRatio = (val: number | null) => {
      if (val === null || !Number.isFinite(val)) return 'null';
      return val.toFixed(2);
    };

    let allMatch = true;

    allMatch = compareMetric(
      'Net Sales',
      overviewTotals.net_sales,
      marketsTotals.net_sales,
      formatCurrency,
      0.01,
    ) && allMatch;

    allMatch = compareMetric(
      'New Customer Net Sales',
      overviewTotals.new_customer_net_sales,
      marketsTotals.new_customer_net_sales,
      formatCurrency,
      0.01,
    ) && allMatch;

    allMatch = compareMetric(
      'Marketing Spend',
      overviewTotals.marketing_spend,
      marketsTotals.marketing_spend,
      formatCurrency,
      0.01,
    ) && allMatch;

    allMatch = compareMetric(
      'aMER',
      overviewTotals.amer,
      marketsTotals.amer,
      formatRatio,
      0.01,
    ) && allMatch;

    // Summary
    console.log('---');
    if (allMatch) {
      console.log('✅ All metrics match! Overview and Markets use consistent semantic layer.\n');
    } else {
      console.log('❌ Some metrics differ. Review implementation.\n');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error comparing data:', error);
    if (error instanceof Error) {
      console.error('Message:', error.message);
      console.error('Stack:', error.stack);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

