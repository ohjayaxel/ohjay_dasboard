/**
 * Order-level reconciliation for 2025-11-28
 * Compares our Net Sales calculation vs Shopify's for each order
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
const SHOPIFY_EXPECTED_TOTAL = 111773.01;

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
 * Our Net Sales calculation
 */
function calculateOurNetSales(order: GraphQLOrder): {
  subtotalPriceSet: number;
  totalTaxSet: number;
  refundsExclTax: number;
  netSales: number;
  refundDetails: Array<{ date: string; amount: number; lineItems: Array<{ productKey: string; amount: number }> }>;
  hasShippingRefund: boolean;
  giftCardAmount?: number;
  orderAdjustments?: number;
} {
  const subtotalPrice = order.subtotalPriceSet
    ? parseMoneyAmount(order.subtotalPriceSet.shopMoney.amount)
    : 0;
  
  const totalTax = order.totalTaxSet
    ? parseMoneyAmount(order.totalTaxSet.shopMoney.amount)
    : 0;
  
  // Calculate refunds EXCL tax
  let refundsExclTax = 0;
  const refundDetails: Array<{ date: string; amount: number; lineItems: Array<{ productKey: string; amount: number }> }> = [];
  let hasShippingRefund = false;
  
  for (const refund of order.refunds) {
    const refundDate = toLocalDate(refund.createdAt, STORE_TIMEZONE);
    const lineItems: Array<{ productKey: string; amount: number }> = [];
    let refundAmount = 0;
    
    for (const refundLineItemEdge of refund.refundLineItems.edges) {
      const refundLineItem = refundLineItemEdge.node;
      const originalLineItem = refundLineItem.lineItem;
      
      if (!originalLineItem) {
        hasShippingRefund = true; // Could be shipping refund
        continue;
      }
      
      let itemAmount = 0;
      if (refundLineItem.subtotalSet) {
        itemAmount = parseMoneyAmount(refundLineItem.subtotalSet.shopMoney.amount);
      } else if (originalLineItem.originalUnitPriceSet) {
        const originalPrice = parseMoneyAmount(originalLineItem.originalUnitPriceSet.shopMoney.amount);
        itemAmount = originalPrice * refundLineItem.quantity;
      }
      
      itemAmount = roundTo2Decimals(itemAmount);
      refundAmount += itemAmount;
      
      lineItems.push({
        productKey: originalLineItem.sku || originalLineItem.id,
        amount: itemAmount,
      });
    }
    
    refundAmount = roundTo2Decimals(refundAmount);
    if (refundAmount > 0 || lineItems.length > 0) {
      refundsExclTax += refundAmount;
      refundDetails.push({ date: refundDate, amount: refundAmount, lineItems });
    }
  }
  
  refundsExclTax = roundTo2Decimals(refundsExclTax);
  
  const netSales = roundTo2Decimals(subtotalPrice - totalTax - refundsExclTax);
  
  return {
    subtotalPriceSet: subtotalPrice,
    totalTaxSet: totalTax,
    refundsExclTax,
    netSales,
    refundDetails,
    hasShippingRefund,
  };
}

/**
 * Check if order is included by both methods
 */
function isIncludedByBoth(order: GraphQLOrder, targetDate: string): { 
  included: boolean; 
  reason: string;
  transactionDate?: string;
} {
  const createdAt = toLocalDate(order.createdAt, STORE_TIMEZONE);
  
  // Shopify includes if created on date (regardless of cancelled/transactions)
  if (createdAt !== targetDate) {
    return { included: false, reason: `Created on ${createdAt}, not ${targetDate}` };
  }
  
  // We include if:
  // 1. Not cancelled
  // 2. Has successful transactions
  // 3. Transaction processed on target date
  if (order.cancelledAt) {
    return { included: false, reason: 'Cancelled order (we exclude)' };
  }
  
  const successfulTransactions = (order.transactions || []).filter(
    (txn) =>
      (txn.kind === 'SALE' || txn.kind === 'CAPTURE') &&
      txn.status === 'SUCCESS' &&
      txn.processedAt,
  );
  
  if (successfulTransactions.length === 0) {
    return { included: false, reason: 'No successful transactions (we exclude)' };
  }
  
  const transactionDate = toLocalDate(successfulTransactions[0].processedAt!, STORE_TIMEZONE);
  if (transactionDate !== targetDate) {
    return { included: false, reason: `Transaction date ${transactionDate} != ${targetDate}` };
  }
  
  return { included: true, reason: 'Included by both', transactionDate };
}

