#!/usr/bin/env tsx

/**
 * Deep dive investigation into new customer definition
 * Tests multiple definitions including customer.createdAt
 * 
 * Usage:
 *   pnpm tsx scripts/deep_dive_new_customer.ts <tenant-slug> <from-date> <to-date>
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
  
  return subtotalPrice - totalTax - returns;
}

function toLocalDate(dateString: string, timezone: string = 'Europe/Stockholm'): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

function isDateInPeriod(date: Date | null, fromDate: Date, toDate: Date, inclusiveEnd: boolean = true): boolean {
  if (!date) return false;
  if (inclusiveEnd) {
    return date >= fromDate && date <= toDate;
  } else {
    return date >= fromDate && date < toDate;
  }
}

async function deepDiveInvestigation(tenantSlug: string, fromDate: string, toDate: string) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Deep Dive: New Customer Definition Investigation');
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

  // Sort orders by createdAt to analyze chronologically
  const sortedOrders = [...validOrders].sort((a, b) => 
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const fromDateObj = new Date(fromDate + 'T00:00:00');
  const toDateObj = new Date(toDate + 'T23:59:59');

  // Track customers for different definitions
  const customersAllTime = new Map<string, { firstOrderDate: string; numberOfOrders: number }>();
  const customersInPeriod = new Map<string, string>(); // customer_id -> first order date in period
  const customerCreatedDates = new Map<string, string>(); // customer_id -> createdAt
  
  // First pass: collect all customer info
  for (const order of sortedOrders) {
    if (!order.customer) continue;
    
    const customerId = order.customer.id;
    const numberOfOrders = parseInt(order.customer.numberOfOrders || '0', 10);
    const customerCreatedAt = order.customer.createdAt;
    
    if (customerCreatedAt) {
      customerCreatedDates.set(customerId, customerCreatedAt);
    }
    
    if (!customersAllTime.has(customerId)) {
      customersAllTime.set(customerId, {
        firstOrderDate: order.createdAt,
        numberOfOrders,
      });
    }
    
    if (!customersInPeriod.has(customerId)) {
      customersInPeriod.set(customerId, order.createdAt);
    }
  }

  console.log(`   Found ${customersAllTime.size} unique customers`);
  console.log(`   Found ${customerCreatedDates.size} customers with createdAt date\n`);

  // Define different definitions
  type Definition = {
    name: string;
    newCount: number;
    newNetSales: number;
    returningCount: number;
    returningNetSales: number;
    description: string;
  };

  const definitions: Definition[] = [
    {
      name: 'Def 1: All-time first order (numberOfOrders === 1)',
      newCount: 0,
      newNetSales: 0,
      returningCount: 0,
      returningNetSales: 0,
      description: 'Customer has exactly 1 order ever',
    },
    {
      name: 'Def 2: First order in reporting period',
      newCount: 0,
      newNetSales: 0,
      returningCount: 0,
      returningNetSales: 0,
      description: 'First time this customer ordered in this period',
    },
    {
      name: 'Def 3: Customer created in period',
      newCount: 0,
      newNetSales: 0,
      returningCount: 0,
      returningNetSales: 0,
      description: 'Customer.createdAt is within reporting period',
    },
    {
      name: 'Def 4: First order ever in period',
      newCount: 0,
      newNetSales: 0,
      returningCount: 0,
      returningNetSales: 0,
      description: 'Customer\'s first order ever (all-time) occurred in this period',
    },
    {
      name: 'Def 5: Customer created before/within AND first order in period',
      newCount: 0,
      newNetSales: 0,
      returningCount: 0,
      returningNetSales: 0,
      description: 'Customer created before or within period AND this is their first order in period',
    },
    {
      name: 'Def 6: Customer created in period OR (numberOfOrders === 1)',
      newCount: 0,
      newNetSales: 0,
      returningCount: 0,
      returningNetSales: 0,
      description: 'Customer created in period OR has numberOfOrders === 1',
    },
    {
      name: 'Def 7: Customer created in period AND first order in period',
      newCount: 0,
      newNetSales: 0,
      returningCount: 0,
      returningNetSales: 0,
      description: 'Customer created in period AND this is their first order in period',
    },
    {
      name: 'Def 8: Customer created in period OR (numberOfOrders === 1 AND first order in period)',
      newCount: 0,
      newNetSales: 0,
      returningCount: 0,
      returningNetSales: 0,
      description: 'Customer created in period OR (has 1 order ever AND first order in period)',
    },
  ];

  // Calculate for each definition
  for (const order of validOrders) {
    if (!order.customer) continue;
    
    const customerId = order.customer.id;
    const numberOfOrders = parseInt(order.customer.numberOfOrders || '0', 10);
    const orderDate = new Date(order.createdAt);
    const netSales = calculateOrderNetSales(order);
    
    const customerCreatedAt = customerCreatedDates.get(customerId);
    const customerCreatedDate = customerCreatedAt ? new Date(customerCreatedAt) : null;
    const firstOrderInPeriod = customersInPeriod.get(customerId);
    const isFirstOrderInPeriod = firstOrderInPeriod === order.createdAt;
    const allTimeInfo = customersAllTime.get(customerId);
    const firstOrderEverDate = allTimeInfo ? new Date(allTimeInfo.firstOrderDate) : null;
    const isFirstOrderEverInPeriod = firstOrderEverDate && 
      firstOrderEverDate >= fromDateObj && firstOrderEverDate <= toDateObj;
    
    // Def 1: numberOfOrders === 1
    if (numberOfOrders === 1) {
      definitions[0].newCount++;
      definitions[0].newNetSales += netSales;
    } else {
      definitions[0].returningCount++;
      definitions[0].returningNetSales += netSales;
    }
    
    // Def 2: First order in period
    if (isFirstOrderInPeriod) {
      definitions[1].newCount++;
      definitions[1].newNetSales += netSales;
    } else {
      definitions[1].returningCount++;
      definitions[1].returningNetSales += netSales;
    }
    
    // Def 3: Customer created in period
    if (customerCreatedDate && customerCreatedDate >= fromDateObj && customerCreatedDate <= toDateObj) {
      definitions[2].newCount++;
      definitions[2].newNetSales += netSales;
    } else if (customerCreatedDate) {
      definitions[2].returningCount++;
      definitions[2].returningNetSales += netSales;
    } else {
      // No createdAt - treat as returning (or skip)
      definitions[2].returningCount++;
      definitions[2].returningNetSales += netSales;
    }
    
    // Def 4: First order ever in period (customer's very first order occurred in this period)
    if (isFirstOrderEverInPeriod && orderDate >= fromDateObj && orderDate <= toDateObj) {
      definitions[3].newCount++;
      definitions[3].newNetSales += netSales;
    } else {
      definitions[3].returningCount++;
      definitions[3].returningNetSales += netSales;
    }
    
    // Def 5: Customer created before/within period AND first order in period
    if (customerCreatedDate && customerCreatedDate <= toDateObj && isFirstOrderInPeriod) {
      definitions[4].newCount++;
      definitions[4].newNetSales += netSales;
    } else {
      definitions[4].returningCount++;
      definitions[4].returningNetSales += netSales;
    }
    
    // Def 6: Customer created in period OR numberOfOrders === 1
    const customerCreatedInPeriod = isDateInPeriod(customerCreatedDate, fromDateObj, toDateObj);
    if (customerCreatedInPeriod || numberOfOrders === 1) {
      definitions[5].newCount++;
      definitions[5].newNetSales += netSales;
    } else {
      definitions[5].returningCount++;
      definitions[5].returningNetSales += netSales;
    }
    
    // Def 7: Customer created in period AND first order in period
    if (customerCreatedInPeriod && isFirstOrderInPeriod) {
      definitions[6].newCount++;
      definitions[6].newNetSales += netSales;
    } else {
      definitions[6].returningCount++;
      definitions[6].returningNetSales += netSales;
    }
    
    // Def 8: Customer created in period OR (numberOfOrders === 1 AND first order in period)
    if (customerCreatedInPeriod || (numberOfOrders === 1 && isFirstOrderInPeriod)) {
      definitions[7].newCount++;
      definitions[7].newNetSales += netSales;
    } else {
      definitions[7].returningCount++;
      definitions[7].returningNetSales += netSales;
    }
  }

  // Also check for cancelled orders and other filters
  let cancelledOrders = 0;
  let cancelledNetSales = 0;
  let cancelledNewCustomers = 0;
  let cancelledNewNetSales = 0;

  for (const order of validOrders) {
    if (order.cancelledAt) {
      cancelledOrders++;
      const netSales = calculateOrderNetSales(order);
      cancelledNetSales += netSales;
      
      // Check if this cancelled order would be "new customer" under Def 6
      if (!order.customer) continue;
      const customerCreatedDate = customerCreatedDates.get(order.customer.id);
      const customerCreatedInPeriod = customerCreatedDate && 
        new Date(customerCreatedDate) >= fromDateObj && 
        new Date(customerCreatedDate) <= toDateObj;
      const numberOfOrders = parseInt(order.customer.numberOfOrders || '0', 10);
      
      if (customerCreatedInPeriod || numberOfOrders === 1) {
        cancelledNewCustomers++;
        cancelledNewNetSales += netSales;
      }
    }
  }
  
  // Test Def 6 without cancelled orders
  let def6NoCancelled = {
    newCount: 0,
    newNetSales: 0,
    returningCount: 0,
    returningNetSales: 0,
  };
  
  for (const order of validOrders) {
    if (!order.customer || order.cancelledAt) continue;
    
    const customerId = order.customer.id;
    const numberOfOrders = parseInt(order.customer.numberOfOrders || '0', 10);
    const customerCreatedDate = customerCreatedDates.get(customerId);
    const customerCreatedInPeriod = customerCreatedDate && 
      new Date(customerCreatedDate) >= fromDateObj && 
      new Date(customerCreatedDate) <= toDateObj;
    const netSales = calculateOrderNetSales(order);
    
    if (customerCreatedInPeriod || numberOfOrders === 1) {
      def6NoCancelled.newCount++;
      def6NoCancelled.newNetSales += netSales;
    } else {
      def6NoCancelled.returningCount++;
      def6NoCancelled.returningNetSales += netSales;
    }
  }

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('sv-SE', {
      style: 'currency',
      currency: 'SEK',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  // Expected values from Shopify Analytics
  const expectedNewNet = 225014.23;
  const expectedReturningNet = 436826.61;
  const expectedTotalNet = 661840.84;
  const expectedNewCount = 230;

  console.log('═══════════════════════════════════════════════════════');
  console.log('  TESTING DIFFERENT DEFINITIONS');
  console.log('═══════════════════════════════════════════════════════\n');

  for (const def of definitions) {
    const newDiff = Math.abs(def.newNetSales - expectedNewNet);
    const returningDiff = Math.abs(def.returningNetSales - expectedReturningNet);
    const totalDiff = Math.abs((def.newNetSales + def.returningNetSales) - expectedTotalNet);
    const countDiff = Math.abs(def.newCount - expectedNewCount);
    
    const newDiffPercent = ((newDiff / expectedNewNet) * 100).toFixed(2);
    const countDiffPercent = ((countDiff / expectedNewCount) * 100).toFixed(2);
    
    console.log(`📊 ${def.name}:`);
    console.log(`   Description: ${def.description}`);
    console.log(`   New Customers: ${def.newCount} (diff: ${countDiff > 0 ? '+' : ''}${countDiff}, ${countDiffPercent}%)`);
    console.log(`   New Net Sales: ${formatCurrency(def.newNetSales)} (diff: ${formatCurrency(newDiff)}, ${newDiffPercent}%)`);
    console.log(`   Returning Net Sales: ${formatCurrency(def.returningNetSales)} (diff: ${formatCurrency(returningDiff)})`);
    console.log(`   Total Net Sales: ${formatCurrency(def.newNetSales + def.returningNetSales)} (diff: ${formatCurrency(totalDiff)})`);
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  ORDER TYPE ANALYSIS');
  console.log('═══════════════════════════════════════════════════════\n');
  
  console.log(`Cancelled orders: ${cancelledOrders}`);
  console.log(`Cancelled net sales: ${formatCurrency(cancelledNetSales)}`);
  console.log(`Cancelled "new customer" orders: ${cancelledNewCustomers}`);
  console.log(`Cancelled "new customer" net sales: ${formatCurrency(cancelledNewNetSales)}`);
  
  console.log('\n📊 Def 6 WITHOUT cancelled orders:');
  console.log(`   New Customers: ${def6NoCancelled.newCount} (expected: ${expectedNewCount})`);
  console.log(`   New Net Sales: ${formatCurrency(def6NoCancelled.newNetSales)} (expected: ${formatCurrency(expectedNewNet)})`);
  console.log(`   Difference: ${formatCurrency(Math.abs(def6NoCancelled.newNetSales - expectedNewNet))}`);
  
  // Check for potential timezone issues
  console.log('\n🌍 Timezone Analysis:');
  console.log(`   Using timezone: Europe/Stockholm`);
  console.log(`   Period: ${fromDate} to ${toDate}`);
  
  // Check edge cases - customers created on boundary dates
  let customersCreatedOnBoundary = 0;
  let customersCreatedBeforePeriod = 0;
  let customersCreatedAfterPeriod = 0;
  
  for (const [customerId, createdAt] of customerCreatedDates.entries()) {
    const createdDate = new Date(createdAt);
    if (createdDate.toISOString().split('T')[0] === fromDate || createdDate.toISOString().split('T')[0] === toDate) {
      customersCreatedOnBoundary++;
    } else if (createdDate < fromDateObj) {
      customersCreatedBeforePeriod++;
    } else if (createdDate > toDateObj) {
      customersCreatedAfterPeriod++;
    }
  }
  
  console.log(`   Customers created on boundary dates: ${customersCreatedOnBoundary}`);
  console.log(`   Customers created before period: ${customersCreatedBeforePeriod}`);
  console.log(`   Customers created after period: ${customersCreatedAfterPeriod}`);

  // Find best match
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  BEST MATCH ANALYSIS');
  console.log('═══════════════════════════════════════════════════════\n');

  let bestMatch = definitions[0];
  let bestScore = Infinity;

  for (const def of definitions) {
    // Score based on combined difference (weight count and net sales equally)
    const newNetDiff = Math.abs(def.newNetSales - expectedNewNet);
    const countDiff = Math.abs(def.newCount - expectedNewCount);
    // Normalize differences (as percentages) and combine
    const normalizedNetDiff = (newNetDiff / expectedNewNet) * 100;
    const normalizedCountDiff = (countDiff / expectedNewCount) * 100;
    const score = normalizedNetDiff + normalizedCountDiff;
    
    if (score < bestScore) {
      bestScore = score;
      bestMatch = def;
    }
  }

  console.log(`🏆 Best Match: ${bestMatch.name}`);
  console.log(`   Score: ${bestScore.toFixed(2)} (lower is better)`);
  console.log(`   New Customers: ${bestMatch.newCount} (expected: ${expectedNewCount})`);
  console.log(`   New Net Sales: ${formatCurrency(bestMatch.newNetSales)} (expected: ${formatCurrency(expectedNewNet)})`);
  console.log(`   Difference: ${formatCurrency(Math.abs(bestMatch.newNetSales - expectedNewNet))}`);
}

const args = process.argv.slice(2);
if (args.length !== 3) {
  console.error('Usage: pnpm tsx scripts/deep_dive_new_customer.ts <tenant-slug> <from-date> <to-date>');
  process.exit(1);
}

deepDiveInvestigation(args[0], args[1], args[2]).catch((error) => {
  console.error('\n❌ Error:', error);
  process.exit(1);
});

