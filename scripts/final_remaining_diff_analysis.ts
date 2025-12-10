/**
 * Final analysis to pinpoint remaining 749.21 SEK
 * Order-by-order comparison to find calculation differences
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
  
  // Filter by order.createdAt (Shopify method)
  const shopifyOrders = orders.filter(o => {
    const createdDate = toLocalDate(o.createdAt, STORE_TIMEZONE);
    return createdDate === TARGET_DATE;
  });
  
  console.log('='.repeat(80));
  console.log('Final Analysis: Remaining 749.21 SEK');
  console.log('='.repeat(80));
  console.log(`Orders by order.createdAt: ${shopifyOrders.length}`);
  console.log(`Shopify Expected: ${SHOPIFY_EXPECTED.toFixed(2)} SEK`);
  console.log('');
  
  // Calculate our way
  let ourTotal = 0;
  const orderCalcs = [];
  
  for (const order of shopifyOrders) {
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
    refunds = roundTo2Decimals(refunds);
    
    const netSales = roundTo2Decimals(subtotalPrice - totalTax - refunds);
    ourTotal += netSales;
    
    orderCalcs.push({
      order,
      subtotalPrice,
      totalTax,
      refunds,
      netSales,
    });
  }
  
  console.log(`Our calculated total: ${ourTotal.toFixed(2)} SEK`);
  console.log(`Difference: ${(ourTotal - SHOPIFY_EXPECTED).toFixed(2)} SEK`);
  console.log('');
  
  // The difference is 749.21 SEK - we need to find where it comes from
  // Hypothesis: Maybe Shopify doesn't use subtotalPriceSet - totalTaxSet?
  // Maybe Shopify uses a different calculation?
  
  // Let's check if there are orders without totalTaxSet (we fall back to summing taxLines)
  console.log('='.repeat(80));
  console.log('CHECKING FOR CALCULATION DIFFERENCES');
  console.log('='.repeat(80));
  console.log('');
  
  const ordersWithoutTotalTaxSet = orderCalcs.filter(c => {
    return !c.order.totalTaxSet;
  });
  
  if (ordersWithoutTotalTaxSet.length > 0) {
    console.log(`Found ${ordersWithoutTotalTaxSet.length} orders without totalTaxSet:`);
    for (const item of ordersWithoutTotalTaxSet.slice(0, 5)) {
      console.log(`  - ${item.order.name}: ${item.netSales.toFixed(2)} SEK`);
    }
    console.log('');
  }
  
  // Check orders with large Net Sales that might have rounding issues
  orderCalcs.sort((a, b) => Math.abs(b.netSales) - Math.abs(a.netSales));
  
  console.log('Top 20 orders by Net Sales:');
  console.log('');
  
  let cumulativeTotal = 0;
  for (let i = 0; i < Math.min(20, orderCalcs.length); i++) {
    const item = orderCalcs[i];
    cumulativeTotal += item.netSales;
    
    console.log(`${i + 1}. ${item.order.name}: ${item.netSales.toFixed(2)} SEK`);
    console.log(`   subtotalPriceSet: ${item.subtotalPrice.toFixed(2)}`);
    console.log(`   totalTaxSet: ${item.totalTax.toFixed(2)}`);
    console.log(`   refunds: ${item.refunds.toFixed(2)}`);
    
    // Check if there might be a calculation difference
    // Maybe Shopify calculates differently?
    
    console.log('');
  }
  
  console.log(`Cumulative total (top 20): ${cumulativeTotal.toFixed(2)} SEK`);
  console.log(`Remaining orders total: ${(ourTotal - cumulativeTotal).toFixed(2)} SEK`);
  console.log('');
  
  // Try a different approach: maybe Shopify uses a simpler calculation?
  // Test: subtotalPriceSet - manually calculated tax (from taxLines)
  console.log('='.repeat(80));
  console.log('TESTING ALTERNATIVE CALCULATIONS');
  console.log('='.repeat(80));
  console.log('');
  
  let totalUsingTaxLines = 0;
  let totalUsingTotalTaxSet = 0;
  
  for (const item of orderCalcs) {
    // Method 1: Use totalTaxSet (what we do now)
    const netSales1 = roundTo2Decimals(item.subtotalPrice - item.totalTax - item.refunds);
    totalUsingTotalTaxSet += netSales1;
    
    // Method 2: Calculate tax from taxLines
    let taxFromLines = 0;
    for (const edge of item.order.lineItems.edges) {
      const lineItem = edge.node;
      if (lineItem.taxLines && lineItem.taxLines.length > 0) {
        for (const taxLine of lineItem.taxLines) {
          taxFromLines += parseMoneyAmount(taxLine.priceSet.shopMoney.amount);
        }
      }
    }
    taxFromLines = roundTo2Decimals(taxFromLines);
    const netSales2 = roundTo2Decimals(item.subtotalPrice - taxFromLines - item.refunds);
    totalUsingTaxLines += netSales2;
  }
  
  console.log(`Using totalTaxSet: ${totalUsingTotalTaxSet.toFixed(2)} SEK`);
  console.log(`Diff from expected: ${(totalUsingTotalTaxSet - SHOPIFY_EXPECTED).toFixed(2)} SEK`);
  console.log('');
  
  console.log(`Using taxLines (sum): ${totalUsingTaxLines.toFixed(2)} SEK`);
  console.log(`Diff from expected: ${(totalUsingTaxLines - SHOPIFY_EXPECTED).toFixed(2)} SEK`);
  console.log('');
  
  const diffBetweenMethods = Math.abs(totalUsingTotalTaxSet - totalUsingTaxLines);
  console.log(`Difference between methods: ${diffBetweenMethods.toFixed(2)} SEK`);
  console.log('');
  
  // If the difference is close to 749.21, that might be it!
  if (Math.abs(diffBetweenMethods - 749.21) < 10) {
    console.log('⚠️  Possible match! The difference might come from using taxLines vs totalTaxSet');
    console.log('');
    
    // Find orders where the two methods differ
    const differingOrders = [];
    for (const item of orderCalcs) {
      let taxFromLines = 0;
      for (const edge of item.order.lineItems.edges) {
        const lineItem = edge.node;
        if (lineItem.taxLines && lineItem.taxLines.length > 0) {
          for (const taxLine of lineItem.taxLines) {
            taxFromLines += parseMoneyAmount(taxLine.priceSet.shopMoney.amount);
          }
        }
      }
      taxFromLines = roundTo2Decimals(taxFromLines);
      
      const diff = Math.abs(item.totalTax - taxFromLines);
      if (diff > 0.01) {
        differingOrders.push({
          order: item.order,
          totalTaxSet: item.totalTax,
          taxFromLines,
          diff,
        });
      }
    }
    
    if (differingOrders.length > 0) {
      console.log(`Found ${differingOrders.length} orders where totalTaxSet != sum(taxLines):`);
      differingOrders.sort((a, b) => b.diff - a.diff);
      
      for (const item of differingOrders.slice(0, 10)) {
        console.log(`  - ${item.order.name}:`);
        console.log(`    totalTaxSet: ${item.totalTaxSet.toFixed(2)} SEK`);
        console.log(`    sum(taxLines): ${item.taxFromLines.toFixed(2)} SEK`);
        console.log(`    diff: ${item.diff.toFixed(2)} SEK`);
        console.log('');
      }
    }
  }
}

main().catch(console.error);


