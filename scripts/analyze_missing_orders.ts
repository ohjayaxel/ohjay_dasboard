/**
 * Analyze missing orders for 2025-11-28
 * Find which orders Shopify includes but we don't
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

async function analyzeDate(tenantId: string, shopDomain: string, date: string) {
  console.log(`\nAnalyzing date: ${date}...`);
  
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
  
  console.log(`Fetched ${orders.length} total orders in date range`);
  
  // Group orders by different criteria
  const byTransactionProcessedAt = new Map<string, GraphQLOrder[]>();
  const byOrderCreatedAt = new Map<string, GraphQLOrder[]>();
  const byOrderProcessedAt = new Map<string, GraphQLOrder[]>();
  
  const cancelledOrders = [];
  const noSuccessfulTransactions = [];
  const allOrders = [];
  
  for (const order of orders) {
    const orderCreatedDate = toLocalDate(order.createdAt, STORE_TIMEZONE);
    const orderProcessedDate = order.processedAt ? toLocalDate(order.processedAt, STORE_TIMEZONE) : null;
    
    if (order.cancelledAt) {
      cancelledOrders.push(order);
      continue;
    }
    
    const successfulTransactions = (order.transactions || []).filter(
      (txn) =>
        (txn.kind === 'SALE' || txn.kind === 'CAPTURE') &&
        txn.status === 'SUCCESS' &&
        txn.processedAt,
    );
    
    if (successfulTransactions.length === 0) {
      noSuccessfulTransactions.push(order);
      continue;
    }
    
    const transactionDate = toLocalDate(successfulTransactions[0].processedAt!, STORE_TIMEZONE);
    
    if (!byTransactionProcessedAt.has(transactionDate)) {
      byTransactionProcessedAt.set(transactionDate, []);
    }
    byTransactionProcessedAt.get(transactionDate)!.push(order);
    
    if (!byOrderCreatedAt.has(orderCreatedDate)) {
      byOrderCreatedAt.set(orderCreatedDate, []);
    }
    byOrderCreatedAt.get(orderCreatedDate)!.push(order);
    
    if (orderProcessedDate) {
      if (!byOrderProcessedAt.has(orderProcessedDate)) {
        byOrderProcessedAt.set(orderProcessedDate, []);
      }
      byOrderProcessedAt.get(orderProcessedDate)!.push(order);
    }
    
    allOrders.push(order);
  }
  
  console.log(`\n📊 Analysis for ${date}:`);
  console.log(`  Total orders fetched: ${orders.length}`);
  console.log(`  Cancelled orders: ${cancelledOrders.length}`);
  console.log(`  Orders without successful transactions: ${noSuccessfulTransactions.length}`);
  console.log(`  Orders by transaction.processedAt (${date}): ${byTransactionProcessedAt.get(date)?.length || 0}`);
  console.log(`  Orders by order.createdAt (${date}): ${byOrderCreatedAt.get(date)?.length || 0}`);
  console.log(`  Orders by order.processedAt (${date}): ${byOrderProcessedAt.get(date)?.length || 0}`);
  
  // Show cancelled orders for this date
  if (cancelledOrders.length > 0) {
    console.log(`\n  Cancelled orders (excluded):`);
    for (const order of cancelledOrders.slice(0, 5)) {
      const cancelledDate = order.cancelledAt ? toLocalDate(order.cancelledAt, STORE_TIMEZONE) : 'N/A';
      console.log(`    - ${order.name}: cancelled_at=${cancelledDate}, created_at=${toLocalDate(order.createdAt, STORE_TIMEZONE)}`);
    }
  }
  
  // Show orders without successful transactions
  if (noSuccessfulTransactions.length > 0) {
    console.log(`\n  Orders without successful transactions (excluded):`);
    for (const order of noSuccessfulTransactions.slice(0, 5)) {
      console.log(`    - ${order.name}: financial_status inferred from transactions`);
      if (order.transactions && order.transactions.length > 0) {
        const statuses = order.transactions.map(t => `${t.kind}/${t.status}`).join(', ');
        console.log(`      Transactions: ${statuses}`);
      }
    }
  }
  
  // Calculate Net Sales for orders grouped by transaction.processedAt
  if (byTransactionProcessedAt.has(date)) {
    const ordersForDate = byTransactionProcessedAt.get(date)!;
    let totalNetSales = 0;
    
    for (const order of ordersForDate) {
      const subtotalPrice = order.subtotalPriceSet
        ? parseMoneyAmount(order.subtotalPriceSet.shopMoney.amount)
        : 0;
      
      const totalTax = order.totalTaxSet
        ? parseMoneyAmount(order.totalTaxSet.shopMoney.amount)
        : 0;
      
      let refunds = 0;
      for (const refund of order.refunds) {
        for (const refundLineItemEdge of refund.refundLineItems.edges) {
          const refundLineItem = refundLineItemEdge.node;
          if (refundLineItem.subtotalSet) {
            refunds += parseMoneyAmount(refundLineItem.subtotalSet.shopMoney.amount);
          }
        }
      }
      
      const netSales = roundTo2Decimals(subtotalPrice - totalTax - refunds);
      totalNetSales += netSales;
    }
    
    console.log(`\n  Net Sales (by transaction.processedAt): ${totalNetSales.toFixed(2)} SEK`);
  }
}

async function main() {
  const tenantSlug = 'skinome';
  const dates = ['2025-11-28', '2025-11-29', '2025-11-30'];
  
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
  
  for (const date of dates) {
    await analyzeDate(tenant.id, shopDomain, date);
  }
}

main().catch(console.error);



