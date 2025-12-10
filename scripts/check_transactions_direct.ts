#!/usr/bin/env -S tsx

/**
 * Direct check of transactions in database
 */

import { readFileSync } from 'fs';

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
      return;
    } catch (error) {
      // Continue
    }
  }
}

loadEnvFile();

import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { resolveTenantId } from '@/lib/tenants/resolve-tenant';

async function main() {
  const tenantId = await resolveTenantId('skinome');
  const client = getSupabaseServiceClient();
  
  const from = '2025-11-09';
  const to = '2025-12-08';
  
  console.log(`\n=== DIRECT DATABASE CHECK ===`);
  console.log(`Tenant ID: ${tenantId}`);
  console.log(`Date range: ${from} to ${to}\n`);
  
  // Check total transactions in range
  const { data: transactions, error } = await client
    .from('shopify_sales_transactions')
    .select('event_date, event_type')
    .eq('tenant_id', tenantId)
    .gte('event_date', from)
    .lte('event_date', to);
  
  if (error) {
    console.error('Error:', error);
    return;
  }
  
  console.log(`Total transactions found: ${transactions?.length || 0}\n`);
  
  // Group by date
  const byDate = new Map<string, { sales: number; returns: number }>();
  for (const txn of transactions || []) {
    const date = txn.event_date as string;
    const existing = byDate.get(date) || { sales: 0, returns: 0 };
    if (txn.event_type === 'SALE') {
      existing.sales++;
    } else if (txn.event_type === 'RETURN') {
      existing.returns++;
    }
    byDate.set(date, existing);
  }
  
  console.log(`Unique dates with transactions: ${byDate.size}\n`);
  console.log('Dates with transactions:');
  Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([date, counts]) => {
      console.log(`  ${date}: ${counts.sales} SALES, ${counts.returns} RETURNS`);
    });
  
  // Check specific dates
  console.log('\nChecking specific dates:');
  for (const date of ['2025-11-09', '2025-11-30', '2025-12-08']) {
    const { data: dateData } = await client
      .from('shopify_sales_transactions')
      .select('event_date, event_type, gross_sales')
      .eq('tenant_id', tenantId)
      .eq('event_date', date)
      .limit(5);
    
    console.log(`  ${date}: ${dateData?.length || 0} transactions (showing first 5)`);
    if (dateData && dateData.length > 0) {
      dateData.forEach((txn, idx) => {
        console.log(`    [${idx + 1}] ${txn.event_type}: ${txn.gross_sales}`);
      });
    }
  }
}

main().catch(console.error);



