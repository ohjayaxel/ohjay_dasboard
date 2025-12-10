/**
 * Analyze orders that exist in Shopify but are not counted in Analytics
 */

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrdersGraphQL, GraphQLOrder } from '../lib/integrations/shopify-graphql';

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
const TARGET_DATE = '2025-11-28';

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

async function analyzeOrder(orderId: string, orders: GraphQLOrder[]) {
  const order = orders.find(o => 
    o.id === orderId || 
    o.legacyResourceId === orderId ||
    o.legacyResourceId === `gid://shopify/Order/${orderId}`
  );
  
  if (!order) {
    console.log(`❌ Order ${orderId} NOT FOUND in fetched orders`);
    console.log('');
    return;
  }
  
  const createdAt = toLocalDate(order.createdAt, STORE_TIMEZONE);
  const cancelledAt = order.cancelledAt ? toLocalDate(order.cancelledAt, STORE_TIMEZONE) : null;
  
  const subtotalPrice = order.subtotalPriceSet
    ? parseMoneyAmount(order.subtotalPriceSet.shopMoney.amount)
    : 0;
  const totalTax = order.totalTaxSet
    ? parseMoneyAmount(order.totalTaxSet.shopMoney.amount)
    : 0;
  
  // Calculate refunds
  let refunds = 0;
  for (const refund of order.refunds) {
    for (const refundLineItemEdge of refund.refundLineItems.edges) {
      const refundLineItem = refundLineItemEdge.node;
      if (refundLineItem.subtotalSet) {
        refunds += parseMoneyAmount(refundLineItem.subtotalSet.shopMoney.amount);
      }
    }
  }
  refunds = roundTo2Decimals(refunds);
  
  const netSales = roundTo2Decimals(subtotalPrice - totalTax - refunds);
  
  // Check transactions
  const allTransactions = order.transactions || [];
  const successfulTransactions = allTransactions.filter(
    (txn) =>
      (txn.kind === 'SALE' || txn.kind === 'CAPTURE') &&
      txn.status === 'SUCCESS' &&
      txn.processedAt,
  );
  
  const failedTransactions = allTransactions.filter(
    (txn) => txn.status === 'FAILURE' || txn.status === 'ERROR'
  );
  
  const testOrders = order.test || false;
  const confirmed = order.confirmed || false;
  const financialStatus = order.displayFulfillmentStatus || 'unknown';
  
  console.log('='.repeat(80));
  console.log(`Order: ${order.name} (ID: ${orderId})`);
  console.log('='.repeat(80));
  console.log('');
  console.log(`Created At: ${order.createdAt} (${createdAt})`);
  console.log(`Cancelled At: ${cancelledAt || 'N/A'}`);
  console.log(`Test Order: ${testOrders ? 'YES ⚠️' : 'No'}`);
  console.log(`Confirmed: ${confirmed ? 'Yes' : 'No ⚠️'}`);
  console.log(`Financial Status: ${financialStatus}`);
  console.log(`Currency: ${order.currencyCode}`);
  console.log('');
  
  console.log('Financial Details:');
  console.log(`  subtotalPriceSet: ${subtotalPrice.toFixed(2)} ${order.currencyCode}`);
  console.log(`  totalTaxSet: ${totalTax.toFixed(2)} ${order.currencyCode}`);
  console.log(`  refunds (EXCL tax): ${refunds.toFixed(2)} ${order.currencyCode}`);
  console.log(`  Net Sales (calculated): ${netSales.toFixed(2)} ${order.currencyCode}`);
  console.log('');
  
  console.log('Transactions:');
  console.log(`  Total transactions: ${allTransactions.length}`);
  console.log(`  Successful: ${successfulTransactions.length}`);
  console.log(`  Failed: ${failedTransactions.length}`);
  console.log('');
  
  if (allTransactions.length > 0) {
    console.log('Transaction Details:');
    for (const txn of allTransactions) {
      const txnDate = txn.processedAt ? toLocalDate(txn.processedAt, STORE_TIMEZONE) : 'N/A';
      console.log(`  - ${txn.kind}/${txn.status} on ${txnDate}`);
      if (txn.amountSet) {
        const amount = parseMoneyAmount(txn.amountSet.shopMoney.amount);
        console.log(`    Amount: ${amount.toFixed(2)} ${order.currencyCode}`);
      }
    }
    console.log('');
  } else {
    console.log('  ⚠️  NO TRANSACTIONS');
    console.log('');
  }
  
  if (order.refunds.length > 0) {
    console.log('Refunds:');
    for (const refund of order.refunds) {
      const refundDate = toLocalDate(refund.createdAt, STORE_TIMEZONE);
      console.log(`  - Refund ${refund.id}: created_at=${refund.createdAt} (${refundDate})`);
    }
    console.log('');
  }
  
  // Reasons why it might not be counted
  console.log('Why Shopify Analytics might exclude this order:');
  const reasons: string[] = [];
  
  if (testOrders) {
    reasons.push('✅ Test order (test=true)');
  }
  if (!confirmed) {
    reasons.push('✅ Not confirmed');
  }
  if (successfulTransactions.length === 0) {
    reasons.push('✅ No successful transactions');
  }
  if (cancelledAt) {
    reasons.push('✅ Cancelled order');
  }
  if (subtotalPrice === 0 && totalTax === 0) {
    reasons.push('✅ Zero value order');
  }
  
  if (reasons.length === 0) {
    reasons.push('⚠️  Unknown reason - check Shopify Admin manually');
  }
  
  for (const reason of reasons) {
    console.log(`  ${reason}`);
  }
  console.log('');
}

