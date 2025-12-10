/**
 * Detailed analysis of missing orders for 2025-11-28
 * Identifies which 2 orders Shopify includes that we exclude
 */

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrdersGraphQL, GraphQLOrder, fetchShopifyOrderGraphQL } from '../lib/integrations/shopify-graphql';

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
} catch (e) {}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const STORE_TIMEZONE = 'Europe/Stockholm';

function toLocalDate(timestamp: string, timezone: string): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

function parseMoneyAmount(amount: string): number {
  return parseFloat(amount);
}

function roundTo2Decimals(num: number): number {
  return parseFloat(num.toFixed(2));
}

/**
 * Our filtering logic - determines if we include an order
 */
function wouldWeIncludeOrder(order: GraphQLOrder, targetDate: string): { include: boolean; reason: string; eventDate?: string } {
  // Exclude cancelled orders
  if (order.cancelledAt) {
    const cancelledDate = toLocalDate(order.cancelledAt, STORE_TIMEZONE);
    return { include: false, reason: `Cancelled order (cancelled_at: ${cancelledDate})` };
  }

  // Filter for successful transactions
  const successfulTransactions = (order.transactions || []).filter(
    (txn) =>
      (txn.kind === 'SALE' || txn.kind === 'CAPTURE') &&
      txn.status === 'SUCCESS' &&
      txn.processedAt,
  );

  if (successfulTransactions.length === 0) {
    // Check what transactions exist
    const transactionKinds = (order.transactions || []).map(t => `${t.kind}/${t.status}`).join(', ');
    return { 
      include: false, 
      reason: `No successful transactions (transactions: ${transactionKinds || 'none'})` 
    };
  }

  // Use transaction.processedAt for event date
  const transactionTimestamp = successfulTransactions[0].processedAt!;
  const eventDate = toLocalDate(transactionTimestamp, STORE_TIMEZONE);

  if (eventDate !== targetDate) {
    return { include: false, reason: `Event date ${eventDate} != target date ${targetDate}`, eventDate };
  }

  return { include: true, reason: 'Included', eventDate };
}

/**
 * Calculate Net Sales for an order
 */
function calculateNetSales(order: GraphQLOrder): {
  subtotalPriceSet: number;
  totalTaxSet: number;
  netSalesExclTaxBeforeRefunds: number;
  refunds: number;
  netSalesExclTaxAfterRefunds: number;
} {
  const subtotalPrice = order.subtotalPriceSet
    ? parseMoneyAmount(order.subtotalPriceSet.shopMoney.amount)
    : 0;
  
  const totalTax = order.totalTaxSet
    ? parseMoneyAmount(order.totalTaxSet.shopMoney.amount)
    : 0;
  
  const netSalesExclTaxBeforeRefunds = roundTo2Decimals(subtotalPrice - totalTax);
  
  // Calculate returns EXCL tax
  let refunds = 0;
  for (const refund of order.refunds) {
    for (const refundLineItemEdge of refund.refundLineItems.edges) {
      const refundLineItem = refundLineItemEdge.node;
      if (refundLineItem.subtotalSet) {
        refunds += parseMoneyAmount(refundLineItem.subtotalSet.shopMoney.amount);
      } else if (refundLineItem.lineItem?.originalUnitPriceSet) {
        // Fallback
        const originalPrice = parseMoneyAmount(refundLineItem.lineItem.originalUnitPriceSet.shopMoney.amount);
        refunds += originalPrice * refundLineItem.quantity;
      }
    }
  }
  refunds = roundTo2Decimals(refunds);
  
  const netSalesExclTaxAfterRefunds = roundTo2Decimals(netSalesExclTaxBeforeRefunds - refunds);
  
  return {
    subtotalPriceSet: subtotalPrice,
    totalTaxSet: totalTax,
    netSalesExclTaxBeforeRefunds,
    refunds,
    netSalesExclTaxAfterRefunds,
  };
}

