#!/usr/bin/env tsx

/**
 * Recalculate shopify_daily_sales with new_customer_net_sales
 * for existing dates using is_new_customer from shopify_orders
 * 
 * Usage:
 *   pnpm tsx scripts/recalculate_daily_sales_new_customers.ts <tenant-slug> <from-date> <to-date>
 * 
 * Example:
 *   pnpm tsx scripts/recalculate_daily_sales_new_customers.ts skinome 2025-11-01 2025-12-08
 */

import { ArgumentParser } from 'argparse';
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
      console.log(`[recalculate] Loaded environment variables from ${envFile}`);
      return;
    } catch (error) {
      // Continue to next file
    }
  }
  
  if (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL) {
    console.log(`[recalculate] Using existing environment variables`);
    return;
  }
  
  console.warn(`[recalculate] Warning: Could not load env file. Make sure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.`);
}

loadEnvFile();

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrdersGraphQL } from '@/lib/integrations/shopify-graphql';
import { convertGraphQLOrderToShopifyOrder } from '@/lib/shopify/order-converter';
import { calculateDailySales, type SalesMode } from '@/lib/shopify/sales';
import { resolveTenantId } from '@/lib/tenants/resolve-tenant';
import { getShopifyConnection } from '@/lib/integrations/shopify';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('\n❌ Error: Missing environment variables');
  console.error('   NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL');
  console.error('   SUPABASE_SERVICE_ROLE_KEY');
  console.error('\n💡 Tip: Export them in your shell or create .env.local file\n');
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
  },
});

async function recalculateDailySales(tenantSlug: string, fromDate: string, toDate: string) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Recalculate Daily Sales with New Customer Net Sales');
  console.log('═══════════════════════════════════════════════════════\n');
  
  console.log(`Tenant: ${tenantSlug}`);
  console.log(`Date range: ${fromDate} to ${toDate}\n`);

  const tenantId = await resolveTenantId(tenantSlug);
  console.log(`Tenant ID: ${tenantId}\n`);
  
  // Get shopify connection
  const connection = await getShopifyConnection(tenantId);
  if (!connection) {
    throw new Error('No Shopify connection found for tenant');
  }

  const shopDomain = (connection.meta?.shop || connection.meta?.store_domain || connection.meta?.shopDomain) as string;
  if (!shopDomain) {
    console.error('Connection meta:', connection.meta);
    throw new Error('No shop domain found in connection meta. Expected: shop, store_domain, or shopDomain');
  }

  console.log(`Shop domain: ${shopDomain}\n`);

  // Fetch orders for the date range via GraphQL
  console.log(`📥 Fetching orders from ${fromDate} to ${toDate}...`);
  const graphqlOrders = await fetchShopifyOrdersGraphQL({
    tenantId,
    shopDomain,
    since: fromDate,
    until: toDate,
    excludeTest: true,
  });

  console.log(`✅ Found ${graphqlOrders.length} orders\n`);

  // Build orderCustomerMap directly from GraphQL data using customer.numberOfOrders
  // numberOfOrders === "1" means new customer, > "1" means returning customer
  console.log(`📊 Determining new vs returning customers from GraphQL data...`);
  
  const orderCustomerMap = new Map<string, boolean>();
  let newCustomerCount = 0;
  let returningCustomerCount = 0;
  let guestCustomerCount = 0;
  
  for (const order of graphqlOrders) {
    const orderId = (order.legacyResourceId || order.id).toString();
    
    if (!order.customer) {
      // Guest checkout - not a new customer
      orderCustomerMap.set(orderId, false);
      guestCustomerCount++;
    } else {
      // Check numberOfOrders - "1" means this is their first order (new customer)
      const numberOfOrders = parseInt(order.customer.numberOfOrders || '0', 10);
      const isNewCustomer = numberOfOrders === 1;
      orderCustomerMap.set(orderId, isNewCustomer);
      
      if (isNewCustomer) {
        newCustomerCount++;
      } else {
        returningCustomerCount++;
      }
    }
  }

  console.log(`✅ Customer classification:`);
  console.log(`   New customers: ${newCustomerCount}`);
  console.log(`   Returning customers: ${returningCustomerCount}`);
  console.log(`   Guest checkouts: ${guestCustomerCount}\n`);

  // Convert and calculate daily sales
  console.log('🔄 Converting orders and calculating daily sales...');
  const shopifyOrdersWithTransactions = graphqlOrders
    .filter((o) => !o.test)
    .map(convertGraphQLOrderToShopifyOrder);

  const shopifyModeDaily = calculateDailySales(
    shopifyOrdersWithTransactions,
    'shopify',
    'Europe/Stockholm',
    orderCustomerMap
  );

  console.log(`✅ Calculated ${shopifyModeDaily.length} daily sales rows\n`);

  // Show summary
  const totalNewCustomerNetSales = shopifyModeDaily.reduce((sum, row) => sum + (row.newCustomerNetSales || 0), 0);
  console.log('📊 Summary:');
  console.log(`   Total days: ${shopifyModeDaily.length}`);
  console.log(`   Total new customer net sales: ${totalNewCustomerNetSales.toFixed(2)}\n`);

  // Upsert to database
  console.log('💾 Upserting to shopify_daily_sales table...');
  const dailySalesRows = shopifyModeDaily.map((row) => ({
    tenant_id: tenantId,
    date: row.date,
    mode: 'shopify' as SalesMode,
    net_sales_excl_tax: row.netSalesExclTax,
    gross_sales_excl_tax: row.grossSalesExclTax || null,
    refunds_excl_tax: row.refundsExclTax || null,
    discounts_excl_tax: row.discountsExclTax || null,
    orders_count: row.ordersCount,
    currency: row.currency || null,
    new_customer_net_sales: row.newCustomerNetSales || null,
  }));

  const { error: upsertError } = await supabase
    .from('shopify_daily_sales')
    .upsert(dailySalesRows, {
      onConflict: 'tenant_id,date,mode',
    });

  if (upsertError) {
    throw new Error(`Failed to upsert daily sales: ${upsertError.message}`);
  }

  console.log(`✅ Successfully upserted ${dailySalesRows.length} rows\n`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Done! Daily sales recalculated with new_customer_net_sales');
  console.log('═══════════════════════════════════════════════════════\n');
}

