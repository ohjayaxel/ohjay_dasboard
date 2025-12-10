#!/usr/bin/env tsx

/**
 * Investigate new customer net sales discrepancy
 * 
 * Compares our calculation vs Shopify Analytics for new customer net sales
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
      console.log(`[investigate] Loaded environment variables from ${envFile}`);
      return;
    } catch (error) {
      // Continue to next file
    }
  }
}

loadEnvFile();

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrdersGraphQL } from '@/lib/integrations/shopify-graphql';
import { convertGraphQLOrderToShopifyOrder } from '@/lib/shopify/order-converter';
import { calculateOrderSales } from '@/lib/shopify/sales';
import { resolveTenantId } from '@/lib/tenants/resolve-tenant';
import { getShopifyConnection } from '@/lib/integrations/shopify';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

async function investigate(tenantSlug: string, fromDate: string, toDate: string) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  New Customer Net Sales Discrepancy Investigation');
  console.log('═══════════════════════════════════════════════════════\n');

  const tenantId = await resolveTenantId(tenantSlug);
  const connection = await getShopifyConnection(tenantId);
  if (!connection) throw new Error('No Shopify connection found');

  const shopDomain = (connection.meta?.shop || connection.meta?.store_domain || connection.meta?.shopDomain) as string;
  if (!shopDomain) throw new Error('No shop domain found');

  console.log(`Tenant: ${tenantSlug}`);
  console.log(`Date range: ${fromDate} to ${toDate}\n`);

  // Fetch all orders
  console.log('📥 Fetching orders...');
  const graphqlOrders = await fetchShopifyOrdersGraphQL({
    tenantId,
    shopDomain,
    since: fromDate,
    until: toDate,
    excludeTest: true,
  });

  console.log(`✅ Found ${graphqlOrders.length} orders\n`);

  // Get our database data
  console.log('📊 Fetching our daily sales data...');
  const { data: ourDailySales, error } = await supabase
    .from('shopify_daily_sales')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('mode', 'shopify')
    .gte('date', fromDate)
    .lte('date', toDate)
    .order('date', { ascending: true });

  if (error) throw error;

  const ourTotalNetSales = ourDailySales?.reduce((sum, row) => sum + (row.net_sales_excl_tax || 0), 0) || 0;
  const ourTotalNewCustomerNetSales = ourDailySales?.reduce((sum, row) => sum + (row.new_customer_net_sales || 0), 0) || 0;

  console.log(`✅ Our totals:`);
  console.log(`   Net Sales: ${ourTotalNetSales.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}`);
  console.log(`   New Customer Net Sales: ${ourTotalNewCustomerNetSales.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}\n`);

  // Analyze orders with customer data
  console.log('📊 Analyzing customer classification...\n');

  const convertedOrders = graphqlOrders
    .filter((o) => !o.test)
    .map(convertGraphQLOrderToShopifyOrder);

  let newCustomerByNumberOfOrders = 0;
  let newCustomerNetSalesByNumberOfOrders = 0;
  let returningCustomerByNumberOfOrders = 0;
  let returningCustomerNetSales = 0;
  let guestCheckouts = 0;
  let guestCheckoutNetSales = 0;

  const newCustomerOrderIds = new Set<string>();
  const returningCustomerOrderIds = new Set<string>();

  for (const graphqlOrder of graphqlOrders) {
    const orderId = (graphqlOrder.legacyResourceId || graphqlOrder.id).toString();
    const convertedOrder = convertedOrders.find(o => o.id.toString() === orderId);
    
    if (!convertedOrder) continue;

    const orderSales = calculateOrderSales(convertedOrder);
    const netSales = orderSales.netSales;

    if (!graphqlOrder.customer) {
      guestCheckouts++;
      guestCheckoutNetSales += netSales;
    } else {
      const numberOfOrders = parseInt(graphqlOrder.customer.numberOfOrders || '0', 10);
      
      if (numberOfOrders === 1) {
        newCustomerByNumberOfOrders++;
        newCustomerNetSalesByNumberOfOrders += netSales;
        newCustomerOrderIds.add(orderId);
      } else if (numberOfOrders > 1) {
        returningCustomerByNumberOfOrders++;
        returningCustomerNetSales += netSales;
        returningCustomerOrderIds.add(orderId);
      }
    }
  }

  console.log('📊 Customer Classification by numberOfOrders:');
  console.log(`   New customers (numberOfOrders === 1):`);
  console.log(`     Orders: ${newCustomerByNumberOfOrders}`);
  console.log(`     Net Sales: ${newCustomerNetSalesByNumberOfOrders.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}`);
  console.log(`   Returning customers (numberOfOrders > 1):`);
  console.log(`     Orders: ${returningCustomerByNumberOfOrders}`);
  console.log(`     Net Sales: ${returningCustomerNetSales.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}`);
  console.log(`   Guest checkouts:`);
  console.log(`     Orders: ${guestCheckouts}`);
  console.log(`     Net Sales: ${guestCheckoutNetSales.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}\n`);

  // Check if there's a difference in how we determine new customers
  console.log('🔍 Potential issues:\n');

  // Check if we're using order.createdAt vs processedAt
  const ordersWithDateMismatch = graphqlOrders.filter((o) => {
    const createdAt = new Date(o.createdAt);
    const processedAt = o.processedAt ? new Date(o.processedAt) : null;
    if (!processedAt) return false;
    
    // Check if dates are different
    const createdAtDate = createdAt.toISOString().slice(0, 10);
    const processedAtDate = processedAt.toISOString().slice(0, 10);
    return createdAtDate !== processedAtDate;
  });

  console.log(`   Orders with createdAt != processedAt: ${ordersWithDateMismatch.length}`);
  if (ordersWithDateMismatch.length > 0) {
    console.log(`   ⚠️  Note: Shopify Analytics groups by order.createdAt, but we may be using different dates\n`);
  }

  // Check if numberOfOrders might be calculated differently by Shopify
  console.log(`   ⚠️  Shopify's numberOfOrders is cumulative (all-time), not per period`);
  console.log(`   ⚠️  Shopify Analytics "new customer" might be based on first purchase EVER, not first in period`);
  console.log(`   ⚠️  But it might also consider the date context - need to verify Shopify's exact logic\n`);

  // Sample some orders to see customer data
  console.log('📋 Sample orders (first 10 new customers):');
  let sampleCount = 0;
  for (const graphqlOrder of graphqlOrders) {
    if (sampleCount >= 10) break;
    
    const orderId = (graphqlOrder.legacyResourceId || graphqlOrder.id).toString();
    if (!newCustomerOrderIds.has(orderId)) continue;

    const convertedOrder = convertedOrders.find(o => o.id.toString() === orderId);
    if (!convertedOrder) continue;

    const orderSales = calculateOrderSales(convertedOrder);
    const numberOfOrders = graphqlOrder.customer?.numberOfOrders || '0';
    
    console.log(`   Order ${orderId}:`);
    console.log(`     Customer ID: ${graphqlOrder.customer?.id || 'N/A'}`);
    console.log(`     numberOfOrders: ${numberOfOrders}`);
    console.log(`     createdAt: ${graphqlOrder.createdAt}`);
    console.log(`     processedAt: ${graphqlOrder.processedAt || 'N/A'}`);
    console.log(`     Net Sales: ${orderSales.netSales.toFixed(2)} SEK\n`);
    
    sampleCount++;
  }

  console.log('═══════════════════════════════════════════════════════\n');
  console.log('💡 Next steps:');
  console.log('   1. Verify Shopify Analytics "new customer" definition');
  console.log('   2. Check if Shopify uses order.createdAt or transaction.processedAt');
  console.log('   3. Verify if Shopify counts new customers per period or all-time');
  console.log('   4. Compare a few specific order IDs manually in Shopify Admin\n');
}

const args = process.argv.slice(2);
const tenantSlug = args[0] || 'skinome';
const fromDate = args[1] || '2025-01-01';
const toDate = args[2] || new Date().toISOString().slice(0, 10);

investigate(tenantSlug, fromDate, toDate).catch((error) => {
  console.error('\n❌ Error:', error);
  process.exit(1);
});


