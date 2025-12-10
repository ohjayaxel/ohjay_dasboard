#!/usr/bin/env -S tsx

/**
 * Debug script to test getOverviewData and see what data it returns
 */

import { readFileSync } from 'fs';

// Load environment variables
function loadEnvFile() {
  const possibleEnvFiles = [
    process.env.ENV_FILE,
    '.env.local',
    '.env.production.local',
    '.env.development.local',
    '.env',
    'env/local.prod.sh',
  ].filter(Boolean) as string[];

  for (const envFile of possibleEnvFiles) {
    try {
      const content = readFileSync(envFile, 'utf-8');
      const envVars: Record<string, string> = {};
      content.split('\n').forEach((line) => {
        const exportMatch = line.match(/^export\s+(\w+)=(.+)$/);
        const directMatch = line.match(/^(\w+)=(.+)$/);
        const match = exportMatch || directMatch;
        if (match && !line.trim().startsWith('#')) {
          const [, key, value] = match;
          envVars[key] = value.replace(/^["']|["']$/g, '').trim();
        }
      });
      Object.assign(process.env, envVars);
      console.log(`[debug] Loaded environment variables from ${envFile}`);
      return;
    } catch (error) {
      // Continue to next file
    }
  }
}

loadEnvFile();

import { getOverviewData } from '@/lib/data/agg';
import { resolveTenantId } from '@/lib/tenants/resolve-tenant';

async function main() {
  const tenantId = await resolveTenantId('skinome');
  
  const today = new Date();
  const startWindow = new Date(today);
  startWindow.setDate(startWindow.getDate() - 29);
  
  const from = startWindow.toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);
  
  console.log(`\n=== DEBUG: getOverviewData ===`);
  console.log(`Tenant ID: ${tenantId}`);
  console.log(`Date range: ${from} to ${to}\n`);
  
  try {
    const { series, totals, currency } = await getOverviewData({ tenantId, from, to });
    
    console.log(`Currency: ${currency}`);
    console.log(`\nTotals:`);
    console.log(`  Gross Sales: ${totals.gross_sales}`);
    console.log(`  Net Sales: ${totals.net_sales}`);
    console.log(`  New Customer Net Sales: ${totals.new_customer_net_sales}`);
    console.log(`  Marketing Spend: ${totals.marketing_spend}`);
    console.log(`  Orders: ${totals.orders}`);
    
    console.log(`\nSeries (first 10 and last 10):`);
    console.log(`Total dates: ${series.length}\n`);
    
    if (series.length > 0) {
      console.log('First 10:');
      series.slice(0, 10).forEach((point) => {
        console.log(`  ${point.date}: Gross=${point.gross_sales}, Net=${point.net_sales}, Orders=${point.orders}`);
      });
      
      if (series.length > 10) {
        console.log('\nLast 10:');
        series.slice(-10).forEach((point) => {
          console.log(`  ${point.date}: Gross=${point.gross_sales}, Net=${point.net_sales}, Orders=${point.orders}`);
        });
      }
      
      // Show dates with data
      const datesWithData = series.filter(p => p.gross_sales > 0 || p.net_sales > 0 || p.orders > 0);
      console.log(`\nDates with data: ${datesWithData.length}`);
      datesWithData.forEach((point) => {
        console.log(`  ${point.date}: Gross=${point.gross_sales}, Net=${point.net_sales}, Orders=${point.orders}`);
      });
    } else {
      console.log('No series data returned!');
    }
  } catch (error) {
    console.error('Error:', error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
  }
}

main();



