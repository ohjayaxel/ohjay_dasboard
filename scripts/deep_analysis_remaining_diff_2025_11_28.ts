/**
 * Deep analysis to find remaining ~1,046 SEK discrepancy
 * Compares our calculation vs Shopify's expected calculation for all orders
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

/**
 * Calculate Net Sales our way (transaction.processedAt)
 */
function calculateOurNetSales(order: GraphQLOrder): {
  netSales: number;
  subtotalPriceSet: number;
  totalTaxSet: number;
  refunds: number;
} {
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
      } else if (refundLineItem.lineItem?.originalUnitPriceSet) {
        const originalPrice = parseMoneyAmount(refundLineItem.lineItem.originalUnitPriceSet.shopMoney.amount);
        refunds += originalPrice * refundLineItem.quantity;
      }
    }
  }
  refunds = roundTo2Decimals(refunds);
  
  const netSales = roundTo2Decimals(subtotalPrice - totalTax - refunds);
  
  return { netSales, subtotalPriceSet: subtotalPrice, totalTaxSet: totalTax, refunds };
}

/**
 * Check if order should be included by our method
 */
function isIncludedByOurMethod(order: GraphQLOrder, targetDate: string): { included: boolean; eventDate?: string; reason: string } {
  if (order.cancelledAt) {
    return { included: false, reason: 'Cancelled order' };
  }
  
  const successfulTransactions = (order.transactions || []).filter(
    (txn) =>
      (txn.kind === 'SALE' || txn.kind === 'CAPTURE') &&
      txn.status === 'SUCCESS' &&
      txn.processedAt,
  );
  
  if (successfulTransactions.length === 0) {
    return { included: false, reason: 'No successful transactions' };
  }
  
  const transactionDate = toLocalDate(successfulTransactions[0].processedAt!, STORE_TIMEZONE);
  if (transactionDate !== targetDate) {
    return { included: false, reason: `Event date ${transactionDate} != ${targetDate}`, eventDate: transactionDate };
  }
  
  return { included: true, reason: 'Included', eventDate: transactionDate };
}

