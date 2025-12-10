#!/usr/bin/env tsx

/**
 * Test script to validate Shopify calculations against Shopify Analytics
 * Tests a short date range and shows breakdown by country and customer type
 * 
 * Usage:
 *   pnpm tsx scripts/test_shopify_calculations.ts <tenant-slug> <from-date> <to-date>
 * 
 * Example:
 *   pnpm tsx scripts/test_shopify_calculations.ts skinome 2025-12-01 2025-12-07
 */

import { ArgumentParser } from 'argparse';
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
      console.log(`[test] Loaded environment variables from ${envFile}`);
      return;
    } catch (error) {
      // Continue to next file
    }
  }
  
  if (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL) {
    console.log(`[test] Using existing environment variables`);
    return;
  }
  
  console.warn(`[test] Warning: Could not load env file. Make sure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.`);
}

loadEnvFile();

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrdersGraphQL, type GraphQLOrder } from '@/lib/integrations/shopify-graphql';
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

type CountryBreakdown = {
  country: string;
  orders: number;
  grossSales: number;
  discounts: number;
  returns: number;
  netSales: number;
  tax: number;
  newCustomerNetSales: number;
  newCustomerOrders: number;
  returningCustomerNetSales: number;
  returningCustomerOrders: number;
};

type CustomerTypeBreakdown = {
  type: 'new' | 'returning' | 'guest';
  orders: number;
  grossSales: number;
  discounts: number;
  returns: number;
  netSales: number;
  tax: number;
};

function parseAmount(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? 0 : parsed;
}

function extractCountry(order: GraphQLOrder): string {
  // Try billing address first, then shipping
  const billing = order.billingAddress;
  const shipping = order.shippingAddress;
  
  if (billing?.countryCode) return billing.countryCode;
  if (billing?.country) return billing.country;
  if (shipping?.countryCode) return shipping.countryCode;
  if (shipping?.country) return shipping.country;
  
  return 'Unknown';
}

function calculateOrderMetrics(order: GraphQLOrder, isNewCustomer: boolean) {
  const subtotalPrice = parseAmount(order.subtotalPriceSet?.shopMoney?.amount);
  const totalTax = parseAmount(order.totalTaxSet?.shopMoney?.amount);
  const totalDiscounts = parseAmount(order.totalDiscountsSet?.shopMoney?.amount);
  
  // Gross Sales = sum of line items (price × quantity)
  let grossSales = 0;
  if (order.lineItems?.edges) {
    for (const edge of order.lineItems.edges) {
      const item = edge.node;
      const price = parseAmount(item.originalUnitPriceSet?.shopMoney?.amount);
      const quantity = item.quantity || 0;
      grossSales += price * quantity;
    }
  }
  
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
  const netSales = subtotalPrice - totalTax - returns;
  
  return {
    grossSales,
    discounts: totalDiscounts,
    returns,
    netSales,
    tax: totalTax,
    isNewCustomer,
  };
}

