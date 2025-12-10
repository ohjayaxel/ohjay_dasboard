#!/usr/bin/env tsx
/**
 * Check if new_customer_net_sales column exists and has data
 */

import { readFileSync } from 'fs';

// Load environment variables from .env.local or env file
function loadEnvFile() {
  const possibleEnvFiles = [
    process.env.ENV_FILE,
    '.env.local',
    '.env.production.local',
    '.env.development.local',
    '.env',
    'env/local.prod.sh',
    '../env/local.prod.sh',
    '../../env/local.prod.sh',
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
      console.log(`[check] Loaded environment variables from ${envFile}`);
      return;
    } catch (error) {
      // Continue to next file
    }
  }
}

loadEnvFile();

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
  console.error('💡 Tip: Export them in your shell or create .env.local file\n');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function checkMigration() {
  console.log('🔍 Checking if new_customer_net_sales column exists...\n');

  try {
    // Try to query the column directly
    const { data, error } = await supabase
      .from('shopify_daily_sales')
      .select('new_customer_net_sales')
      .limit(1);

    if (error) {
      if (error.message.includes('column') && error.message.includes('new_customer_net_sales')) {
        console.error('❌ Column new_customer_net_sales does NOT exist in shopify_daily_sales table');
        console.error('   You need to run migration 024_add_new_customer_net_sales_to_daily_sales.sql\n');
        return false;
      }
      throw error;
    }

    console.log('✅ Column new_customer_net_sales EXISTS in shopify_daily_sales table\n');
    return true;
  } catch (err) {
    console.error('❌ Error checking column:', err);
    return false;
  }
}

async function checkData() {
  console.log('🔍 Checking for data in shopify_daily_sales with new_customer_net_sales...\n');

  try {
    const { data, error } = await supabase
      .from('shopify_daily_sales')
      .select('date, mode, net_sales_excl_tax, new_customer_net_sales, orders_count')
      .not('new_customer_net_sales', 'is', null)
      .order('date', { ascending: false })
      .limit(10);

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      console.log('⚠️  No data found with new_customer_net_sales populated');
      console.log('   This means either:');
      console.log('   1. Backfill/webhook has not run with the new logic yet');
      console.log('   2. There is no data for the date range\n');
      return false;
    }

    console.log(`✅ Found ${data.length} rows with new_customer_net_sales data:\n`);
    for (const row of data) {
      console.log(
        `   Date: ${row.date}, Mode: ${row.mode}, Net Sales: ${row.net_sales_excl_tax}, New Customer Net Sales: ${row.new_customer_net_sales}, Orders: ${row.orders_count}`,
      );
    }
    console.log('');
    return true;
  } catch (err) {
    console.error('❌ Error checking data:', err);
    return false;
  }
}

async function checkOverviewData() {
  console.log('🔍 Checking if getOverviewData returns new_customer_net_sales...\n');

  try {
    // Get first tenant
    const { data: tenants } = await supabase.from('tenants').select('id, slug').limit(1);

    if (!tenants || tenants.length === 0) {
      console.log('⚠️  No tenants found in database\n');
      return;
    }

    const tenantId = tenants[0].id;
    console.log(`   Testing with tenant: ${tenants[0].slug} (${tenantId})\n`);

    // Import and call getOverviewData
    const { getOverviewData } = await import('../lib/data/agg');
    const result = await getOverviewData({
      tenantId,
      from: '2025-11-01',
      to: '2025-12-08',
    });

    console.log('   Overview totals:');
    console.log(`     Gross Sales: ${result.totals.gross_sales}`);
    console.log(`     Net Sales: ${result.totals.net_sales}`);
    console.log(`     New Customer Net Sales: ${result.totals.new_customer_net_sales}`);
    console.log(`     Marketing Spend: ${result.totals.marketing_spend}`);
    console.log(`     aMER: ${result.totals.amer}`);
    console.log(`     Orders: ${result.totals.orders}\n`);

    if (result.totals.new_customer_net_sales === 0) {
      console.log('⚠️  New Customer Net Sales is 0 - data may not be calculated yet\n');
    } else {
      console.log('✅ New Customer Net Sales is populated!\n');
    }
  } catch (err) {
    console.error('❌ Error checking overview data:', err);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Checking new_customer_net_sales Implementation');
  console.log('═══════════════════════════════════════════════════════\n');

  const columnExists = await checkMigration();
  if (!columnExists) {
    console.log('💡 To fix: Run migration 024_add_new_customer_net_sales_to_daily_sales.sql');
    console.log('   You can use: supabase db push or run the SQL manually\n');
    process.exit(1);
  }

  await checkData();
  await checkOverviewData();

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Check Complete');
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(console.error);