async function main() {
  const tenantSlug = 'skinome';
  const targetDate = '2025-11-28';
  const shopifyExpectedNetSales = 111773.01;
  
  console.log('='.repeat(80));
  console.log('Deep Analysis: Remaining ~1,046 SEK Discrepancy');
  console.log('='.repeat(80));
  console.log(`Target Date: ${targetDate}`);
  console.log(`Shopify Expected Net Sales: ${shopifyExpectedNetSales.toFixed(2)} SEK`);
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
  
  // Fetch all orders
  const startDateObj = new Date(targetDate + 'T00:00:00Z');
  const endDateObj = new Date(targetDate + 'T23:59:59Z');
  
  const fetchStartDate = new Date(startDateObj);
  fetchStartDate.setDate(fetchStartDate.getDate() - 2);
  const fetchEndDate = new Date(endDateObj);
  fetchEndDate.setDate(fetchEndDate.getDate() + 2);
  
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
  
  // Group orders by Shopify method (order.createdAt)
  const ordersByCreatedAt = orders.filter(o => {
    const createdDate = toLocalDate(o.createdAt, STORE_TIMEZONE);
    return createdDate === targetDate;
  });
  
  console.log(`Orders by order.createdAt (${targetDate}): ${ordersByCreatedAt.length} orders`);
  console.log('');
  
  // Analyze all orders that Shopify would include
  const ourIncludedOrders = new Set<string>();
  let ourTotalNetSales = 0;
  
  const analysis: Array<{
    order: GraphQLOrder;
    createdAt: string;
    processedAt: string | null;
    cancelledAt: string | null;
    ourIncluded: boolean;
    ourReason: string;
    ourEventDate?: string;
    ourNetSales: number;
    shopifyNetSales: number; // Same calculation, but Shopify might use different logic
    diff: number;
    transactions: string;
    hasRefunds: boolean;
    hasExchange: boolean;
    currency: string;
  }> = [];
  
  for (const order of ordersByCreatedAt) {
    const createdAt = toLocalDate(order.createdAt, STORE_TIMEZONE);
    const processedAt = order.processedAt ? toLocalDate(order.processedAt, STORE_TIMEZONE) : null;
    const cancelledAt = order.cancelledAt ? toLocalDate(order.cancelledAt, STORE_TIMEZONE) : null;
    
    const inclusion = isIncludedByOurMethod(order, targetDate);
    const netSales = calculateOurNetSales(order);
    
    // Check for exchange orders (orders with both sale and refund on same date)
    const hasExchange = order.refunds.some(refund => {
      const refundDate = toLocalDate(refund.createdAt, STORE_TIMEZONE);
      return refundDate === createdAt || refundDate === targetDate;
    });
    
    // Get transaction summary
    const transactionSummary = (order.transactions || []).map(t => 
      `${t.kind}/${t.status}`
    ).join(', ') || 'none';
    
    if (inclusion.included) {
      ourIncludedOrders.add(order.id);
      ourTotalNetSales += netSales.netSales;
    }
    
    analysis.push({
      order,
      createdAt,
      processedAt,
      cancelledAt,
      ourIncluded: inclusion.included,
      ourReason: inclusion.reason,
      ourEventDate: inclusion.eventDate,
      ourNetSales: netSales.netSales,
      shopifyNetSales: netSales.netSales, // Start with same, might adjust
      diff: 0, // Will calculate
      transactions: transactionSummary,
      hasRefunds: order.refunds.length > 0,
      hasExchange,
      currency: order.currencyCode,
    });
  }
  
  // Sort by Net Sales to find large orders
  analysis.sort((a, b) => Math.abs(b.ourNetSales) - Math.abs(a.ourNetSales));
  
  console.log('='.repeat(80));
  console.log('OUR CALCULATION SUMMARY');
  console.log('='.repeat(80));
  console.log(`Orders we include: ${ourIncludedOrders.size}`);
  console.log(`Our Total Net Sales: ${ourTotalNetSales.toFixed(2)} SEK`);
  console.log(`Shopify Expected: ${shopifyExpectedNetSales.toFixed(2)} SEK`);
  console.log(`Difference: ${(ourTotalNetSales - shopifyExpectedNetSales).toFixed(2)} SEK`);
  console.log('');
  
  // Find orders with large Net Sales that might explain the diff
  console.log('='.repeat(80));
  console.log('ORDERS EXCLUDED BY OUR METHOD (sorted by Net Sales)');
  console.log('='.repeat(80));
  console.log('');
  
  const excludedOrders = analysis.filter(a => !a.ourIncluded);
  excludedOrders.sort((a, b) => Math.abs(b.ourNetSales) - Math.abs(a.ourNetSales));
  
  let excludedTotal = 0;
  for (const item of excludedOrders) {
    excludedTotal += item.ourNetSales;
    console.log('─'.repeat(80));
    console.log(`Order: ${item.order.name} (ID: ${item.order.legacyResourceId || item.order.id})`);
    console.log(`  Created At: ${item.createdAt}`);
    console.log(`  Processed At: ${item.processedAt || 'N/A'}`);
    console.log(`  Cancelled At: ${item.cancelledAt || 'N/A'}`);
    console.log(`  Currency: ${item.currency}`);
    console.log(`  Transactions: ${item.transactions}`);
    console.log(`  Has Refunds: ${item.hasRefunds}`);
    console.log(`  Has Exchange: ${item.hasExchange}`);
    console.log(`  Why Excluded: ${item.ourReason}`);
    if (item.ourEventDate) {
      console.log(`  Our Event Date: ${item.ourEventDate}`);
    }
    console.log(`  Net Sales (if included): ${item.ourNetSales.toFixed(2)} ${item.currency}`);
    
    // Show detailed calculation
    const calc = calculateOurNetSales(item.order);
    console.log(`    subtotalPriceSet: ${calc.subtotalPriceSet.toFixed(2)} ${item.currency}`);
    console.log(`    totalTaxSet: ${calc.totalTaxSet.toFixed(2)} ${item.currency}`);
    console.log(`    refunds: ${calc.refunds.toFixed(2)} ${item.currency}`);
    
    // Show refund details
    if (item.order.refunds.length > 0) {
      console.log(`  Refunds:`);
      for (const refund of item.order.refunds) {
        const refundDate = toLocalDate(refund.createdAt, STORE_TIMEZONE);
        console.log(`    - Refund ${refund.id}: created_at=${refund.createdAt} (${refundDate})`);
        let refundTotal = 0;
        for (const refundLineItemEdge of refund.refundLineItems.edges) {
          const refundLineItem = refundLineItemEdge.node;
          if (refundLineItem.subtotalSet) {
            const refundAmount = parseMoneyAmount(refundLineItem.subtotalSet.shopMoney.amount);
            refundTotal += refundAmount;
            console.log(`      Line item: ${refundAmount.toFixed(2)} ${item.currency}`);
          }
        }
        console.log(`      Total refund: ${refundTotal.toFixed(2)} ${item.currency}`);
      }
    }
    console.log('');
  }
  
  console.log(`Total Net Sales from excluded orders: ${excludedTotal.toFixed(2)} SEK`);
  console.log('');
  
  // Now check if Shopify might calculate differently for included orders
  console.log('='.repeat(80));
  console.log('ANALYZING INCLUDED ORDERS FOR CALCULATION DIFFERENCES');
  console.log('='.repeat(80));
  console.log('');
  
  // Check for potential calculation differences
  // Shopify might handle:
  // 1. Exchange orders differently (refund on same day might reduce differently)
  // 2. Multi-currency rounding
  // 3. Order adjustments
  // 4. Gift card payments
  
  const includedOrders = analysis.filter(a => a.ourIncluded);
  
  // Check for orders with refunds that happened on the same day as creation
  const sameDayRefunds = includedOrders.filter(a => {
    if (!a.hasRefunds) return false;
    return a.order.refunds.some(refund => {
      const refundDate = toLocalDate(refund.createdAt, STORE_TIMEZONE);
      return refundDate === targetDate;
    });
  });
  
  if (sameDayRefunds.length > 0) {
    console.log(`Found ${sameDayRefunds.length} orders with refunds on ${targetDate}:`);
    console.log('');
    
    for (const item of sameDayRefunds) {
      console.log(`Order: ${item.order.name}`);
      console.log(`  Net Sales: ${item.ourNetSales.toFixed(2)} ${item.currency}`);
      
      // Check if refund date matches
      for (const refund of item.order.refunds) {
        const refundDate = toLocalDate(refund.createdAt, STORE_TIMEZONE);
        if (refundDate === targetDate) {
          console.log(`  ⚠️  Refund on ${targetDate}: ${refund.id}`);
          console.log(`      Shopify might handle this differently if refund is on creation day`);
        }
      }
      console.log('');
    }
  }
  
  // Check for large orders that might have rounding issues
  const largeOrders = includedOrders.filter(a => Math.abs(a.ourNetSales) > 1000);
  if (largeOrders.length > 0) {
    console.log(`Found ${largeOrders.length} orders with Net Sales > 1000 ${largeOrders[0].currency}:`);
    console.log('');
    
    for (const item of largeOrders.slice(0, 10)) {
      const calc = calculateOurNetSales(item.order);
      console.log(`Order: ${item.order.name} - Net Sales: ${item.ourNetSales.toFixed(2)} ${item.currency}`);
      console.log(`  subtotalPriceSet: ${calc.subtotalPriceSet.toFixed(2)}`);
      console.log(`  totalTaxSet: ${calc.totalTaxSet.toFixed(2)}`);
      console.log(`  refunds: ${calc.refunds.toFixed(2)}`);
      console.log('');
    }
  }
  
  // Summary
  console.log('='.repeat(80));
  console.log('FINAL ANALYSIS');
  console.log('='.repeat(80));
  console.log('');
  console.log(`Shopify Expected Net Sales: ${shopifyExpectedNetSales.toFixed(2)} SEK`);
  console.log(`Our Calculated Net Sales: ${ourTotalNetSales.toFixed(2)} SEK`);
  console.log(`Difference: ${(ourTotalNetSales - shopifyExpectedNetSales).toFixed(2)} SEK`);
  console.log('');
  console.log(`Excluded orders Net Sales: ${excludedTotal.toFixed(2)} SEK`);
  console.log(`If we include excluded: ${(ourTotalNetSales + excludedTotal).toFixed(2)} SEK`);
  console.log('');
  
  // The missing 2 orders we already identified
  console.log('Already identified missing orders:');
  console.log('  Order #139721: 0.00 SEK (no transactions)');
  console.log('  Order #139795: -148.48 SEK (cancelled, refunded)');
  console.log(`  Subtotal: -148.48 SEK`);
  console.log('');
  
  const remainingDiff = (ourTotalNetSales - shopifyExpectedNetSales) - (-148.48);
  console.log(`Remaining unexplained difference: ${remainingDiff.toFixed(2)} SEK`);
  console.log('');
  
  // Try to find the remaining difference
  console.log('='.repeat(80));
  console.log('LOOKING FOR REMAINING DIFFERENCE');
  console.log('='.repeat(80));
  console.log('');
  console.log('Checking if Shopify might calculate Net Sales differently for:');
  console.log('  1. Exchange orders (refund on creation day)');
  console.log('  2. Currency conversion/rounding');
  console.log('  3. Order adjustments');
  console.log('  4. Gift card payments');
  console.log('');
  
  // Check if there are any orders that might have different calculations
  const potentialIssues = includedOrders.filter(a => {
    // Orders with refunds on same day
    if (a.hasRefunds && a.order.refunds.some(r => toLocalDate(r.createdAt, STORE_TIMEZONE) === targetDate)) {
      return true;
    }
    // Orders with multiple currencies
    // Orders with large refunds
    if (Math.abs(a.ourNetSales) > 5000) {
      return true;
    }
    return false;
  });
  
  if (potentialIssues.length > 0) {
    console.log(`Found ${potentialIssues.length} orders that might have calculation differences:`);
    for (const item of potentialIssues.slice(0, 5)) {
      console.log(`  - ${item.order.name}: ${item.ourNetSales.toFixed(2)} ${item.currency}`);
    }
  }
}

main().catch(console.error);