async function main() {
  const tenantSlug = 'skinome';
  
  console.log('='.repeat(80));
  console.log('Order-Level Reconciliation - 2025-11-28');
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
  
  const orders = await fetchShopifyOrdersGraphQL({
    tenantId: tenant.id,
    shopDomain,
    since: '2025-11-26',
    until: '2025-11-30',
    excludeTest: true,
  });
  
  // Filter to orders included by BOTH methods
  const includedByBoth: Array<{
    order: GraphQLOrder;
    ourNetSales: number;
    calcDetails: ReturnType<typeof calculateOurNetSales>;
  }> = [];
  
  for (const order of orders) {
    const inclusion = isIncludedByBoth(order, TARGET_DATE);
    if (inclusion.included) {
      const calc = calculateOurNetSales(order);
      includedByBoth.push({
        order,
        ourNetSales: calc.netSales,
        calcDetails: calc,
      });
    }
  }
  
  console.log(`Orders included by BOTH Shopify and our method: ${includedByBoth.length}`);
  
  // Calculate our total for these 141 orders
  const ourTotalFor141Orders = includedByBoth.reduce((sum, item) => sum + item.ourNetSales, 0);
  console.log(`Our Calculated Total (141 orders): ${ourTotalFor141Orders.toFixed(2)} SEK`);
  
  // Shopify has 143 orders total = 111,773.01 SEK
  // The 2 missing orders have -148.48 SEK combined
  // So for the 141 orders we both include:
  // Shopify total = 111,773.01 - (-148.48) = 111,921.49 SEK
  const shopifyTotalFor141Orders = SHOPIFY_EXPECTED_TOTAL - (-148.48); // Subtract the missing orders' impact
  console.log(`Shopify Expected Total (141 orders): ${shopifyTotalFor141Orders.toFixed(2)} SEK`);
  console.log(`   (Shopify total 143 orders: ${SHOPIFY_EXPECTED_TOTAL.toFixed(2)} SEK)`);
  console.log(`   (Missing 2 orders: -148.48 SEK)`);
  console.log('');
  
  const expectedDiff = ourTotalFor141Orders - shopifyTotalFor141Orders;
  console.log(`Expected Difference (for 141 orders): ${expectedDiff.toFixed(2)} SEK`);
  console.log(`   (This should match the remaining 749.21 SEK when we verify)`);
  console.log('');
  
  // Since we don't have Shopify's per-order Net Sales from Analytics API,
  // we need to work backwards from the total to identify which orders contribute to the diff
  
  // Strategy: Calculate what Shopify's Net Sales must be for each order
  // If our total is higher, Shopify must have lower Net Sales for some orders
  // The difference per order could be:
  // 1. Different refund handling
  // 2. Order adjustments
  // 3. Shipping refunds
  // 4. Gift card payments
  // 5. Currency/presentment money differences
  
  console.log('='.repeat(80));
  console.log('ORDER-BY-ORDER ANALYSIS');
  console.log('='.repeat(80));
  console.log('');
  console.log('Since we cannot access Shopify Analytics per-order data via API,');
  console.log('we will identify potential differences by analyzing:');
  console.log('  1. Orders with refunds');
  console.log('  2. Orders with shipping refunds');
  console.log('  3. Orders with large Net Sales (potential rounding differences)');
  console.log('  4. Orders with unusual tax calculations');
  console.log('');
  
  // Export detailed CSV for manual reconciliation
  const fs = require('fs');
  const csvPath = `scripts/data/reconciliation_orders_${TARGET_DATE.replace(/-/g, '_')}.csv`;
  
  // CSV with all details needed for reconciliation - sorted by Net Sales DESC
  let csv = 'order_id,order_name,created_at,shopify_net_sales,our_net_sales,diff,subtotal_price_set,total_tax_set,refunds_excl_tax,has_refunds,refund_dates,refund_details,has_shipping_refund,currency,notes\n';
  
  // Also create a detailed analysis array
  const detailedAnalysis: Array<{
    orderId: string;
    orderName: string;
    ourNetSales: number;
    subtotalPriceSet: number;
    totalTaxSet: number;
    refundsExclTax: number;
    hasRefunds: boolean;
    refundDetails: string;
    hasShippingRefund: boolean;
    flags: string[];
  }> = [];
  
  for (const item of includedByBoth) {
    const { order, ourNetSales, calcDetails } = item;
    
    const refundDates = calcDetails.refundDetails.map(r => r.date).join(';');
    const refundDetailsStr = calcDetails.refundDetails.map(r => 
      `${r.date}:${r.amount.toFixed(2)}(${r.lineItems.map(li => li.productKey).join(',')})`
    ).join(' | ');
    
    const flags: string[] = [];
    if (calcDetails.hasShippingRefund) flags.push('SHIPPING_REFUND');
    if (calcDetails.refundDetails.length > 0) flags.push('HAS_REFUNDS');
    if (Math.abs(calcDetails.totalTaxSet - calcDetails.netSales) < 100) flags.push('LOW_NET_SALES');
    if (ourNetSales > 3000) flags.push('LARGE_ORDER');
    
    detailedAnalysis.push({
      orderId: order.legacyResourceId || order.id,
      orderName: order.name,
      ourNetSales,
      subtotalPriceSet: calcDetails.subtotalPriceSet,
      totalTaxSet: calcDetails.totalTaxSet,
      refundsExclTax: calcDetails.refundsExclTax,
      hasRefunds: calcDetails.refundDetails.length > 0,
      refundDetails: refundDetailsStr,
      hasShippingRefund: calcDetails.hasShippingRefund,
      flags,
    });
    
    // shopify_net_sales column left empty for manual fill
    csv += `"${order.legacyResourceId || order.id}","${order.name}","${order.createdAt}","[FILL FROM SHOPIFY]",${ourNetSales.toFixed(2)},"[AUTO]",${calcDetails.subtotalPriceSet.toFixed(2)},${calcDetails.totalTaxSet.toFixed(2)},${calcDetails.refundsExclTax.toFixed(2)},${calcDetails.refundDetails.length > 0 ? 'Yes' : 'No'},"${refundDates}","${refundDetailsStr}","${calcDetails.hasShippingRefund ? 'Yes' : 'No'}","${order.currencyCode}",""\n`;
  }
  
  fs.writeFileSync(csvPath, csv, 'utf-8');
  console.log(`✅ Exported reconciliation CSV: ${csvPath}`);
  console.log('');
  
  // Sort by Net Sales DESC for easier analysis
  detailedAnalysis.sort((a, b) => Math.abs(b.ourNetSales) - Math.abs(a.ourNetSales));
  
  // Re-export CSV sorted by Net Sales DESC
  csv = 'order_id,order_name,created_at,shopify_net_sales,our_net_sales,diff,subtotal_price_set,total_tax_set,refunds_excl_tax,has_refunds,refund_dates,refund_details,has_shipping_refund,currency,notes\n';
  for (const item of detailedAnalysis) {
    const orderData = includedByBoth.find(d => (d.order.legacyResourceId || d.order.id) === item.orderId);
    if (!orderData) continue;
    
    const { order, calcDetails } = orderData;
    const refundDates = calcDetails.refundDetails.map(r => r.date).join(';');
    const refundDetailsStr = calcDetails.refundDetails.map(r => 
      `${r.date}:${r.amount.toFixed(2)}(${r.lineItems.map(li => li.productKey).join(',')})`
    ).join(' | ');
    
    csv += `"${item.orderId}","${item.orderName}","${order.createdAt}","[FILL FROM SHOPIFY]",${item.ourNetSales.toFixed(2)},"[AUTO]",${item.subtotalPriceSet.toFixed(2)},${item.totalTaxSet.toFixed(2)},${item.refundsExclTax.toFixed(2)},${item.hasRefunds ? 'Yes' : 'No'},"${refundDates}","${refundDetailsStr}","${item.hasShippingRefund ? 'Yes' : 'No'}","${order.currencyCode}",""\n`;
  }
  
  fs.writeFileSync(csvPath, csv, 'utf-8');
  
  console.log('Top 20 orders by Net Sales (our calculation):');
  console.log('');
  console.log('Order ID    | Order Name | Our Net Sales | Subtotal | Tax     | Refunds | Flags');
  console.log('-'.repeat(80));
  
  for (const item of detailedAnalysis.slice(0, 20)) {
    console.log(
      `${item.orderId.padEnd(12)} | ${item.orderName.padEnd(10)} | ${item.ourNetSales.toFixed(2).padStart(13)} | ${item.subtotalPriceSet.toFixed(2).padStart(8)} | ${item.totalTaxSet.toFixed(2).padStart(7)} | ${item.refundsExclTax.toFixed(2).padStart(7)} | ${item.flags.join(',')}`
    );
  }
  
  console.log('');
  console.log('='.repeat(80));
  console.log('RECONCILIATION TABLE TEMPLATE');
  console.log('='.repeat(80));
  console.log('');
  console.log('To complete the reconciliation, you need to manually add Shopify Net Sales from Analytics:');
  console.log('');
  console.log('order_id,shopify_net_sales,our_net_sales,diff');
  
  for (const item of detailedAnalysis) {
    // For now, we'll use our calculation as placeholder
    // User needs to fill in Shopify Net Sales manually
    console.log(`${item.orderId},[SHOPIFY_VALUE],${item.ourNetSales.toFixed(2)},[DIFF]`);
  }
  
  console.log('');
  console.log('='.repeat(80));
  console.log('INSTRUCTIONS FOR MANUAL RECONCILIATION');
  console.log('='.repeat(80));
  console.log('');
  console.log('1. Open the CSV file: scripts/data/reconciliation_orders_2025_11_28.csv');
  console.log('2. For each order, open Shopify Admin → Orders → [Order Name]');
  console.log('3. Note the Net Sales value from Shopify Analytics for that order');
  console.log('4. Add it to the CSV in a new column "shopify_net_sales"');
  console.log('5. Calculate diff = our_net_sales - shopify_net_sales');
  console.log('6. Sort by ABS(diff) DESC to find orders with largest differences');
  console.log('7. Verify SUM(diff) = 749.21 SEK');
  console.log('');
  
  // Since we can't get Shopify per-order data, let's try to estimate based on the total difference
  // If our total is 749.21 SEK higher, we can distribute this difference proportionally
  // to identify which orders are most likely to have differences
  
  console.log('='.repeat(80));
  console.log('ESTIMATED DIFFERENCES (PROPORTIONAL ALLOCATION)');
  console.log('='.repeat(80));
  console.log('');
  console.log('Since our total is 749.21 SEK higher than Shopify,');
  console.log('we estimate each order\'s contribution proportionally:');
  console.log('');
  
  const totalNetSalesAbs = includedByBoth.reduce((sum, item) => sum + Math.abs(item.ourNetSales), 0);
  
  const estimatedDiffs = includedByBoth.map(item => ({
    ...item,
    estimatedShopifyNetSales: item.ourNetSales - (item.ourNetSales / totalNetSalesAbs * expectedDiff),
    estimatedDiff: (item.ourNetSales / totalNetSalesAbs) * expectedDiff,
  }));
  
  estimatedDiffs.sort((a, b) => Math.abs(b.estimatedDiff) - Math.abs(a.estimatedDiff));
  
  console.log('Top 20 orders by estimated difference:');
  console.log('');
  console.log('Order ID    | Order Name | Our Net   | Est. Shopify | Est. Diff');
  console.log('-'.repeat(70));
  
  for (const item of estimatedDiffs.slice(0, 20)) {
    console.log(
      `${item.order.legacyResourceId || item.order.id}`.padEnd(12) + 
      ` | ${item.order.name.padEnd(10)}` +
      ` | ${item.ourNetSales.toFixed(2).padStart(9)}` +
      ` | ${item.estimatedShopifyNetSales.toFixed(2).padStart(12)}` +
      ` | ${item.estimatedDiff.toFixed(2).padStart(9)}`
    );
  }
  
  console.log('');
  console.log('⚠️  Note: These are ESTIMATES based on proportional allocation.');
  console.log('   Actual differences must be verified manually in Shopify Admin.');
  console.log('');
  
  // Detailed analysis for top 5 orders by Net Sales
  console.log('='.repeat(80));
  console.log('DETAILED ANALYSIS - TOP 5 ORDERS BY NET SALES');
  console.log('='.repeat(80));
  console.log('');
  
  for (let i = 0; i < Math.min(5, includedByBoth.length); i++) {
    const item = includedByBoth.sort((a, b) => Math.abs(b.ourNetSales) - Math.abs(a.ourNetSales))[i];
    const { order, ourNetSales, calcDetails } = item;
    
    console.log(`Order ${i + 1}: ${order.name} (ID: ${order.legacyResourceId || order.id})`);
    console.log(`  Created: ${order.createdAt}`);
    console.log(`  Currency: ${order.currencyCode}`);
    console.log(`  Our Net Sales: ${ourNetSales.toFixed(2)} ${order.currencyCode}`);
    console.log('');
    console.log(`  Calculation Breakdown:`);
    console.log(`    subtotalPriceSet: ${calcDetails.subtotalPriceSet.toFixed(2)} ${order.currencyCode}`);
    console.log(`    totalTaxSet: ${calcDetails.totalTaxSet.toFixed(2)} ${order.currencyCode}`);
    console.log(`    refundsExclTax: ${calcDetails.refundsExclTax.toFixed(2)} ${order.currencyCode}`);
    console.log(`    Net Sales = ${calcDetails.subtotalPriceSet.toFixed(2)} - ${calcDetails.totalTaxSet.toFixed(2)} - ${calcDetails.refundsExclTax.toFixed(2)} = ${ourNetSales.toFixed(2)} ${order.currencyCode}`);
    console.log('');
    
    if (calcDetails.refundDetails.length > 0) {
      console.log(`  Refunds:`);
      for (const refund of calcDetails.refundDetails) {
        console.log(`    - Date: ${refund.date}, Amount: ${refund.amount.toFixed(2)} ${order.currencyCode}`);
        for (const lineItem of refund.lineItems) {
          console.log(`      Product: ${lineItem.productKey}, Amount: ${lineItem.amount.toFixed(2)} ${order.currencyCode}`);
        }
      }
      console.log('');
    }
    
    if (calcDetails.hasShippingRefund) {
      console.log(`  ⚠️  Has shipping refund (check manually in Shopify Admin)`);
      console.log('');
    }
    
    // Check for presentment money vs shop money differences
    if (order.subtotalPriceSet?.presentmentMoney?.amount) {
      const shopMoney = parseMoneyAmount(order.subtotalPriceSet.shopMoney.amount);
      const presentmentMoney = parseMoneyAmount(order.subtotalPriceSet.presentmentMoney.amount);
      if (Math.abs(shopMoney - presentmentMoney) > 0.01) {
        console.log(`  ⚠️  Currency difference detected:`);
        console.log(`      shopMoney: ${shopMoney.toFixed(2)}`);
        console.log(`      presentmentMoney: ${presentmentMoney.toFixed(2)}`);
        console.log(`      Difference: ${(shopMoney - presentmentMoney).toFixed(2)} ${order.currencyCode}`);
        console.log('');
      }
    }
    
    console.log(`  Action: Check Shopify Admin → Orders → ${order.name} → Financial Summary`);
    console.log(`          Compare Net Sales value with our calculation: ${ourNetSales.toFixed(2)} ${order.currencyCode}`);
    console.log('');
    console.log('-'.repeat(80));
    console.log('');
  }
  
  console.log('='.repeat(80));
  console.log('RECONCILIATION SUMMARY');
  console.log('='.repeat(80));
  console.log('');
  console.log(`1. CSV exported: ${csvPath}`);
  console.log(`2. Total orders to verify: ${includedByBoth.length}`);
  console.log(`3. Expected total difference: 749.21 SEK`);
  console.log(`4. Our total for 141 orders: ${ourTotalFor141Orders.toFixed(2)} SEK`);
  console.log(`5. Shopify expected for 141 orders: ${shopifyTotalFor141Orders.toFixed(2)} SEK`);
  console.log('');
  console.log('Next steps:');
  console.log('1. Open CSV file: scripts/data/reconciliation_orders_2025_11_28.csv');
  console.log('2. For each order, open Shopify Admin → Orders → [Order Name]');
  console.log('3. Find Net Sales value in Financial Summary or Analytics');
  console.log('4. Fill in "shopify_net_sales" column');
  console.log('5. Calculate diff = our_net_sales - shopify_net_sales');
  console.log('6. Sort by ABS(diff) DESC');
  console.log('7. Verify SUM(diff) = 749.21 SEK');
  console.log('');
}

main().catch(console.error);

