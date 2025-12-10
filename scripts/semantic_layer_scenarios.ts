/**
 * Semantic Layer Multi-Scenario Comparison Script
 * 
 * Runs comparison diagnostics between old aggregation logic (getOverviewData)
 * and new semantic layer views (v_daily_metrics) across multiple scenarios.
 * 
 * Usage:
 *   pnpm tsx scripts/semantic_layer_scenarios.ts
 *   TENANT_ID=... pnpm tsx scripts/semantic_layer_scenarios.ts
 *   pnpm tsx scripts/semantic_layer_scenarios.ts 2025-10-01 2025-10-15
 * 
 * If CLI args (from, to) are provided, runs a single ad-hoc scenario.
 * Otherwise, runs all predefined scenarios.
 */

// Load environment variables BEFORE any imports that might need them
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
      // Skip comments and empty lines
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        return;
      }
      
      const match = trimmedLine.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const [, key, value] = match;
        const trimmedKey = key.trim();
        const trimmedValue = value.trim().replace(/^["']|["']$/g, '');
        if (trimmedKey && trimmedValue && !process.env[trimmedKey]) {
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

// Note: We'll use dynamic import below to ensure env vars are loaded first

// Default tenant ID for Skinome
const TENANT_ID = process.env.TENANT_ID ?? '642af254-0c2c-4274-86ca-507398ecf9a0';

type Scenario = {
  label: string;
  from: string; // 'YYYY-MM-DD'
  to: string;   // 'YYYY-MM-DD'
};

/**
 * Predefined scenarios for comparison testing.
 * 
 * TODO: Adjust these date ranges to match actual "sharp" periods for each tenant:
 * - Normal week: Typical baseline performance
 * - High-spend/campaign: Period with elevated marketing activity
 * - Recent period: Latest available data for freshness validation
 */
const SCENARIOS: Scenario[] = [
  {
    label: 'Normal week (baseline)',
    from: '2025-11-01',
    to: '2025-11-07',
  },
  {
    label: 'High-spend / campaign period',
    from: '2025-11-25',
    to: '2025-12-02',
  },
  {
    label: 'Recent period',
    from: '2025-12-01',
    to: '2025-12-10',
  },
];

const DELTA_TOLERANCE = 0.01;

/**
 * Format a number for display, handling null values
 */
function formatValue(value: number | null): string {
  if (value === null) return 'null';
  return value.toFixed(2);
}

/**
 * Check if a row has significant deltas above tolerance
 */
function hasSignificantDeltas(row: {
  deltas: {
    net_sales: number | null;
    total_marketing_spend: number | null;
    amer: number | null;
  };
}): boolean {
  const { deltas } = row;
  return (
    (deltas.net_sales !== null && Math.abs(deltas.net_sales) > DELTA_TOLERANCE) ||
    (deltas.total_marketing_spend !== null &&
      Math.abs(deltas.total_marketing_spend) > DELTA_TOLERANCE) ||
    (deltas.amer !== null && Math.abs(deltas.amer) > DELTA_TOLERANCE)
  );
}

/**
 * Print a formatted scenario header
 */
function printScenarioHeader(scenario: Scenario): void {
  console.log('\n' + '='.repeat(50));
  console.log(`=== Scenario: ${scenario.label}`);
  console.log(`=== Range: ${scenario.from} → ${scenario.to}`);
  console.log('='.repeat(50) + '\n');
}

/**
 * Print comparison summary statistics
 */
function printSummary(summary: {
  totalDates: number;
  matchingDates: number;
  datesWithDeltas: number;
  maxDeltaNetSales: number | null;
  maxDeltaMarketingSpend: number | null;
  maxDeltaAmer: number | null;
}): void {
  console.log('Summary:');
  console.log(`  Total dates: ${summary.totalDates}`);
  console.log(`  Matching dates (within tolerance): ${summary.matchingDates}`);
  console.log(`  Dates with deltas: ${summary.datesWithDeltas}`);
  console.log(`  Max delta (net_sales): ${formatValue(summary.maxDeltaNetSales)}`);
  console.log(`  Max delta (marketing_spend): ${formatValue(summary.maxDeltaMarketingSpend)}`);
  console.log(`  Max delta (amer): ${formatValue(summary.maxDeltaAmer)}`);
  console.log();
}

/**
 * Print sample rows with significant deltas
 */
function printSampleRows(rows: Array<{
  date: string;
  old: {
    net_sales: number | null;
    total_marketing_spend: number | null;
    amer: number | null;
  };
  semantic: {
    net_sales: number | null;
    total_marketing_spend: number | null;
    amer: number | null;
  };
  deltas: {
    net_sales: number | null;
    total_marketing_spend: number | null;
    amer: number | null;
  };
}>): void {
  const rowsWithDeltas = rows.filter(hasSignificantDeltas);

  if (rowsWithDeltas.length === 0) {
    console.log(`No significant deltas (> ${DELTA_TOLERANCE}) for this scenario.\n`);
    return;
  }

  console.log(`Sample rows with deltas (> ${DELTA_TOLERANCE}):\n`);

  const sampleSize = Math.min(5, rowsWithDeltas.length);
  for (const row of rowsWithDeltas.slice(0, sampleSize)) {
    console.log(`  Date: ${row.date}`);
    console.log(
      `    Net Sales: old=${formatValue(row.old.net_sales)}, semantic=${formatValue(
        row.semantic.net_sales,
      )}, delta=${formatValue(row.deltas.net_sales)}`,
    );
    console.log(
      `    Marketing Spend: old=${formatValue(
        row.old.total_marketing_spend,
      )}, semantic=${formatValue(
        row.semantic.total_marketing_spend,
      )}, delta=${formatValue(row.deltas.total_marketing_spend)}`,
    );
    console.log(
      `    aMER: old=${formatValue(row.old.amer)}, semantic=${formatValue(
        row.semantic.amer,
      )}, delta=${formatValue(row.deltas.amer)}`,
    );
    console.log();
  }

  if (rowsWithDeltas.length > sampleSize) {
    console.log(
      `  ... and ${rowsWithDeltas.length - sampleSize} more row(s) with deltas.\n`,
    );
  }
}

/**
 * Run comparison for a single scenario
 */
async function runScenario(scenario: Scenario, tenantId: string): Promise<void> {
  printScenarioHeader(scenario);

  try {
    // Dynamic import to ensure env vars are loaded first
    const { compareDailyMetricsLayers } = await import('@/lib/data/daily-metrics-debug');
    
    const result = await compareDailyMetricsLayers({
      tenantId,
      from: scenario.from,
      to: scenario.to,
    });

    printSummary(result.summary);
    printSampleRows(result.rows);
  } catch (error) {
    console.error(`Error running scenario "${scenario.label}":`, error);
    if (error instanceof Error) {
      console.error(`  ${error.message}`);
    }
    console.log();
  }
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  // Check for CLI args (ad-hoc scenario)
  const [fromArg, toArg] = process.argv.slice(2);

  if (fromArg && toArg) {
    // Ad-hoc scenario mode
    const scenario: Scenario = {
      label: `Ad-hoc (${fromArg} → ${toArg})`,
      from: fromArg,
      to: toArg,
    };

    console.log(`\nRunning ad-hoc scenario for tenant: ${TENANT_ID}`);
    await runScenario(scenario, TENANT_ID);
  } else {
    // Predefined scenarios mode
    console.log(`\nRunning all scenarios for tenant: ${TENANT_ID}`);
    console.log(`Found ${SCENARIOS.length} predefined scenario(s).\n`);

    for (const scenario of SCENARIOS) {
      await runScenario(scenario, TENANT_ID);
    }
  }

  console.log('='.repeat(50));
  console.log('All scenarios completed.');
  console.log('='.repeat(50) + '\n');
}

// Execute
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
