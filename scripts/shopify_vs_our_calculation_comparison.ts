/**
 * Compare our calculation vs Shopify's calculation order-by-order
 * Simulates Shopify method: order.createdAt + include cancelled + include no-transaction orders
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
 * Calculate Net Sales for an order
 */
function calculateNetSales(order: GraphQLOrder): {
  subtotalPriceSet: number;
  totalTaxSet: number;
  netSalesExclTaxBeforeRefunds: number;
  refundsExclTax: number;
  netSalesExclTaxAfterRefunds: number;
  refundDetails: Array<{ date: string; amount: number }>;
} {
  const subtotalPrice = order.subtotalPriceSet
    ? parseMoneyAmount(order.subtotalPriceSet.shopMoney.amount)
    : 0;
  
  const totalTax = order.totalTaxSet
    ? parseMoneyAmount(order.totalTaxSet.shopMoney.amount)
    : 0;
  
  const netSalesExclTaxBeforeRefunds = roundTo2Decimals(subtotalPrice - totalTax);
  
  // Calculate returns EXCL tax
  let refundsExclTax = 0;
  const refundDetails: Array<{ date: string; amount: number }> = [];
  
  for (const refund of order.refunds) {
    const refundDate = toLocalDate(refund.createdAt, STORE_TIMEZONE);
    let refundAmount = 0;
    
    for (const refundLineItemEdge of refund.refundLineItems.edges) {
      const refundLineItem = refundLineItemEdge.node;
      if (refundLineItem.subtotalSet) {
        const amount = parseMoneyAmount(refundLineItem.subtotalSet.shopMoney.amount);
        refundAmount += amount;
      } else if (refundLineItem.lineItem?.originalUnitPriceSet) {
        const originalPrice = parseMoneyAmount(refundLineItem.lineItem.originalUnitPriceSet.shopMoney.amount);
        refundAmount += originalPrice * refundLineItem.quantity;
      }
    }
    
    refundAmount = roundTo2Decimals(refundAmount);
    refundsExclTax += refundAmount;
    
    if (refundAmount > 0) {
      refundDetails.push({ date: refundDate, amount: refundAmount });
    }
  }
  
  refundsExclTax = roundTo2Decimals(refundsExclTax);
  const netSalesExclTaxAfterRefunds = roundTo2Decimals(netSalesExclTaxBeforeRefunds - refundsExclTax);
  
  return {
    subtotalPriceSet: subtotalPrice,
    totalTaxSet: totalTax,
    netSalesExclTaxBeforeRefunds,
    refundsExclTax,
    netSalesExclTaxAfterRefunds,
    refundDetails,
  };
}

