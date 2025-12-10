/**
 * Find the source of remaining 749.21 SEK difference
 * Systematic approach: test different calculation hypotheses
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

function calculateNetSales(order: GraphQLOrder, options: {
  subtractRefunds: boolean;
  subtractSameDayRefunds: boolean;
}): number {
  const subtotalPrice = order.subtotalPriceSet
    ? parseMoneyAmount(order.subtotalPriceSet.shopMoney.amount)
    : 0;
  
  const totalTax = order.totalTaxSet
    ? parseMoneyAmount(order.totalTaxSet.shopMoney.amount)
    : 0;
  
  const netSalesBeforeRefunds = roundTo2Decimals(subtotalPrice - totalTax);
  
  if (!options.subtractRefunds) {
    return netSalesBeforeRefunds;
  }
  
  let refundsToSubtract = 0;
  for (const refund of order.refunds) {
    const refundDate = toLocalDate(refund.createdAt, STORE_TIMEZONE);
    const isSameDay = refundDate === TARGET_DATE;
    
    // Determine if we should subtract this refund
    let shouldSubtract = true;
    if (!options.subtractSameDayRefunds && isSameDay) {
      shouldSubtract = false;
    }
    
    if (shouldSubtract) {
      for (const refundLineItemEdge of refund.refundLineItems.edges) {
        const refundLineItem = refundLineItemEdge.node;
        if (refundLineItem.subtotalSet) {
          refundsToSubtract += parseMoneyAmount(refundLineItem.subtotalSet.shopMoney.amount);
        }
      }
    }
  }
  
  refundsToSubtract = roundTo2Decimals(refundsToSubtract);
  return roundTo2Decimals(netSalesBeforeRefunds - refundsToSubtract);
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
  
  const fetchStartDate = '2025-11-26';
  const fetchEndDate = '2025-11-30';
  
  const orders = await fetchShopifyOrdersGraphQL({
    tenantId: tenant.id,
    shopDomain,
    since: fetchStartDate,
    until: fetchEndDate,
    excludeTest: true,
  });
  
  // Filter by order.createdAt (Shopify method)
  const shopifyOrders = orders.filter(o => {
    const createdDate = toLocalDate(o.createdAt, STORE_TIMEZONE);
    return createdDate === TARGET_DATE;
  });
  
  console.log('='.repeat(80));
  console.log('Testing Different Calculation Methods');
  console.log('='.repeat(80));
  console.log(`Orders by order.createdAt: ${shopifyOrders.length}`);
  console.log(`Shopify Expected: ${SHOPIFY_EXPECTED.toFixed(2)} SEK`);
  console.log('');
  
  // Test different calculation methods
  const methods = [
    { name: 'Subtract ALL refunds', subtractRefunds: true, subtractSameDayRefunds: true },
    { name: 'Don\'t subtract same-day refunds', subtractRefunds: true, subtractSameDayRefunds: false },
    { name: 'Don\'t subtract any refunds', subtractRefunds: false, subtractSameDayRefunds: false },
  ];
  
  for (const method of methods) {
    let total = 0;
    
    for (const order of shopifyOrders) {
      const netSales = calculateNetSales(order, method);
      total += netSales;
    }
    
    const diff = Math.abs(total - SHOPIFY_EXPECTED);
    console.log(`${method.name}:`);
    console.log(`  Total: ${total.toFixed(2)} SEK`);
    console.log(`  Diff from expected: ${diff.toFixed(2)} SEK`);
    console.log('');
  }
  
  // Find orders with same-day refunds
  console.log('='.repeat(80));
  console.log('ORDERS WITH REFUNDS ON CREATION DAY');
  console.log('='.repeat(80));
  console.log('');
  
  const sameDayRefundOrders = [];
  for (const order of shopifyOrders) {
    const createdDate = toLocalDate(order.createdAt, STORE_TIMEZONE);
    const hasSameDayRefund = order.refunds.some(refund => {
      const refundDate = toLocalDate(refund.createdAt, STORE_TIMEZONE);
      return refundDate === createdDate;
    });
    
    if (hasSameDayRefund) {
      const calcAll = calculateNetSales(order, { subtractRefunds: true, subtractSameDayRefunds: true });
      const calcNoSameDay = calculateNetSales(order, { subtractRefunds: true, subtractSameDayRefunds: false });
      const diff = calcAll - calcNoSameDay;
      
      sameDayRefundOrders.push({ order, calcAll, calcNoSameDay, diff });
    }
  }
  
  if (sameDayRefundOrders.length > 0) {
    console.log(`Found ${sameDayRefundOrders.length} orders with refunds on creation day:\n`);
    
    for (const item of sameDayRefundOrders) {
      console.log(`Order: ${item.order.name}`);
      console.log(`  Created: ${toLocalDate(item.order.createdAt, STORE_TIMEZONE)}`);
      console.log(`  If subtract same-day refunds: ${item.calcAll.toFixed(2)} SEK`);
      console.log(`  If DON'T subtract same-day refunds: ${item.calcNoSameDay.toFixed(2)} SEK`);
      console.log(`  Difference: ${item.diff.toFixed(2)} SEK`);
      console.log('');
    }
  } else {
    console.log('No orders with refunds on creation day found.\n');
  }
  
  // Detailed analysis of all orders to find the discrepancy
  console.log('='.repeat(80));
  console.log('DETAILED ORDER ANALYSIS');
  console.log('='.repeat(80));
  console.log('');
  console.log('Finding orders that might explain the difference...\n');
  
  // Calculate with "subtract all refunds" method
  const orderDetails = [];
  let totalWithAllRefunds = 0;
  
  for (const order of shopifyOrders) {
    const subtotalPrice = order.subtotalPriceSet
      ? parseMoneyAmount(order.subtotalPriceSet.shopMoney.amount)
      : 0;
    const totalTax = order.totalTaxSet
      ? parseMoneyAmount(order.totalTaxSet.shopMoney.amount)
      : 0;
    
    let allRefunds = 0;
    let sameDayRefunds = 0;
    
    for (const refund of order.refunds) {
      const refundDate = toLocalDate(refund.createdAt, STORE_TIMEZONE);
      let refundAmount = 0;
      
      for (const refundLineItemEdge of refund.refundLineItems.edges) {
        const refundLineItem = refundLineItemEdge.node;
        if (refundLineItem.subtotalSet) {
          refundAmount += parseMoneyAmount(refundLineItem.subtotalSet.shopMoney.amount);
        }
      }
      
      allRefunds += refundAmount;
      if (refundDate === TARGET_DATE) {
        sameDayRefunds += refundAmount;
      }
    }
    
    allRefunds = roundTo2Decimals(allRefunds);
    sameDayRefunds = roundTo2Decimals(sameDayRefunds);
    
    const netSalesWithAllRefunds = roundTo2Decimals(subtotalPrice - totalTax - allRefunds);
    const netSalesWithoutSameDay = roundTo2Decimals(subtotalPrice - totalTax - (allRefunds - sameDayRefunds));
    
    totalWithAllRefunds += netSalesWithAllRefunds;
    
    orderDetails.push({
      order,
      subtotalPrice,
      totalTax,
      allRefunds,
      sameDayRefunds,
      netSalesWithAllRefunds,
      netSalesWithoutSameDay,
    });
  }
  
  console.log(`Total with all refunds subtracted: ${totalWithAllRefunds.toFixed(2)} SEK`);
  console.log(`Expected: ${SHOPIFY_EXPECTED.toFixed(2)} SEK`);
  console.log(`Difference: ${(totalWithAllRefunds - SHOPIFY_EXPECTED).toFixed(2)} SEK`);
  console.log('');
  
  // Find orders where not subtracting same-day refunds would help
  const potentialAdjustment = orderDetails
    .filter(d => d.sameDayRefunds > 0)
    .reduce((sum, d) => sum + d.sameDayRefunds, 0);
  
  console.log(`Total same-day refunds: ${potentialAdjustment.toFixed(2)} SEK`);
  console.log(`If we don't subtract same-day refunds: ${(totalWithAllRefunds + potentialAdjustment).toFixed(2)} SEK`);
  console.log(`Diff from expected: ${Math.abs(totalWithAllRefunds + potentialAdjustment - SHOPIFY_EXPECTED).toFixed(2)} SEK`);
}

main().catch(console.error);



