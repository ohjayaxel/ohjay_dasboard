#!/usr/bin/env tsx

/**
 * Investigate how Shopify Analytics defines "new customer"
 * Compare different definitions: all-time first order vs first order in period
 * 
 * Usage:
 *   pnpm tsx scripts/investigate_new_customer_definition.ts <tenant-slug> <from-date> <to-date>
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
      return;
    } catch (error) {
      // Continue to next file
    }
  }
}

loadEnvFile();

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrdersGraphQL, type GraphQLOrder } from '@/lib/integrations/shopify-graphql';
import { resolveTenantId } from '@/lib/tenants/resolve-tenant';
import { getShopifyConnection } from '@/lib/integrations/shopify';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
  },
});

function parseAmount(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? 0 : parsed;
}

function calculateOrderNetSales(order: GraphQLOrder): number {
  const subtotalPrice = parseAmount(order.subtotalPriceSet?.shopMoney?.amount);
  const totalTax = parseAmount(order.totalTaxSet?.shopMoney?.amount);
  
  // Returns = sum of refund amounts
  let returns = 0;
  if (order.refunds) {
    for (const refund of order.refunds) {
      if (refund.refundLineItems?.edges) {
        for (const edge of refund.refundLineItems.edges) {
          const refundLineItem = edge.node;
          const refundAmount = parseAmount(refundLineItem.subtotalSet?.shopMoney?.amount);
          returns += refundAmount;
        }
      }
    }
  }
  
  // Net Sales = subtotal - tax - returns (EXCL tax)
  return subtotalPrice - totalTax - returns;
}

async function investigateCustomerDefinition(tenantSlug: string, fromDate: string, toDate: string) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  New Customer Definition Investigation');
  console.log('═══════════════════════════════════════════════════════\n');
  
  console.log(`Tenant: ${tenantSlug}`);
  console.log(`Date range: ${fromDate} to ${toDate}\n`);

  const tenantId = await resolveTenantId(tenantSlug);
  const connection = await getShopifyConnection(tenantId);
  if (!connection) {
    throw new Error('No Shopify connection found');
  }

  const shopDomain = (connection.meta as any)?.shop || (connection.meta as any)?.store_domain || (connection.meta as any)?.shopDomain;
  if (!shopDomain) {
    throw new Error('No shop domain found');
  }

  console.log(`Shop domain: ${shopDomain}\n`);

  // Fetch orders via GraphQL
  console.log('📥 Fetching orders via GraphQL...');
  const graphqlOrders = await fetchShopifyOrdersGraphQL({
    tenantId: tenantId,
    shopDomain,
    since: fromDate,
    until: toDate,
    excludeTest: true,
  });

  const validOrders = graphqlOrders.filter((o) => !o.test);
  console.log(`   Fetched ${validOrders.length} valid orders\n`);

  // Fetch ALL orders from database to check historical orders
  console.log('📥 Fetching all historical orders from database...');
  const { data: allDbOrders } = await supabase
    .from('shopify_orders')
    .select('order_id, customer_id, processed_at')
    .eq('tenant_id', tenantId)
    .not('processed_at', 'is', null)
    .order('processed_at');

  const customerFirstOrderInDb = new Map<string, string>(); // customer_id -> first order date in our DB
  if (allDbOrders) {
    for (const dbOrder of allDbOrders) {
      if (dbOrder.customer_id && dbOrder.processed_at) {
        const existingFirst = customerFirstOrderInDb.get(dbOrder.customer_id);
        if (!existingFirst || dbOrder.processed_at < existingFirst) {
          customerFirstOrderInDb.set(dbOrder.customer_id, dbOrder.processed_at);
        }
      }
    }
  }
  console.log(`   Found ${customerFirstOrderInDb.size} customers with historical orders in DB\n`);

  const fromDateObj = new Date(fromDate + 'T00:00:00');
  const toDateObj = new Date(toDate + 'T23:59:59');

  // Analyze different definitions
  console.log('═══════════════════════════════════════════════════════');
  console.log('  ANALYSIS: Different New Customer Definitions');
  console.log('═══════════════════════════════════════════════════════\n');

  // Definition 1: All-time first order (numberOfOrders === 1)
  let def1NewCustomerCount = 0;
  let def1NewCustomerNetSales = 0;
  let def1ReturningNetSales = 0;
  let def1ReturningCount = 0;
  let def1GuestCount = 0;
  let def1GuestNetSales = 0;

  // Definition 2: First order in reporting period (not all-time)
  let def2NewCustomerCount = 0;
  let def2NewCustomerNetSales = 0;
  let def2ReturningNetSales = 0;
  let def2ReturningCount = 0;

  // Track customers seen in this period
  const customersInPeriod = new Map<string, string>(); // customer_id -> first order date in period

  for (const order of validOrders) {
    const orderDate = new Date(order.createdAt);
    const orderId = (order.legacyResourceId || order.id).toString();
    const netSales = calculateOrderNetSales(order);

    if (!order.customer) {
      // Guest checkout
      def1GuestCount++;
      def1GuestNetSales += netSales;
      continue;
    }

    const customerId = order.customer.id;
    const numberOfOrders = parseInt(order.customer.numberOfOrders || '0', 10);

    // Definition 1: All-time first order (numberOfOrders === 1)
    if (numberOfOrders === 1) {
      def1NewCustomerCount++;
      def1NewCustomerNetSales += netSales;
    } else {
      def1ReturningCount++;
      def1ReturningNetSales += netSales;
    }

    // Definition 2: First order in reporting period
    // Check if this customer has an earlier order in our database within the period
    const earlierInPeriod = customersInPeriod.get(customerId);
    if (earlierInPeriod && earlierInPeriod < order.createdAt) {
      // This customer already ordered earlier in this period
      def2ReturningCount++;
      def2ReturningNetSales += netSales;
    } else {
      // First order for this customer in this period
      if (!earlierInPeriod) {
        customersInPeriod.set(customerId, order.createdAt);
      }
      def2NewCustomerCount++;
      def2NewCustomerNetSales += netSales;
    }
  }

  // Definition 3: First order in DB (check if customer has earlier orders in our DB)
  let def3NewCustomerCount = 0;
  let def3NewCustomerNetSales = 0;
  let def3ReturningNetSales = 0;
  let def3ReturningCount = 0;

  for (const order of validOrders) {
    if (!order.customer) continue;

    const customerId = order.customer.id;
    const orderDate = order.createdAt.split('T')[0]; // YYYY-MM-DD
    const netSales = calculateOrderNetSales(order);

    const firstOrderInDb = customerFirstOrderInDb.get(customerId);
    if (!firstOrderInDb || firstOrderInDb >= fromDate) {
      // No earlier order in DB, or first order is in/after this period
      def3NewCustomerCount++;
      def3NewCustomerNetSales += netSales;
    } else {
      def3ReturningCount++;
      def3ReturningNetSales += netSales;
    }
  }

  // Definition 4: Check customer creation date (if available)
  // Note: We'd need to fetch customer details for this, which might be expensive
  // But let's see if we can infer from numberOfOrders and order dates

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('sv-SE', {
      style: 'currency',
      currency: 'SEK',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  console.log('📊 DEFINITION 1: All-Time First Order (numberOfOrders === 1)');
  console.log(`   New Customers:     ${def1NewCustomerCount} orders`);
  console.log(`   New Customer Net:  ${formatCurrency(def1NewCustomerNetSales)}`);
  console.log(`   Returning:         ${def1ReturningCount} orders`);
  console.log(`   Returning Net:     ${formatCurrency(def1ReturningNetSales)}`);
  console.log(`   Guest:             ${def1GuestCount} orders (${formatCurrency(def1GuestNetSales)})`);
  console.log(`   Total Net Sales:   ${formatCurrency(def1NewCustomerNetSales + def1ReturningNetSales + def1GuestNetSales)}`);

  console.log('\n📊 DEFINITION 2: First Order in Reporting Period');
  console.log(`   New Customers:     ${def2NewCustomerCount} orders`);
  console.log(`   New Customer Net:  ${formatCurrency(def2NewCustomerNetSales)}`);
  console.log(`   Returning:         ${def2ReturningCount} orders`);
  console.log(`   Returning Net:     ${formatCurrency(def2ReturningNetSales)}`);
  console.log(`   Total Net Sales:   ${formatCurrency(def2NewCustomerNetSales + def2ReturningNetSales)}`);

  console.log('\n📊 DEFINITION 3: First Order in Our Database');
  console.log(`   New Customers:     ${def3NewCustomerCount} orders`);
  console.log(`   New Customer Net:  ${formatCurrency(def3NewCustomerNetSales)}`);
  console.log(`   Returning:         ${def3ReturningCount} orders`);
  console.log(`   Returning Net:     ${formatCurrency(def3ReturningNetSales)}`);
  console.log(`   Total Net Sales:   ${formatCurrency(def3NewCustomerNetSales + def3ReturningNetSales)}`);

  console.log('\n📊 SHOPIFY ANALYTICS (Expected):');
  console.log(`   New Customers:     230 orders`);
  console.log(`   New Customer Net:  225,014.23 kr`);
  console.log(`   Returning Net:     436,826.61 kr`);
  console.log(`   Total Net Sales:   661,840.84 kr`);

  console.log('\n🔍 COMPARISON WITH SHOPIFY ANALYTICS:');
  const expectedNewNet = 225014.23;
  const expectedReturningNet = 436826.61;
  const expectedTotalNet = 661840.84;
  
  const def1NewDiff = Math.abs(def1NewCustomerNetSales - expectedNewNet);
  const def1ReturningDiff = Math.abs(def1ReturningNetSales - expectedReturningNet);
  const def1TotalDiff = Math.abs((def1NewCustomerNetSales + def1ReturningNetSales) - expectedTotalNet);
  
  const def2NewDiff = Math.abs(def2NewCustomerNetSales - expectedNewNet);
  const def2ReturningDiff = Math.abs(def2ReturningNetSales - expectedReturningNet);
  const def2TotalDiff = Math.abs((def2NewCustomerNetSales + def2ReturningNetSales) - expectedTotalNet);

  console.log(`\n   Definition 1 (All-time, numberOfOrders === 1):`);
  console.log(`      New Customer Net Sales diff: ${formatCurrency(def1NewDiff)} (${((def1NewDiff / expectedNewNet) * 100).toFixed(2)}%)`);
  console.log(`      Returning Net Sales diff: ${formatCurrency(def1ReturningDiff)} (${((def1ReturningDiff / expectedReturningNet) * 100).toFixed(2)}%)`);
  console.log(`      Total Net Sales diff: ${formatCurrency(def1TotalDiff)} (${((def1TotalDiff / expectedTotalNet) * 100).toFixed(2)}%)`);
  
  console.log(`\n   Definition 2 (First order in period):`);
  console.log(`      New Customer Net Sales diff: ${formatCurrency(def2NewDiff)} (${((def2NewDiff / expectedNewNet) * 100).toFixed(2)}%)`);
  console.log(`      Returning Net Sales diff: ${formatCurrency(def2ReturningDiff)} (${((def2ReturningDiff / expectedReturningNet) * 100).toFixed(2)}%)`);
  console.log(`      Total Net Sales diff: ${formatCurrency(def2TotalDiff)} (${((def2TotalDiff / expectedTotalNet) * 100).toFixed(2)}%)`);

  // Analyze customers that differ between definitions
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  CUSTOMERS THAT DIFFER BETWEEN DEFINITIONS');
  console.log('═══════════════════════════════════════════════════════\n');

  let customersWithMultipleOrdersButNewInPeriod = 0;
  let netSalesForMultipleOrdersButNewInPeriod = 0;
  let sampleCustomers: Array<{ customerId: string; numberOfOrders: number; netSales: number }> = [];

  for (const order of validOrders) {
    if (!order.customer) continue;
    
    const customerId = order.customer.id;
    const numberOfOrders = parseInt(order.customer.numberOfOrders || '0', 10);
    const isNewInPeriod = customersInPeriod.get(customerId) === order.createdAt;
    
    if (numberOfOrders > 1 && isNewInPeriod) {
      customersWithMultipleOrdersButNewInPeriod++;
      const netSales = calculateOrderNetSales(order);
      netSalesForMultipleOrdersButNewInPeriod += netSales;
      
      if (sampleCustomers.length < 10) {
        sampleCustomers.push({ customerId, numberOfOrders, netSales });
      }
    }
  }

  console.log(`Customers with numberOfOrders > 1 but FIRST order in this period:`);
  console.log(`   Count: ${customersWithMultipleOrdersButNewInPeriod}`);
  console.log(`   Net Sales: ${formatCurrency(netSalesForMultipleOrdersButNewInPeriod)}`);
  console.log(`   This is ${((netSalesForMultipleOrdersButNewInPeriod / expectedNewNet) * 100).toFixed(2)}% of Shopify's New Customer Net Sales`);
  
  if (sampleCustomers.length > 0) {
    console.log(`\n   Sample customers:`);
    for (const sample of sampleCustomers.slice(0, 5)) {
      console.log(`      Customer ${sample.customerId}: ${sample.numberOfOrders} total orders, ${formatCurrency(sample.netSales)}`);
    }
  }

  // Analyze edge cases
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  EDGE CASE ANALYSIS');
  console.log('═══════════════════════════════════════════════════════\n');

  // Find customers where numberOfOrders > 1 but this might be their first order in our DB
  let customersWithMultipleOrdersButNewInDb = 0;
  let netSalesForMultipleOrdersButNewInDb = 0;

  for (const order of validOrders) {
    if (!order.customer) continue;
    
    const customerId = order.customer.id;
    const numberOfOrders = parseInt(order.customer.numberOfOrders || '0', 10);
    const firstOrderInDb = customerFirstOrderInDb.get(customerId);
    const orderDate = order.createdAt.split('T')[0];

    if (numberOfOrders > 1 && (!firstOrderInDb || firstOrderInDb >= fromDate)) {
      customersWithMultipleOrdersButNewInDb++;
      netSalesForMultipleOrdersButNewInDb += calculateOrderNetSales(order);
    }
  }

  console.log(`Customers with numberOfOrders > 1 but new in our DB:`);
  console.log(`   Count: ${customersWithMultipleOrdersButNewInDb}`);
  console.log(`   Net Sales: ${formatCurrency(netSalesForMultipleOrdersButNewInDb)}`);

  // Find customers with numberOfOrders === 1 but have orders in our DB before this period
  let customersWithOneOrderButReturningInDb = 0;
  let netSalesForOneOrderButReturningInDb = 0;

  for (const order of validOrders) {
    if (!order.customer) continue;
    
    const customerId = order.customer.id;
    const numberOfOrders = parseInt(order.customer.numberOfOrders || '0', 10);
    const firstOrderInDb = customerFirstOrderInDb.get(customerId);

    if (numberOfOrders === 1 && firstOrderInDb && firstOrderInDb < fromDate) {
      customersWithOneOrderButReturningInDb++;
      netSalesForOneOrderButReturningInDb += calculateOrderNetSales(order);
    }
  }

  console.log(`\nCustomers with numberOfOrders === 1 but returning in our DB:`);
  console.log(`   Count: ${customersWithOneOrderButReturningInDb}`);
  console.log(`   Net Sales: ${formatCurrency(netSalesForOneOrderButReturningInDb)}`);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  CONCLUSION');
  console.log('═══════════════════════════════════════════════════════\n');
  
  console.log(`Key Findings:`);
  console.log(`- Definition 1 (All-time, numberOfOrders === 1) gives ${def1NewCustomerCount} new customers, but Shopify Analytics has 230`);
  console.log(`- Definition 2 (First order in period) gives ${def2NewCustomerCount} new customers, which is too many`);
  console.log(`- We found ${customersWithMultipleOrdersButNewInPeriod} customers with numberOfOrders > 1 but whose FIRST order in period is in 2025-01-01 to 2025-01-07`);
  console.log(`- These customers account for ${formatCurrency(netSalesForMultipleOrdersButNewInPeriod)} in net sales`);
  console.log(`\nHypothesis: Shopify Analytics might use a hybrid definition:`);
  console.log(`  - A customer is "new" if this is their first order in the reporting period`);
  console.log(`  - OR if they have numberOfOrders === 1 (all-time first order)`);
  console.log(`  - But this doesn't fully explain the difference either`);
  console.log(`\n⚠️  IMPORTANT: We need to investigate further. Possible explanations:`);
  console.log(`  1. Shopify Analytics might use customer creation date instead of order date`);
  console.log(`  2. Shopify Analytics might exclude certain order types differently`);
  console.log(`  3. There might be timezone differences in how dates are interpreted`);
  console.log(`  4. Shopify Analytics might use a different calculation method for net sales`);
}

const args = process.argv.slice(2);
if (args.length !== 3) {
  console.error('Usage: pnpm tsx scripts/investigate_new_customer_definition.ts <tenant-slug> <from-date> <to-date>');
  process.exit(1);
}

investigateCustomerDefinition(args[0], args[1], args[2]).catch((error) => {
  console.error('\n❌ Error:', error);
  process.exit(1);
});

