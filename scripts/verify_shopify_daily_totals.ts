/**
 * Verification Script: Compare our daily totals against Shopify Analytics
 * 
 * Tests multiple dates to ensure our Net Sales calculations match Shopify 1:1
 */

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrdersGraphQL, GraphQLOrder } from '../lib/integrations/shopify-graphql';
import { processOrder } from './research_shopify_data';

// Load environment variables
const envPath = require('path').resolve(process.cwd(), 'env', 'local.prod.sh');
try {
  const envFile = require('fs').readFileSync(envPath, 'utf-8');
  envFile.split('\n').forEach((line: string) => {
    if (line && !line.startsWith('#') && line.includes('=')) {
      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=').replace(/^["']|["']$/g, '').trim();
      if (key && value) {
        process.env[key.trim()] = value;
      }
    }
  });
} catch (e) {
  console.warn('Could not load env file, using existing environment variables');
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);

const STORE_TIMEZONE = 'Europe/Stockholm';

function toLocalDate(timestamp: string, timezone: string): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

async function verifyDate(tenantId: string, shopDomain: string, date: string): Promise<{
  date: string;
  ourOrders: number;
  ourNetSales: number;
  ourGrossSales: number;
  ourDiscounts: number;
  ourTax: number;
  ourReturns: number;
  errors: string[];
}> {
  console.log(`\nVerifying date: ${date}...`);
  
  // Fetch orders in wider range (-1 to +1 day)
  const startDateObj = new Date(date + 'T00:00:00Z');
  const endDateObj = new Date(date + 'T23:59:59Z');
  
  const fetchStartDate = new Date(startDateObj);
  fetchStartDate.setDate(fetchStartDate.getDate() - 1);
  const fetchEndDate = new Date(endDateObj);
  fetchEndDate.setDate(fetchEndDate.getDate() + 1);
  
  const fetchStartDateStr = fetchStartDate.toISOString().slice(0, 10);
  const fetchEndDateStr = fetchEndDate.toISOString().slice(0, 10);
  
  const orders = await fetchShopifyOrdersGraphQL({
    tenantId,
    shopDomain,
    since: fetchStartDateStr,
    until: fetchEndDateStr,
    excludeTest: true,
  });
  
  // Process orders and filter to target date
  const ordersData: ReturnType<typeof processOrder>[] = [];
  const errors: string[] = [];
  
  for (const order of orders) {
    if (order.cancelledAt) {
      continue;
    }
    
    const successfulTransactions = (order.transactions || []).filter(
      (txn) =>
        (txn.kind === 'SALE' || txn.kind === 'CAPTURE') &&
        txn.status === 'SUCCESS' &&
        txn.processedAt,
    );
    
    if (successfulTransactions.length === 0) {
      continue;
    }
    
    const transactionTimestamp = successfulTransactions[0].processedAt!;
    const eventDate = toLocalDate(transactionTimestamp, STORE_TIMEZONE);
    
    if (eventDate === date) {
      const orderData = processOrder(order, STORE_TIMEZONE);
      if (orderData) {
        ordersData.push(orderData);
      } else {
        errors.push(`Failed to process order ${order.name}`);
      }
    }
  }
  
  // Aggregate totals
  let totalGrossSales = 0;
  let totalDiscounts = 0;
  let totalTax = 0;
  let totalReturns = 0;
  let totalNetSales = 0;
  
  for (const orderData of ordersData) {
    totalGrossSales += orderData.totalGrossSales;
    totalDiscounts += orderData.totalDiscounts;
    totalTax += orderData.totalTax;
    totalReturns += orderData.totalReturns;
    totalNetSales += orderData.totalNetSales;
  }
  
  return {
    date,
    ourOrders: ordersData.length,
    ourNetSales: Math.round(totalNetSales * 100) / 100,
    ourGrossSales: Math.round(totalGrossSales * 100) / 100,
    ourDiscounts: Math.round(totalDiscounts * 100) / 100,
    ourTax: Math.round(totalTax * 100) / 100,
    ourReturns: Math.round(totalReturns * 100) / 100,
    errors,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const tenantSlug = args.find((arg) => arg.startsWith('--tenant='))?.split('=')[1] || 'skinome';
  const datesArg = args.find((arg) => arg.startsWith('--dates='))?.split('=')[1];
  
  // Default dates: 2025-11-30 (known good date) + 2 more dates
  const dates = datesArg 
    ? datesArg.split(',')
    : ['2025-11-30', '2025-11-29', '2025-12-01'];
  
  console.log('='.repeat(80));
  console.log('Shopify Daily Totals Verification');
  console.log('='.repeat(80));
  console.log(`Tenant: ${tenantSlug}`);
  console.log(`Dates to verify: ${dates.join(', ')}`);
  console.log('='.repeat(80));
  
  // Get tenant and connection
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, slug')
    .eq('slug', tenantSlug)
    .maybeSingle();
  
  if (!tenant) {
    console.error(`❌ Tenant "${tenantSlug}" not found`);
    process.exit(1);
  }
  
  const { data: connection } = await supabase
    .from('connections')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('source', 'shopify')
    .maybeSingle();
  
  if (!connection) {
    console.error('❌ Shopify connection not found');
    process.exit(1);
  }
  
  const shopDomain = connection.meta?.store_domain || connection.meta?.shop;
  
  // Verify each date
  const results = [];
  for (const date of dates) {
    const result = await verifyDate(tenant.id, shopDomain, date);
    results.push(result);
  }
  
  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('VERIFICATION RESULTS');
  console.log('='.repeat(80));
  console.log('');
  console.log('Date       | Orders | Net Sales (EXCL tax) | Gross Sales | Discounts | Tax      | Returns');
  console.log('-'.repeat(80));
  
  for (const result of results) {
    console.log(
      `${result.date} | ${result.ourOrders.toString().padStart(6)} | ${result.ourNetSales.toFixed(2).padStart(20)} | ${result.ourGrossSales.toFixed(2).padStart(11)} | ${result.ourDiscounts.toFixed(2).padStart(9)} | ${result.ourTax.toFixed(2).padStart(8)} | ${result.ourReturns.toFixed(2)}`
    );
    
    if (result.errors.length > 0) {
      console.log(`  ⚠️  Errors: ${result.errors.join(', ')}`);
    }
  }
  
  console.log('');
  console.log('='.repeat(80));
  console.log('INSTRUCTIONS FOR MANUAL VERIFICATION');
  console.log('='.repeat(80));
  console.log('');
  console.log('To verify these totals match Shopify Analytics:');
  console.log('1. Go to Shopify Admin → Analytics → Reports');
  console.log('2. Select "Sales by date" or "Finances → Sales"');
  console.log('3. Set date range to each date above');
  console.log('4. Compare "Net Sales" (EXCL tax) with our calculated values');
  console.log('');
  console.log('Expected differences:');
  console.log('  - Should be 0 or < 1.00 SEK (only rounding differences)');
  console.log('  - If larger differences occur, check:');
  console.log('    * Are we filtering cancelled orders correctly?');
  console.log('    * Are we using the correct date (transaction.processedAt)?');
  console.log('    * Are we using the correct financial_status filter?');
  console.log('');
}

main().catch(console.error);