async function testCalculations(tenantSlug: string, fromDate: string, toDate: string) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Shopify Calculations Test');
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

  const shopDomain = (connection.meta as any)?.shop || (connection.meta as any)?.store_domain || (connection.meta as any)?.shopDomain;
  if (!shopDomain) {
    throw new Error('No shop domain found in connection');
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

  console.log(`   Fetched ${graphqlOrders.length} orders\n`);

  if (graphqlOrders.length === 0) {
    console.log('⚠️  No orders found in date range. Exiting.\n');
    return;
  }

  // Filter out test orders
  const validOrders = graphqlOrders.filter((o) => !o.test);
  console.log(`   Valid orders (non-test): ${validOrders.length}\n`);

  // Build orderCustomerMap using all-time logic
  const orderCustomerMap = new Map<string, boolean>();
  for (const order of validOrders) {
    const orderId = (order.legacyResourceId || order.id).toString();
    if (!order.customer) {
      orderCustomerMap.set(orderId, false); // Guest checkout
    } else {
      const numberOfOrders = parseInt(order.customer.numberOfOrders || '0', 10);
      orderCustomerMap.set(orderId, numberOfOrders === 1);
    }
  }

  // Calculate totals and breakdowns
  console.log('📊 Calculating metrics...\n');

  const countryBreakdown = new Map<string, CountryBreakdown>();
  const customerTypeBreakdown: CustomerTypeBreakdown[] = [
    { type: 'new', orders: 0, grossSales: 0, discounts: 0, returns: 0, netSales: 0, tax: 0 },
    { type: 'returning', orders: 0, grossSales: 0, discounts: 0, returns: 0, netSales: 0, tax: 0 },
    { type: 'guest', orders: 0, grossSales: 0, discounts: 0, returns: 0, netSales: 0, tax: 0 },
  ];

  let totalGrossSales = 0;
  let totalDiscounts = 0;
  let totalReturns = 0;
  let totalNetSales = 0;
  let totalTax = 0;
  let totalNewCustomerNetSales = 0;
  let totalReturningCustomerNetSales = 0;
  let totalOrders = 0;
  let totalNewCustomerOrders = 0;
  let totalReturningCustomerOrders = 0;

  for (const order of validOrders) {
    const orderId = (order.legacyResourceId || order.id).toString();
    const isNewCustomer = orderCustomerMap.get(orderId) || false;
    const isGuest = !order.customer;

    const metrics = calculateOrderMetrics(order, isNewCustomer);
    const country = extractCountry(order);

    // Update country breakdown
    const countryData = countryBreakdown.get(country) || {
      country,
      orders: 0,
      grossSales: 0,
      discounts: 0,
      returns: 0,
      netSales: 0,
      tax: 0,
      newCustomerNetSales: 0,
      newCustomerOrders: 0,
      returningCustomerNetSales: 0,
      returningCustomerOrders: 0,
    };

    countryData.orders += 1;
    countryData.grossSales += metrics.grossSales;
    countryData.discounts += metrics.discounts;
    countryData.returns += metrics.returns;
    countryData.netSales += metrics.netSales;
    countryData.tax += metrics.tax;

    if (isNewCustomer && !isGuest) {
      countryData.newCustomerNetSales += metrics.netSales;
      countryData.newCustomerOrders += 1;
    } else if (!isGuest) {
      countryData.returningCustomerNetSales += metrics.netSales;
      countryData.returningCustomerOrders += 1;
    }

    countryBreakdown.set(country, countryData);

    // Update customer type breakdown
    let customerType: 'new' | 'returning' | 'guest';
    if (isGuest) {
      customerType = 'guest';
    } else if (isNewCustomer) {
      customerType = 'new';
    } else {
      customerType = 'returning';
    }

    const typeData = customerTypeBreakdown.find((t) => t.type === customerType)!;
    typeData.orders += 1;
    typeData.grossSales += metrics.grossSales;
    typeData.discounts += metrics.discounts;
    typeData.returns += metrics.returns;
    typeData.netSales += metrics.netSales;
    typeData.tax += metrics.tax;

    // Update totals
    totalOrders += 1;
    totalGrossSales += metrics.grossSales;
    totalDiscounts += metrics.discounts;
    totalReturns += metrics.returns;
    totalNetSales += metrics.netSales;
    totalTax += metrics.tax;

    if (isNewCustomer && !isGuest) {
      totalNewCustomerNetSales += metrics.netSales;
      totalNewCustomerOrders += 1;
    } else if (!isGuest) {
      totalReturningCustomerNetSales += metrics.netSales;
      totalReturningCustomerOrders += 1;
    }
  }

  // Get data from database for comparison
  console.log('📥 Fetching data from database for comparison...\n');
  
  const { data: dailySalesData } = await supabase
    .from('shopify_daily_sales')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('mode', 'shopify')
    .gte('date', fromDate)
    .lte('date', toDate)
    .order('date');

  const { data: orderData } = await supabase
    .from('shopify_orders')
    .select('*')
    .eq('tenant_id', tenantId)
    .gte('processed_at', fromDate)
    .lte('processed_at', toDate);

  // Calculate database totals
  let dbTotalGrossSales = 0;
  let dbTotalNetSales = 0;
  let dbTotalNewCustomerNetSales = 0;
  let dbTotalDiscounts = 0;
  let dbTotalReturns = 0;
  let dbTotalTax = 0;
  let dbTotalOrders = 0;
  let dbTotalNewCustomerOrders = 0;

  if (dailySalesData) {
    for (const row of dailySalesData) {
      dbTotalGrossSales += row.gross_sales_excl_tax || 0;
      dbTotalNetSales += row.net_sales_excl_tax || 0;
      dbTotalNewCustomerNetSales += row.new_customer_net_sales || 0;
      dbTotalDiscounts += row.discounts_excl_tax || 0;
      dbTotalReturns += Math.abs(row.refunds_excl_tax || 0);
    }
  }

  if (orderData) {
    dbTotalOrders = orderData.length;
    dbTotalTax = orderData.reduce((sum, o) => sum + (parseFloat((o.total_tax || 0).toString()) || 0), 0);
    dbTotalNewCustomerOrders = orderData.filter((o) => o.is_new_customer === true).length;
  }

  // Format currency (assuming SEK)
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('sv-SE', {
      style: 'currency',
      currency: 'SEK',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const formatPercent = (value: number, total: number) => {
    if (total === 0) return '0.00%';
    return ((value / total) * 100).toFixed(2) + '%';
  };

  // Print results
  console.log('═══════════════════════════════════════════════════════');
  console.log('  TOTALS SUMMARY');
  console.log('═══════════════════════════════════════════════════════\n');

  console.log('📊 CALCULATED FROM GRAPHQL:');
  console.log(`   Total Orders:           ${totalOrders.toLocaleString()}`);
  console.log(`   Gross Sales:            ${formatCurrency(totalGrossSales)}`);
  console.log(`   Discounts:              ${formatCurrency(totalDiscounts)}`);
  console.log(`   Returns:                ${formatCurrency(totalReturns)}`);
  console.log(`   Tax:                    ${formatCurrency(totalTax)}`);
  console.log(`   Net Sales:              ${formatCurrency(totalNetSales)}`);
  console.log(`   New Customer Net Sales: ${formatCurrency(totalNewCustomerNetSales)} (${formatPercent(totalNewCustomerNetSales, totalNetSales)})`);
  console.log(`   New Customer Orders:    ${totalNewCustomerOrders.toLocaleString()}`);
  console.log(`   Returning Customer Net: ${formatCurrency(totalReturningCustomerNetSales)}`);
  console.log(`   Returning Orders:       ${totalReturningCustomerOrders.toLocaleString()}`);

  console.log('\n💾 FROM DATABASE:');
  console.log(`   Total Orders:           ${dbTotalOrders.toLocaleString()}`);
  console.log(`   Gross Sales:            ${formatCurrency(dbTotalGrossSales)}`);
  console.log(`   Discounts:              ${formatCurrency(dbTotalDiscounts)}`);
  console.log(`   Returns:                ${formatCurrency(dbTotalReturns)}`);
  console.log(`   Tax:                    ${formatCurrency(dbTotalTax)}`);
  console.log(`   Net Sales:              ${formatCurrency(dbTotalNetSales)}`);
  console.log(`   New Customer Net Sales: ${formatCurrency(dbTotalNewCustomerNetSales)} (${formatPercent(dbTotalNewCustomerNetSales, dbTotalNetSales)})`);
  console.log(`   New Customer Orders:    ${dbTotalNewCustomerOrders.toLocaleString()}`);

  console.log('\n🔍 DIFFERENCES:');
  const netSalesDiff = totalNetSales - dbTotalNetSales;
  const grossSalesDiff = totalGrossSales - dbTotalGrossSales;
  const discountsDiff = totalDiscounts - dbTotalDiscounts;
  const returnsDiff = totalReturns - dbTotalReturns;
  const taxDiff = totalTax - dbTotalTax;
  const newCustomerNetSalesDiff = totalNewCustomerNetSales - dbTotalNewCustomerNetSales;
  const ordersDiff = totalOrders - dbTotalOrders;

  console.log(`   Orders:                 ${ordersDiff > 0 ? '+' : ''}${ordersDiff.toLocaleString()}`);
  console.log(`   Gross Sales:            ${netSalesDiff > 0 ? '+' : ''}${formatCurrency(grossSalesDiff)}`);
  console.log(`   Discounts:              ${discountsDiff > 0 ? '+' : ''}${formatCurrency(discountsDiff)}`);
  console.log(`   Returns:                ${returnsDiff > 0 ? '+' : ''}${formatCurrency(returnsDiff)}`);
  console.log(`   Tax:                    ${taxDiff > 0 ? '+' : ''}${formatCurrency(taxDiff)}`);
  console.log(`   Net Sales:              ${netSalesDiff > 0 ? '+' : ''}${formatCurrency(netSalesDiff)}`);
  console.log(`   New Customer Net Sales: ${newCustomerNetSalesDiff > 0 ? '+' : ''}${formatCurrency(newCustomerNetSalesDiff)}`);

  // Print country breakdown
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  BREAKDOWN BY COUNTRY');
  console.log('═══════════════════════════════════════════════════════\n');

  const sortedCountries = Array.from(countryBreakdown.values())
    .sort((a, b) => b.netSales - a.netSales);

  for (const country of sortedCountries) {
    console.log(`🌍 ${country.country}:`);
    console.log(`   Orders:                 ${country.orders.toLocaleString()}`);
    console.log(`   Gross Sales:            ${formatCurrency(country.grossSales)}`);
    console.log(`   Discounts:              ${formatCurrency(country.discounts)}`);
    console.log(`   Returns:                ${formatCurrency(country.returns)}`);
    console.log(`   Tax:                    ${formatCurrency(country.tax)}`);
    console.log(`   Net Sales:              ${formatCurrency(country.netSales)}`);
    console.log(`   New Customer Net Sales: ${formatCurrency(country.newCustomerNetSales)} (${country.newCustomerOrders} orders)`);
    console.log(`   Returning Net Sales:    ${formatCurrency(country.returningCustomerNetSales)} (${country.returningCustomerOrders} orders)`);
    console.log('');
  }

  // Print customer type breakdown
  console.log('═══════════════════════════════════════════════════════');
  console.log('  BREAKDOWN BY CUSTOMER TYPE');
  console.log('═══════════════════════════════════════════════════════\n');

  for (const type of customerTypeBreakdown) {
    if (type.orders === 0) continue;
    
    const label = type.type === 'new' ? '🆕 New Customers' : type.type === 'returning' ? '🔄 Returning Customers' : '👤 Guest Checkouts';
    console.log(`${label}:`);
    console.log(`   Orders:      ${type.orders.toLocaleString()}`);
    console.log(`   Gross Sales: ${formatCurrency(type.grossSales)}`);
    console.log(`   Discounts:   ${formatCurrency(type.discounts)}`);
    console.log(`   Returns:     ${formatCurrency(type.returns)}`);
    console.log(`   Tax:         ${formatCurrency(type.tax)}`);
    console.log(`   Net Sales:   ${formatCurrency(type.netSales)}`);
    console.log('');
  }

  // Print daily breakdown
  console.log('═══════════════════════════════════════════════════════');
  console.log('  BREAKDOWN BY DATE');
  console.log('═══════════════════════════════════════════════════════\n');

  // Convert GraphQL orders to ShopifyOrderWithTransactions format
  const shopifyOrdersWithTransactions = validOrders.map(convertGraphQLOrderToShopifyOrder);

  // Calculate daily sales
  const dailySales = calculateDailySales(shopifyOrdersWithTransactions, 'shopify', 'Europe/Stockholm', orderCustomerMap);

  for (const day of dailySales.sort((a, b) => a.date.localeCompare(b.date))) {
    const dbDay = dailySalesData?.find((d) => d.date === day.date);
    
    console.log(`📅 ${day.date}:`);
    console.log(`   Orders:                 ${day.ordersCount}`);
    console.log(`   Gross Sales:            ${formatCurrency(day.grossSalesExclTax || 0)}`);
    console.log(`   Discounts:              ${formatCurrency(day.discountsExclTax || 0)}`);
    console.log(`   Returns:                ${formatCurrency(Math.abs(day.refundsExclTax || 0))}`);
    console.log(`   Net Sales:              ${formatCurrency(day.netSalesExclTax)}`);
    console.log(`   New Customer Net Sales: ${formatCurrency(day.newCustomerNetSales || 0)}`);
    
    if (dbDay) {
      const netDiff = day.netSalesExclTax - dbDay.net_sales_excl_tax;
      const newCustomerDiff = (day.newCustomerNetSales || 0) - (dbDay.new_customer_net_sales || 0);
      console.log(`   [DB] Net Sales:         ${formatCurrency(dbDay.net_sales_excl_tax)} (diff: ${formatCurrency(netDiff)})`);
      console.log(`   [DB] New Customer Net:  ${formatCurrency(dbDay.new_customer_net_sales || 0)} (diff: ${formatCurrency(newCustomerDiff)})`);
    }
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  TEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════\n');
}

// Parse arguments
const parser = new ArgumentParser({
  description: 'Test Shopify calculations against Shopify Analytics',
});

parser.add_argument('tenant', { help: 'Tenant slug (e.g., skinome)' });
parser.add_argument('from', { help: 'From date (YYYY-MM-DD)' });
parser.add_argument('to', { help: 'To date (YYYY-MM-DD)' });

const args = parser.parse_args();

testCalculations(args.tenant, args.from, args.to).catch((error) => {
  console.error('\n❌ Error:', error);
  process.exit(1);
});