async function main() {
  const tenantSlug = 'skinome';
  const targetDate = '2025-11-28';
  const shopifyExpectedNetSales = 111773.01;
  
  console.log('='.repeat(80));
  console.log('Shopify vs Our Calculation - Order-by-Order Comparison');
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
  
  console.log(`Fetching orders...`);
  const orders = await fetchShopifyOrdersGraphQL({
    tenantId: tenant.id,
    shopDomain,
    since: fetchStartDateStr,
    until: fetchEndDateStr,
    excludeTest: true,
  });
  
  // Filter by Shopify method: order.createdAt
  const shopifyOrders = orders.filter(o => {
    const createdDate = toLocalDate(o.createdAt, STORE_TIMEZONE);
    return createdDate === targetDate;
  });
  
  console.log(`✅ Found ${shopifyOrders.length} orders by order.createdAt\n`);
  
  // Calculate using both methods
  const ourIncluded = new Set<string>();
  let ourTotal = 0;
  let shopifyTotal = 0;
  
  const comparison: Array<{
    order: GraphQLOrder;
    createdAt: string;
    cancelledAt: string | null;
    hasTransactions: boolean;
    ourIncluded: boolean;
    ourReason: string;
    ourNetSales: number;
    shopifyNetSales: number;
    diff: number;
    refundOnSameDay: boolean;
  }> = [];
  
  for (const order of shopifyOrders) {
    const createdAt = toLocalDate(order.createdAt, STORE_TIMEZONE);
    const cancelledAt = order.cancelledAt ? toLocalDate(order.cancelledAt, STORE_TIMEZONE) : null;
    
    // Our method: check if we include it
    const successfulTransactions = (order.transactions || []).filter(
      (txn) =>
        (txn.kind === 'SALE' || txn.kind === 'CAPTURE') &&
        txn.status === 'SUCCESS' &&
        txn.processedAt,
    );
    
    const transactionDate = successfulTransactions.length > 0 && !order.cancelledAt
      ? toLocalDate(successfulTransactions[0].processedAt!, STORE_TIMEZONE)
      : null;
    
    const weInclude = !order.cancelledAt && 
                      successfulTransactions.length > 0 && 
                      transactionDate === targetDate;
    
    const calc = calculateNetSales(order);
    
    // Check if refund is on same day as creation
    const refundOnSameDay = calc.refundDetails.some(r => r.date === targetDate);
    
    // Shopify includes ALL orders created on this date
    // But: Does Shopify subtract refunds if they happen on the same day?
    // Hypothesis: Shopify might NOT subtract refunds if they happen on creation day (exchange scenario)
    // OR: Shopify subtracts ALL refunds regardless of date
    let shopifyNetSales = calc.netSalesExclTaxAfterRefunds;
    
    // Test hypothesis: Maybe Shopify doesn't subtract refunds if they're on the creation day?
    // But that doesn't make sense because then Net Sales would be higher, not lower
    
    // Actually, wait - if Shopify subtracts refunds that happen on the SAME day as creation,
    // then for an exchange order, it would be: sale - refund = 0 or negative
    // But if Shopify DOESN'T subtract same-day refunds, then Net Sales = sale only
    
    // However, the user said Shopify includes cancelled orders. So for order #139795:
    // - Created: 2025-11-28
    // - Refunded: 2025-12-01 (3 days later)
    // Shopify would include it, and subtract the refund? Or not?
    
    if (weInclude) {
      ourIncluded.add(order.id);
      ourTotal += calc.netSalesExclTaxAfterRefunds;
    }
    
    shopifyTotal += shopifyNetSales;
    
    comparison.push({
      order,
      createdAt,
      cancelledAt,
      hasTransactions: successfulTransactions.length > 0,
      ourIncluded: weInclude,
      ourReason: order.cancelledAt ? 'Cancelled' : 
                 successfulTransactions.length === 0 ? 'No transactions' :
                 transactionDate !== targetDate ? `Transaction date: ${transactionDate}` :
                 'Included',
      ourNetSales: weInclude ? calc.netSalesExclTaxAfterRefunds : 0,
      shopifyNetSales,
      diff: weInclude ? 0 : shopifyNetSales, // Diff only if we exclude but Shopify includes
      refundOnSameDay,
    });
  }
  
  console.log('='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Orders by order.createdAt: ${shopifyOrders.length}`);
  console.log(`Orders we include: ${ourIncluded.size}`);
  console.log('');
  console.log(`Our Total Net Sales: ${ourTotal.toFixed(2)} SEK`);
  console.log(`Shopify Total (if we include all): ${shopifyTotal.toFixed(2)} SEK`);
  console.log(`Shopify Expected: ${shopifyExpectedNetSales.toFixed(2)} SEK`);
  console.log('');
  
  // Find orders where we differ
  const diffOrders = comparison.filter(c => c.diff !== 0 || Math.abs(c.shopifyNetSales - c.ourNetSales) > 0.01);
  diffOrders.sort((a, b) => Math.abs(b.diff || b.shopifyNetSales) - Math.abs(a.diff || a.shopifyNetSales));
  
  console.log('='.repeat(80));
  console.log(`ORDERS WITH DIFFERENCES (${diffOrders.length})`);
  console.log('='.repeat(80));
  console.log('');
  
  for (const item of diffOrders.slice(0, 20)) {
    const calc = calculateNetSales(item.order);
    console.log(`Order: ${item.order.name} (${item.order.legacyResourceId || item.order.id})`);
    console.log(`  Created: ${item.createdAt}`);
    console.log(`  Cancelled: ${item.cancelledAt || 'No'}`);
    console.log(`  Has Transactions: ${item.hasTransactions}`);
    console.log(`  Our Included: ${item.ourIncluded ? 'Yes' : 'No'} (${item.ourReason})`);
    console.log(`  Our Net Sales: ${item.ourNetSales.toFixed(2)} SEK`);
    console.log(`  Shopify Net Sales: ${item.shopifyNetSales.toFixed(2)} SEK`);
    console.log(`  Diff: ${item.diff.toFixed(2)} SEK`);
    console.log(`  Refund on Same Day: ${item.refundOnSameDay ? 'Yes' : 'No'}`);
    
    if (calc.refundDetails.length > 0) {
      console.log(`  Refunds:`);
      for (const refund of calc.refundDetails) {
        console.log(`    - ${refund.date}: ${refund.amount.toFixed(2)} SEK`);
      }
    }
    
    console.log(`  Calculation:`);
    console.log(`    subtotalPriceSet: ${calc.subtotalPriceSet.toFixed(2)} SEK`);
    console.log(`    totalTaxSet: ${calc.totalTaxSet.toFixed(2)} SEK`);
    console.log(`    Net (before refunds): ${calc.netSalesExclTaxBeforeRefunds.toFixed(2)} SEK`);
    console.log(`    Refunds (EXCL tax): ${calc.refundsExclTax.toFixed(2)} SEK`);
    console.log(`    Net (after refunds): ${calc.netSalesExclTaxAfterRefunds.toFixed(2)} SEK`);
    console.log('');
  }
  
  // Hypothesis testing
  console.log('='.repeat(80));
  console.log('HYPOTHESIS TESTING');
  console.log('='.repeat(80));
  console.log('');
  
  // Hypothesis 1: Shopify doesn't subtract refunds that happen on creation day
  let hypothesis1Total = 0;
  for (const item of comparison) {
    const calc = calculateNetSales(item.order);
    const refundOnSameDay = calc.refundDetails.some(r => r.date === targetDate);
    const netSales = refundOnSameDay 
      ? calc.netSalesExclTaxBeforeRefunds  // Don't subtract same-day refunds
      : calc.netSalesExclTaxAfterRefunds;  // Subtract other refunds
    hypothesis1Total += netSales;
  }
  
  console.log(`Hypothesis 1: Shopify doesn't subtract refunds on creation day`);
  console.log(`  Total: ${hypothesis1Total.toFixed(2)} SEK`);
  console.log(`  Diff from expected: ${Math.abs(hypothesis1Total - shopifyExpectedNetSales).toFixed(2)} SEK`);
  console.log('');
  
  // Hypothesis 2: Shopify subtracts ALL refunds regardless of date
  console.log(`Hypothesis 2: Shopify subtracts ALL refunds (current calculation)`);
  console.log(`  Total: ${shopifyTotal.toFixed(2)} SEK`);
  console.log(`  Diff from expected: ${Math.abs(shopifyTotal - shopifyExpectedNetSales).toFixed(2)} SEK`);
  console.log('');
}

main().catch(console.error);