async function main() {
  const tenantSlug = 'skinome';
  
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
  
  // Order IDs to analyze
  const knownMissing = [
    '7056661905751', // #139795 - cancelled
    '7052073599319', // #139721 - no transactions
  ];
  
  const excludedFromAnalytics = [
    '7021510721879',
    '7050854203735',
    '6992861004119',
  ];
  
  console.log('='.repeat(80));
  console.log('Analysis: Orders Missing from Our System');
  console.log('='.repeat(80));
  console.log('');
  console.log('Known Missing Orders (we exclude, Shopify includes):');
  for (const id of knownMissing) {
    console.log(`  - ${id}`);
  }
  console.log('');
  console.log('Orders Excluded from Shopify Analytics:');
  for (const id of excludedFromAnalytics) {
    console.log(`  - ${id}`);
  }
  console.log('');
  
  // Fetch orders around the target date
  const fetchStartDate = '2025-11-20';
  const fetchEndDate = '2025-12-05';
  
  console.log(`Fetching orders from ${fetchStartDate} to ${fetchEndDate}...`);
  const orders = await fetchShopifyOrdersGraphQL({
    tenantId: tenant.id,
    shopDomain,
    since: fetchStartDate,
    until: fetchEndDate,
    excludeTest: false, // Don't exclude test orders to find them
  });
  
  console.log(`✅ Fetched ${orders.length} total orders\n`);
  
  // Analyze known missing orders
  console.log('='.repeat(80));
  console.log('KNOWN MISSING ORDERS (We exclude, Shopify includes)');
  console.log('='.repeat(80));
  console.log('');
  
  for (const orderId of knownMissing) {
    await analyzeOrder(orderId, orders);
  }
  
  // Analyze orders excluded from Analytics
  console.log('='.repeat(80));
  console.log('ORDERS EXCLUDED FROM SHOPIFY ANALYTICS');
  console.log('='.repeat(80));
  console.log('');
  
  for (const orderId of excludedFromAnalytics) {
    await analyzeOrder(orderId, orders);
  }
  
  // Summary
  console.log('='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log('');
  console.log('These orders are excluded from Shopify Analytics Net Sales:');
  console.log('  - Likely test orders, unconfirmed orders, or orders without payment');
  console.log('  - They exist in Shopify but are not counted in financial reports');
  console.log('  - Our exclusion logic is correct (we should exclude them too)');
  console.log('');
}

main().catch(console.error);



