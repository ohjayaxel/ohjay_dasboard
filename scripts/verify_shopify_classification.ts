#!/usr/bin/env -S tsx

/**
 * Verify Shopify customer classification and compare with Shopify Analytics
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
      break;
    } catch {
      // Continue
    }
  }
}

loadEnvFile();

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const client = createClient(supabaseUrl, supabaseKey);

async function verify(tenantSlug: string, from: string, to: string) {
  // Resolve tenant ID
  const { data: tenant } = await client
    .from('tenants')
    .select('id, name')
    .eq('slug', tenantSlug)
    .single();
  
  if (!tenant) {
    console.error(`Tenant ${tenantSlug} not found`);
    return;
  }
  
  const tenantId = tenant.id as string;
  console.log(`\nVerifying data for: ${tenant.name} (${tenantSlug})\n`);
  
  // Get daily sales for period
  const { data: dailySales, error } = await client
    .from('shopify_daily_sales')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('mode', 'shopify')
    .gte('date', from)
    .lte('date', to)
    .order('date', { ascending: true });
  
  if (error) {
    console.error('Error fetching daily sales:', error);
    return;
  }
  
  console.log(`=== Shopify Mode Daily Sales (${from} to ${to}) ===\n`);
  
  let totalNetSales = 0;
  let totalNewCustomerNetSales = 0;
  let totalReturningNetSales = 0;
  let totalGuestNetSales = 0;
  let totalOrders = 0;
  let newCustomerOrders = 0;
  
  // Count new customer orders from shopify_orders where order was created in period
  // For Shopify Mode, we need orders where created_at is in period AND customer_type_shopify_mode is FIRST_TIME
  const { data: orders } = await client
    .from('shopify_orders')
    .select('order_id, created_at, customer_type_shopify_mode, processed_at, net_sales')
    .eq('tenant_id', tenantId)
    .gte('processed_at', from)
    .lte('processed_at', to);
  
  if (orders) {
    // Count orders where created_at is in period AND classified as FIRST_TIME
    newCustomerOrders = orders.filter(o => {
      const createdInPeriod = o.created_at && o.created_at >= from && o.created_at <= to;
      return createdInPeriod && o.customer_type_shopify_mode === 'FIRST_TIME';
    }).length;
  }
  
  for (const row of dailySales || []) {
    console.log(`${row.date}:`);
    console.log(`  Net Sales: ${(row.net_sales_excl_tax || 0).toFixed(2)} kr`);
    console.log(`  New Customer: ${(row.new_customer_net_sales || 0).toFixed(2)} kr`);
    console.log(`  Returning: ${(row.returning_customer_net_sales || 0).toFixed(2)} kr`);
    console.log(`  Guest: ${(row.guest_net_sales || 0).toFixed(2)} kr`);
    console.log(`  Orders: ${row.orders_count}`);
    console.log('');
    
    totalNetSales += parseFloat((row.net_sales_excl_tax || 0).toString());
    totalNewCustomerNetSales += parseFloat((row.new_customer_net_sales || 0).toString());
    totalReturningNetSales += parseFloat((row.returning_customer_net_sales || 0).toString());
    totalGuestNetSales += parseFloat((row.guest_net_sales || 0).toString());
    totalOrders += row.orders_count || 0;
  }
  
  console.log('=== TOTALS ===');
  console.log(`Net Sales: ${totalNetSales.toFixed(2)} kr`);
  console.log(`New Customer Net Sales: ${totalNewCustomerNetSales.toFixed(2)} kr`);
  console.log(`Returning Customer Net Sales: ${totalReturningNetSales.toFixed(2)} kr`);
  console.log(`Guest Net Sales: ${totalGuestNetSales.toFixed(2)} kr`);
  console.log(`Total Orders: ${totalOrders}`);
  console.log(`New Customer Orders: ${newCustomerOrders}`);
  console.log('');
  
  // Compare with Shopify Analytics (from user's previous data)
  if (from === '2025-01-01' && to === '2025-01-07') {
    console.log('=== Comparison with Shopify Analytics ===');
    console.log('Shopify Analytics:');
    console.log('  Net Sales: 661 840,84 kr');
    console.log('  New Customer Net Sales: 225 014,23 kr');
    console.log('  New Customer Orders: 230');
    console.log('');
    console.log('Our Platform:');
    console.log(`  Net Sales: ${totalNetSales.toFixed(2)} kr (diff: ${(totalNetSales - 661840.84).toFixed(2)} kr)`);
    console.log(`  New Customer Net Sales: ${totalNewCustomerNetSales.toFixed(2)} kr (diff: ${(totalNewCustomerNetSales - 225014.23).toFixed(2)} kr)`);
    console.log(`  New Customer Orders: ${newCustomerOrders} (diff: ${newCustomerOrders - 230})`);
    console.log('');
    
    const netSalesDiffPercent = ((totalNetSales - 661840.84) / 661840.84 * 100).toFixed(2);
    const newCustomerDiffPercent = ((totalNewCustomerNetSales - 225014.23) / 225014.23 * 100).toFixed(2);
    
    console.log(`Net Sales difference: ${netSalesDiffPercent}%`);
    console.log(`New Customer Net Sales difference: ${newCustomerDiffPercent}%`);
  } else if (from === '2025-01-01' && to === '2025-01-31') {
    console.log('=== Comparison with Shopify Analytics ===');
    console.log('Shopify Analytics:');
    console.log('  New Customer Net Sales: 719 001,54 kr');
    console.log('');
    console.log('Our Platform:');
    console.log(`  New Customer Net Sales: ${totalNewCustomerNetSales.toFixed(2)} kr (diff: ${(totalNewCustomerNetSales - 719001.54).toFixed(2)} kr)`);
    console.log('');
    
    const newCustomerDiffPercent = ((totalNewCustomerNetSales - 719001.54) / 719001.54 * 100).toFixed(2);
    
    console.log(`New Customer Net Sales difference: ${newCustomerDiffPercent}%`);
  }
}

const tenantSlug = process.argv[2] || 'skinome';
const from = process.argv[3] || '2025-01-01';
const to = process.argv[4] || '2025-01-07';

verify(tenantSlug, from, to).catch(console.error);