async function findDateRange(tenantId: string): Promise<{ from: string; to: string } | null> {
  console.log('🔍 Finding date range for existing data...\n');
  
  // Find the earliest and latest dates in shopify_daily_sales
  const { data: dateRange, error } = await supabase
    .from('shopify_daily_sales')
    .select('date')
    .eq('tenant_id', tenantId)
    .eq('mode', 'shopify')
    .order('date', { ascending: true });

  if (error || !dateRange || dateRange.length === 0) {
    console.log('⚠️  No existing daily sales data found. Using orders table instead...\n');
    
    // Fallback: find date range from shopify_orders
    const { data: ordersRange, error: ordersError } = await supabase
      .from('shopify_orders')
      .select('processed_at')
      .eq('tenant_id', tenantId)
      .not('processed_at', 'is', null)
      .order('processed_at', { ascending: true })
      .limit(1);

    if (ordersError || !ordersRange || ordersRange.length === 0) {
      console.log('⚠️  No orders found either. Please specify --from and --to dates.\n');
      return null;
    }

    const firstOrderDate = ordersRange[0].processed_at as string;
    const today = new Date().toISOString().slice(0, 10);
    
    return { from: firstOrderDate, to: today };
  }

  const dates = dateRange.map(r => r.date as string).sort();
  const from = dates[0];
  const to = dates[dates.length - 1];

  console.log(`✅ Found ${dates.length} days of data:`);
  console.log(`   Earliest date: ${from}`);
  console.log(`   Latest date: ${to}\n`);

  return { from, to };
}

// Parse arguments
const parser = new ArgumentParser({
  description: 'Recalculate shopify_daily_sales with new_customer_net_sales',
});

parser.add_argument('tenant', {
  help: 'Tenant slug (e.g., skinome)',
  nargs: '?',
  default: 'skinome',
});

parser.add_argument('--from', {
  help: 'Start date (YYYY-MM-DD). If not specified, will auto-detect from existing data.',
  default: null,
});

parser.add_argument('--to', {
  help: 'End date (YYYY-MM-DD). Defaults to today if not specified.',
  default: new Date().toISOString().slice(0, 10),
});

parser.add_argument('--auto', {
  help: 'Auto-detect date range from existing data',
  action: 'store_true',
  default: false,
});

const args = parser.parse_args();

(async () => {
  const tenantId = await resolveTenantId(args.tenant);
  
  let fromDate = args.from;
  let toDate = args.to;

  // Auto-detect date range if --auto is specified or --from is not provided
  if (args.auto || !fromDate) {
    const dateRange = await findDateRange(tenantId);
    if (dateRange) {
      fromDate = fromDate || dateRange.from;
      toDate = args.to === new Date().toISOString().slice(0, 10) ? dateRange.to : args.to;
      console.log(`📅 Using date range: ${fromDate} to ${toDate}\n`);
    } else if (!fromDate) {
      console.error('❌ Could not auto-detect date range. Please specify --from date.\n');
      process.exit(1);
    }
  }

  await recalculateDailySales(args.tenant, fromDate!, toDate);
})().catch((error) => {
  console.error('\n❌ Error:', error);
  process.exit(1);
});

