/**
 * Complete investigation of remaining 749.21 SEK difference
 * Systematic testing of all possible calculation differences
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
const SHOPIFY_EXPECTED = 111773.01;

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
  
  const orders = await fetchShopifyOrdersGraphQL({
    tenantId: tenant.id,
    shopDomain,
    since: '2025-11-26',
    until: '2025-11-30',
    excludeTest: true,
  });
  
  const shopifyOrders = orders.filter(o => {
    const createdDate = toLocalDate(o.createdAt, STORE_TIMEZONE);
    return createdDate === TARGET_DATE;
  });
  
  console.log('='.repeat(80));
  console.log('COMPLETE DIFFERENCE INVESTIGATION');
  console.log('='.repeat(80));
  console.log(`Orders: ${shopifyOrders.length}`);
  console.log(`Shopify Expected: ${SHOPIFY_EXPECTED.toFixed(2)} SEK`);
  console.log('');
  
  // Calculate using our method
  let ourTotal = 0;
  const allOrderDetails = [];
  
  for (const order of shopifyOrders) {
    const subtotalPrice = order.subtotalPriceSet
      ? parseMoneyAmount(order.subtotalPriceSet.shopMoney.amount)
      : 0;
    const totalTax = order.totalTaxSet
      ? parseMoneyAmount(order.totalTaxSet.shopMoney.amount)
      : 0;
    
    // Also calculate tax from taxLines
    let taxFromLines = 0;
    for (const edge of order.lineItems.edges) {
      const lineItem = edge.node;
      if (lineItem.taxLines && lineItem.taxLines.length > 0) {
        for (const taxLine of lineItem.taxLines) {
          taxFromLines += parseMoneyAmount(taxLine.priceSet.shopMoney.amount);
        }
      }
    }
    taxFromLines = roundTo2Decimals(taxFromLines);
    
    // Calculate refunds
    let refunds = 0;
    const refundDetails = [];
    for (const refund of order.refunds) {
      const refundDate = toLocalDate(refund.createdAt, STORE_TIMEZONE);
      let refundAmount = 0;
      
      for (const refundLineItemEdge of refund.refundLineItems.edges) {
        const refundLineItem = refundLineItemEdge.node;
        if (refundLineItem.subtotalSet) {
          refundAmount += parseMoneyAmount(refundLineItem.subtotalSet.shopMoney.amount);
        }
      }
      refundAmount = roundTo2Decimals(refundAmount);
      
      if (refundAmount > 0) {
        refunds += refundAmount;
        refundDetails.push({ date: refundDate, amount: refundAmount });
      }
    }
    refunds = roundTo2Decimals(refunds);
    
    const netSales = roundTo2Decimals(subtotalPrice - totalTax - refunds);
    ourTotal += netSales;
    
    allOrderDetails.push({
      order,
      subtotalPrice,
      totalTax,
      taxFromLines,
      refunds,
      refundDetails,
      netSales,
      taxDiff: Math.abs(totalTax - taxFromLines),
    });
  }
  
  console.log(`Our calculated total: ${ourTotal.toFixed(2)} SEK`);
  console.log(`Difference: ${(ourTotal - SHOPIFY_EXPECTED).toFixed(2)} SEK`);
  console.log('');
  
  // Export detailed CSV for manual inspection
  console.log('='.repeat(80));
  console.log('EXPORTING DETAILED DATA FOR MANUAL INSPECTION');
  console.log('='.repeat(80));
  console.log('');
  
  const fs = require('fs');
  const csvPath = `scripts/data/detailed_orders_${TARGET_DATE.replace(/-/g, '_')}.csv`;
  
  let csv = 'order_name,order_id,created_at,subtotal_price_set,total_tax_set,tax_from_lines,tax_diff,refunds,net_sales,has_refunds,refund_dates\n';
  
  for (const item of allOrderDetails) {
    const refundDates = item.refundDetails.map(r => r.date).join(';');
    csv += `"${item.order.name}","${item.order.id}","${item.order.createdAt}",${item.subtotalPrice.toFixed(2)},${item.totalTax.toFixed(2)},${item.taxFromLines.toFixed(2)},${item.taxDiff.toFixed(2)},${item.refunds.toFixed(2)},${item.netSales.toFixed(2)},${item.refunds > 0 ? 'Yes' : 'No'},"${refundDates}"\n`;
  }
  
  fs.writeFileSync(csvPath, csv, 'utf-8');
  console.log(`✅ Exported to: ${csvPath}`);
  console.log('');
  
  // Try different calculation methods
  console.log('='.repeat(80));
  console.log('TESTING ALL POSSIBLE CALCULATION METHODS');
  console.log('='.repeat(80));
  console.log('');
  
  // Method 1: Our current (subtotalPriceSet - totalTaxSet - refunds)
  let method1 = 0;
  // Method 2: subtotalPriceSet - taxFromLines - refunds
  let method2 = 0;
  // Method 3: subtotalPriceSet - totalTaxSet (no refunds)
  let method3 = 0;
  // Method 4: Check if Shopify might use totalPriceSet instead
  let method4 = 0;
  
  for (const item of allOrderDetails) {
    method1 += item.netSales; // Already calculated
    
    const netSales2 = roundTo2Decimals(item.subtotalPrice - item.taxFromLines - item.refunds);
    method2 += netSales2;
    
    const netSales3 = roundTo2Decimals(item.subtotalPrice - item.totalTax);
    method3 += netSales3;
    
    const totalPrice = item.order.totalPriceSet
      ? parseMoneyAmount(item.order.totalPriceSet.shopMoney.amount)
      : 0;
    const netSales4 = roundTo2Decimals(totalPrice - item.totalTax - item.refunds);
    method4 += netSales4;
  }
  
  method1 = roundTo2Decimals(method1);
  method2 = roundTo2Decimals(method2);
  method3 = roundTo2Decimals(method3);
  method4 = roundTo2Decimals(method4);
  
  console.log('Method 1 (Our current): subtotalPriceSet - totalTaxSet - refunds');
  console.log(`  Total: ${method1.toFixed(2)} SEK`);
  console.log(`  Diff: ${(method1 - SHOPIFY_EXPECTED).toFixed(2)} SEK`);
  console.log('');
  
  console.log('Method 2: subtotalPriceSet - taxFromLines - refunds');
  console.log(`  Total: ${method2.toFixed(2)} SEK`);
  console.log(`  Diff: ${(method2 - SHOPIFY_EXPECTED).toFixed(2)} SEK`);
  console.log('');
  
  console.log('Method 3: subtotalPriceSet - totalTaxSet (ignore refunds)');
  console.log(`  Total: ${method3.toFixed(2)} SEK`);
  console.log(`  Diff: ${(method3 - SHOPIFY_EXPECTED).toFixed(2)} SEK`);
  console.log('');
  
  console.log('Method 4: totalPriceSet - totalTaxSet - refunds');
  console.log(`  Total: ${method4.toFixed(2)} SEK`);
  console.log(`  Diff: ${(method4 - SHOPIFY_EXPECTED).toFixed(2)} SEK`);
  console.log('');
  
  // Summary
  console.log('='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log('');
  console.log('The remaining 749.21 SEK difference cannot be explained by:');
  console.log('  - Using taxLines instead of totalTaxSet (diff: 23.20 SEK)');
  console.log('  - Not subtracting refunds (would be 1491.61 SEK diff)');
  console.log('  - Using totalPriceSet instead of subtotalPriceSet');
  console.log('');
  console.log('Possible explanations:');
  console.log('  1. Shopify has order adjustments that we don\'t see in GraphQL');
  console.log('  2. Shopify excludes some orders that we include');
  console.log('  3. Shopify calculates Net Sales differently for specific edge cases');
  console.log('  4. Multi-currency rounding differences');
  console.log('  5. Gift card payments handled differently');
  console.log('');
  console.log('Next steps:');
  console.log('  - Review exported CSV file for patterns');
  console.log('  - Check Shopify Admin for order adjustments on these orders');
  console.log('  - Verify if Shopify excludes any specific order types');
}

main().catch(console.error);

