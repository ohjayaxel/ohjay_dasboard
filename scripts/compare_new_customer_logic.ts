#!/usr/bin/env tsx

/**
 * Compare new customer logic - investigate the 4.9M SEK discrepancy
 * 
 * Shopify: 14,669,650.35 SEK
 * Us: 9,759,438 SEK
 * Difference: ~4,910,212 SEK (33%)
 */

import { readFileSync } from 'fs';

function loadEnvFile() {
  const possibleEnvFiles = [
    '.env.local',
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

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrdersGraphQL } from '@/lib/integrations/shopify-graphql';
import { convertGraphQLOrderToShopifyOrder, calculateOrderSales } from '@/lib/shopify/sales';
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

async function analyze(tenantSlug: string, fromDate: string, toDate: string) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  New Customer Net Sales Analysis');
  console.log('═══════════════════════════════════════════════════════\n');

  const tenantId = await resolveTenantId(tenantSlug);
  const connection = await getShopifyConnection(tenantId);
  if (!connection) throw new Error('No Shopify connection');

  const shopDomain = (connection.meta?.shop || connection.meta?.store_domain || connection.meta?.shopDomain) as string;
  if (!shopDomain) throw new Error('No shop domain');

  // Get our database totals
  const { data: ourData } = await supabase
    .from('shopify_daily_sales')
    .select('net_sales_excl_tax, new_customer_net_sales')
    .eq('tenant_id', tenantId)
    .eq('mode', 'shopify')
    .gte('date', fromDate)
    .lte('date', toDate);

  const ourTotalNetSales = ourData?.reduce((s, r) => s + (r.net_sales_excl_tax || 0), 0) || 0;
  const ourTotalNewCustomerNetSales = ourData?.reduce((s, r) => s + (r.new_customer_net_sales || 0), 0) || 0;

  console.log('📊 Expected (from Shopify Analytics):');
  console.log(`   Net Sales: 44,943,158.74 SEK`);
  console.log(`   New Customer Net Sales: 14,669,650.35 SEK\n`);

  console.log('📊 Our calculation:');
  console.log(`   Net Sales: ${ourTotalNetSales.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`);
  console.log(`   New Customer Net Sales: ${ourTotalNewCustomerNetSales.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK\n`);

  const netSalesDiff = 44943158.74 - ourTotalNetSales;
  const newCustomerDiff = 14669650.35 - ourTotalNewCustomerNetSales;

  console.log('📊 Differences:');
  console.log(`   Net Sales diff: ${netSalesDiff.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK (${((netSalesDiff / 44943158.74) * 100).toFixed(2)}%)`);
  console.log(`   New Customer Net Sales diff: ${newCustomerDiff.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK (${((newCustomerDiff / 14669650.35) * 100).toFixed(2)}%)\n`);

  // Fetch a sample of orders to analyze
  console.log('📥 Fetching sample orders for analysis...');
  const graphqlOrders = await fetchShopifyOrdersGraphQL({
    tenantId,
    shopDomain,
    since: fromDate,
    until: toDate,
    excludeTest: true,
  });

  console.log(`✅ Found ${graphqlOrders.length} orders\n`);

  const convertedOrders = graphqlOrders
    .filter((o) => !o.test)
    .map((o) => convertGraphQLOrderToShopifyOrder(o));

  // Analyze by numberOfOrders
  let newCustomerCount = 0;
  let newCustomerNetSales = 0;
  let returningCount = 0;
  let returningNetSales = 0;
  let guestCount = 0;
  let guestNetSales = 0;

  const customersFirstOrderDate = new Map<string, string>(); // customerId -> first order createdAt

  // First pass: find first order date per customer
  for (const order of graphqlOrders) {
    if (!order.customer?.id) continue;
    const customerId = order.customer.id;
    const createdAt = order.createdAt;
    
    const existing = customersFirstOrderDate.get(customerId);
    if (!existing || createdAt < existing) {
      customersFirstOrderDate.set(customerId, createdAt);
    }
  }

  // Second pass: calculate using "first order in period" logic
  let newCustomerByFirstOrderInPeriod = 0;
  let newCustomerNetSalesByFirstOrderInPeriod = 0;

  for (const graphqlOrder of graphqlOrders) {
    const orderId = (graphqlOrder.legacyResourceId || graphqlOrder.id).toString();
    const convertedOrder = convertedOrders.find(o => o.id.toString() === orderId);
    if (!convertedOrder) continue;

    const orderSales = calculateOrderSales(convertedOrder);
    const netSales = orderSales.netSales;

    if (!graphqlOrder.customer) {
      guestCount++;
      guestNetSales += netSales;
    } else {
      const customerId = graphqlOrder.customer.id;
      const numberOfOrders = parseInt(graphqlOrder.customer.numberOfOrders || '0', 10);
      
      // Our current logic: numberOfOrders === 1
      if (numberOfOrders === 1) {
        newCustomerCount++;
        newCustomerNetSales += netSales;
      } else {
        returningCount++;
        returningNetSales += netSales;
      }

      // Alternative logic: first order in THIS period
      const firstOrderDate = customersFirstOrderDate.get(customerId);
      if (firstOrderDate) {
        const firstOrderDateOnly = firstOrderDate.split('T')[0];
        if (firstOrderDateOnly >= fromDate && firstOrderDateOnly <= toDate) {
          // This customer's first order was in this period
          const orderDate = graphqlOrder.createdAt.split('T')[0];
          if (orderDate === firstOrderDateOnly) {
            // This is their first order
            newCustomerByFirstOrderInPeriod++;
            newCustomerNetSalesByFirstOrderInPeriod += netSales;
          }
        }
      }
    }
  }

  console.log('📊 Customer classification (our current logic - numberOfOrders === 1):');
  console.log(`   New customers: ${newCustomerCount}`);
  console.log(`   New customer net sales: ${newCustomerNetSales.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`);
  console.log(`   Returning customers: ${returningCount}`);
  console.log(`   Returning customer net sales: ${returningNetSales.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`);
  console.log(`   Guest checkouts: ${guestCount}`);
  console.log(`   Guest net sales: ${guestNetSales.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK\n`);

  console.log('📊 Alternative classification (first order in period 2025-01-01 to 2025-12-08):');
  console.log(`   New customers (first order in period): ${newCustomerByFirstOrderInPeriod}`);
  console.log(`   New customer net sales: ${newCustomerNetSalesByFirstOrderInPeriod.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK\n`);

  console.log('💡 Hypothesis:');
  console.log('   Shopify Analytics "new customer" might be based on:');
  console.log('   1. First order EVER (numberOfOrders === 1) - our current approach');
  console.log('   2. First order in the REPORT PERIOD (not all-time)');
  console.log('   3. Some other Shopify-specific logic\n');

  console.log('🔍 Next steps to verify:');
  console.log('   1. Check Shopify Analytics documentation for "new customer" definition');
  console.log('   2. Manually verify a few order IDs in Shopify Admin');
  console.log('   3. Check if Shopify uses a different date (createdAt vs processedAt)');
  console.log('   4. Verify if refunds affect new customer classification differently\n');
}

const tenantSlug = process.argv[2] || 'skinome';
const fromDate = process.argv[3] || '2025-01-01';
const toDate = process.argv[4] || '2025-12-08';

analyze(tenantSlug, fromDate, toDate).catch((error) => {
  console.error('\n❌ Error:', error);
  process.exit(1);
});