async function main() {
  const tenantSlug = 'skinome';
  const targetDate = '2025-11-28';
  
  console.log('='.repeat(80));
  console.log('Analysis of Missing Orders for 2025-11-28');
  console.log('='.repeat(80));
  console.log('');
  
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', tenantSlug)
    .maybeSingle();
  
  const { data: connection } = await supabase
    .from('connections')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('source', 'shopify')
    .maybeSingle();
  
  const shopDomain = connection.meta?.store_domain || connection.meta?.shop;
  
  // Fetch all orders in date range
  const startDateObj = new Date(targetDate + 'T00:00:00Z');
  const endDateObj = new Date(targetDate + 'T23:59:59Z');
  
  const fetchStartDate = new Date(startDateObj);
  fetchStartDate.setDate(fetchStartDate.getDate() - 1);
  const fetchEndDate = new Date(endDateObj);
  fetchEndDate.setDate(fetchEndDate.getDate() + 1);
  
  const fetchStartDateStr = fetchStartDate.toISOString().slice(0, 10);
  const fetchEndDateStr = fetchEndDate.toISOString().slice(0, 10);
  
  console.log(`Fetching orders from ${fetchStartDateStr} to ${fetchEndDateStr}...`);
  const orders = await fetchShopifyOrdersGraphQL({
    tenantId: tenant.id,
    shopDomain,
    since: fetchStartDateStr,
    until: fetchEndDateStr,
    excludeTest: true,
  });
  
  console.log(`✅ Fetched ${orders.length} total orders\n`);
  
  // Group orders by different date criteria
  const ordersByCreatedAt = new Map<string, GraphQLOrder[]>();
  const ordersByProcessedAt = new Map<string, GraphQLOrder[]>();
  const ordersByTransactionProcessedAt = new Map<string, GraphQLOrder[]>();
  
  for (const order of orders) {
    const createdDate = toLocalDate(order.createdAt, STORE_TIMEZONE);
    if (!ordersByCreatedAt.has(createdDate)) {
      ordersByCreatedAt.set(createdDate, []);
    }
    ordersByCreatedAt.get(createdDate)!.push(order);
    
    if (order.processedAt) {
      const processedDate = toLocalDate(order.processedAt, STORE_TIMEZONE);
      if (!ordersByProcessedAt.has(processedDate)) {
        ordersByProcessedAt.set(processedDate, []);
      }
      ordersByProcessedAt.get(processedDate)!.push(order);
    }
    
    // Our method: transaction.processedAt
    const successfulTransactions = (order.transactions || []).filter(
      (txn) =>
        (txn.kind === 'SALE' || txn.kind === 'CAPTURE') &&
        txn.status === 'SUCCESS' &&
        txn.processedAt,
    );
    
    if (successfulTransactions.length > 0 && !order.cancelledAt) {
      const transactionDate = toLocalDate(successfulTransactions[0].processedAt!, STORE_TIMEZONE);
      if (!ordersByTransactionProcessedAt.has(transactionDate)) {
        ordersByTransactionProcessedAt.set(transactionDate, []);
      }
      ordersByTransactionProcessedAt.get(transactionDate)!.push(order);
    }
  }
  
  console.log('📊 Orders grouped by different date criteria:');
  console.log(`  By order.createdAt (${targetDate}): ${ordersByCreatedAt.get(targetDate)?.length || 0}`);
  console.log(`  By order.processedAt (${targetDate}): ${ordersByProcessedAt.get(targetDate)?.length || 0}`);
  console.log(`  By transaction.processedAt (${targetDate}) - OUR METHOD: ${ordersByTransactionProcessedAt.get(targetDate)?.length || 0}`);
  console.log('');
  
  // Shopify supposedly has 143 orders - let's see what date grouping gives us 143
  console.log('🔍 Shopify reports 143 orders. Checking which date grouping matches...');
  
  // Check orders created on target date
  const createdOnDate = ordersByCreatedAt.get(targetDate) || [];
  console.log(`  Created on ${targetDate}: ${createdOnDate.length} orders`);
  
  // Check orders processed on target date
  const processedOnDate = ordersByProcessedAt.get(targetDate) || [];
  console.log(`  Processed on ${targetDate}: ${processedOnDate.length} orders`);
  
  // Our included orders
  const ourIncludedOrders = ordersByTransactionProcessedAt.get(targetDate) || [];
  console.log(`  Our method (transaction.processedAt): ${ourIncludedOrders.length} orders`);
  console.log('');
  
  // Find orders that are in Shopify's count but not ours
  // Shopify likely uses order.createdAt or order.processedAt
  const shopifyOrdersByCreatedAt = new Set(createdOnDate.map(o => o.id));
  const shopifyOrdersByProcessedAt = new Set(processedOnDate.map(o => o.id));
  const ourOrders = new Set(ourIncludedOrders.map(o => o.id));
  
  // Orders in createdAt but not in our method
  const inCreatedAtNotOurs = createdOnDate.filter(o => !ourOrders.has(o.id));
  // Orders in processedAt but not in our method
  const inProcessedAtNotOurs = processedOnDate.filter(o => !ourOrders.has(o.id));
  
  console.log('🔍 Orders that Shopify might include but we exclude:');
  console.log(`  In order.createdAt but not ours: ${inCreatedAtNotOurs.length}`);
  console.log(`  In order.processedAt but not ours: ${inProcessedAtNotOurs.length}`);
  console.log('');
  
  // Analyze the differences
  console.log('='.repeat(80));
  console.log('DETAILED ANALYSIS OF MISSING ORDERS');
  console.log('='.repeat(80));
  console.log('');
  
  // Check both groups and take the ones that would give us 143 total
  const candidateOrders = [...new Set([...inCreatedAtNotOurs, ...inProcessedAtNotOurs])];
  
  console.log(`Found ${candidateOrders.length} candidate orders that Shopify might include`);
  console.log('');
  
  // We need exactly 2 more orders to reach 143
  // Let's check which grouping gives us 143
  if (createdOnDate.length === 143) {
    console.log('✅ order.createdAt matches Shopify count (143 orders)');
    console.log('');
    
    // Analyze the 2 missing orders
    const missingOrders = inCreatedAtNotOurs.slice(0, 2);
    
    for (let i = 0; i < missingOrders.length; i++) {
      const order = missingOrders[i];
      const inclusion = wouldWeIncludeOrder(order, targetDate);
      const netSales = calculateNetSales(order);
      
      console.log('─'.repeat(80));
      console.log(`Order ${i + 1}: ${order.name} (ID: ${order.legacyResourceId || order.id})`);
      console.log('─'.repeat(80));
      console.log('');
      console.log('📋 Order Details:');
      console.log(`  Order Name: ${order.name}`);
      console.log(`  Order ID: ${order.id}`);
      console.log(`  Legacy Resource ID: ${order.legacyResourceId || 'N/A'}`);
      console.log(`  Created At: ${order.createdAt} (${toLocalDate(order.createdAt, STORE_TIMEZONE)})`);
      console.log(`  Processed At: ${order.processedAt || 'N/A'} (${order.processedAt ? toLocalDate(order.processedAt, STORE_TIMEZONE) : 'N/A'})`);
      console.log(`  Cancelled At: ${order.cancelledAt || 'N/A'} (${order.cancelledAt ? toLocalDate(order.cancelledAt, STORE_TIMEZONE) : 'N/A'})`);
      console.log(`  Test Order: ${order.test}`);
      console.log('');
      
      console.log('💳 Transactions:');
      if (order.transactions && order.transactions.length > 0) {
        for (const txn of order.transactions) {
          console.log(`  - ${txn.kind} / ${txn.status} / ${txn.processedAt || 'N/A'}`);
          if (txn.amountSet) {
            console.log(`    Amount: ${txn.amountSet.shopMoney.amount} ${txn.amountSet.shopMoney.currencyCode}`);
          }
        }
      } else {
        console.log('  No transactions');
      }
      console.log('');
      
      console.log('❌ Why we exclude:');
      console.log(`  ${inclusion.reason}`);
      if (inclusion.eventDate) {
        console.log(`  Event Date (from transaction): ${inclusion.eventDate}`);
      }
      console.log('');
      
      console.log('💰 Net Sales Calculation:');
      console.log(`  subtotalPriceSet: ${netSales.subtotalPriceSet.toFixed(2)} ${order.currencyCode}`);
      console.log(`  totalTaxSet: ${netSales.totalTaxSet.toFixed(2)} ${order.currencyCode}`);
      console.log(`  Net Sales (EXCL tax, BEFORE refunds): ${netSales.netSalesExclTaxBeforeRefunds.toFixed(2)} ${order.currencyCode}`);
      console.log(`  Refunds (EXCL tax): ${netSales.refunds.toFixed(2)} ${order.currencyCode}`);
      console.log(`  Net Sales (EXCL tax, AFTER refunds): ${netSales.netSalesExclTaxAfterRefunds.toFixed(2)} ${order.currencyCode}`);
      console.log('');
      
      console.log('🔍 Additional Checks:');
      console.log(`  Has refunds: ${order.refunds.length > 0 ? 'Yes' : 'No'}`);
      if (order.refunds.length > 0) {
        console.log(`  Number of refunds: ${order.refunds.length}`);
        for (const refund of order.refunds) {
          console.log(`    Refund ${refund.id}: created_at=${refund.createdAt}`);
        }
      }
      console.log('');
    }
    
    // Summary
    console.log('='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log('');
    console.log('Shopify uses: order.createdAt for date grouping');
    console.log(`Shopify includes: ${createdOnDate.length} orders`);
    console.log(`We include: ${ourIncludedOrders.length} orders (using transaction.processedAt)`);
    console.log(`Missing: ${createdOnDate.length - ourIncludedOrders.length} orders`);
    console.log('');
    
    // Calculate total Net Sales impact
    let totalNetSalesImpact = 0;
    for (const order of missingOrders) {
      const netSales = calculateNetSales(order);
      totalNetSalesImpact += netSales.netSalesExclTaxAfterRefunds;
    }
    
    console.log('Net Sales Impact of Missing Orders:');
    console.log(`  Total Net Sales from missing orders: ${totalNetSalesImpact.toFixed(2)} SEK`);
    console.log(`  Expected Shopify total: 111,773.01 SEK`);
    console.log(`  Our total: 112,670.70 SEK`);
    console.log(`  Difference: ${(112670.70 - 111773.01).toFixed(2)} SEK`);
    console.log(`  If we subtract missing orders: ${(112670.70 - totalNetSalesImpact).toFixed(2)} SEK`);
    console.log('');
    
  } else if (processedOnDate.length === 143) {
    console.log('✅ order.processedAt matches Shopify count (143 orders)');
    const missingOrders = inProcessedAtNotOurs.slice(0, 2);
    // Similar analysis...
  } else {
    console.log('⚠️  Neither createdAt nor processedAt gives exactly 143 orders');
    console.log(`  Created: ${createdOnDate.length}`);
    console.log(`  Processed: ${processedOnDate.length}`);
  }
}

main().catch(console.error);



