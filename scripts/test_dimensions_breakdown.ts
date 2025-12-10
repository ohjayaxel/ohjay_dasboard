#!/usr/bin/env tsx

/**
 * Test script to verify breakdown by product, country, and customer type
 * 
 * Usage:
 *   pnpm tsx scripts/test_dimensions_breakdown.ts --tenant=skinome --date=2025-11-30
 *   pnpm tsx scripts/test_dimensions_breakdown.ts --tenant=skinome --dates=2025-11-28,2025-11-29,2025-11-30
 */

import { parseArgs } from 'node:util';
import { readFileSync } from 'fs';
import { fetchShopifyOrdersGraphQL, type GraphQLOrder } from '@/lib/integrations/shopify-graphql';
import { getShopifyConnection } from '@/lib/integrations/shopify';
import { resolveTenantId } from '@/lib/tenants/resolve-tenant';

// Load environment variables
function loadEnvFile() {
  const envFile = process.env.ENV_FILE || 'env/local.prod.sh';
  try {
    const content = readFileSync(envFile, 'utf-8');
    const envVars: Record<string, string> = {};
    content.split('\n').forEach((line) => {
      const match = line.match(/^export\s+(\w+)=(.+)$/);
      if (match) {
        const [, key, value] = match;
        envVars[key] = value.replace(/^["']|["']$/g, '');
      }
    });
    Object.assign(process.env, envVars);
  } catch (error) {
    // Use existing env vars
  }
}

loadEnvFile();

interface DimensionBreakdown {
  date: string;
  productSku: string | null;
  productTitle: string | null;
  country: string | null;
  customerType: 'NEW' | 'RETURNING' | 'GUEST';
  ordersCount: number;
  netSalesExclTax: number;
  grossSalesExclTax: number;
  discountsExclTax: number;
  refundsExclTax: number;
  tax: number;
}

async function main() {
  const args = parseArgs({
    options: {
      tenant: { type: 'string', short: 't', default: 'skinome' },
      date: { type: 'string', short: 'd' },
      dates: { type: 'string' },
    },
  });

  const tenantSlug = args.values.tenant || 'skinome';
  const tenantId = await resolveTenantId(tenantSlug);

  // Parse dates
  let dates: string[] = [];
  if (args.values.dates) {
    dates = args.values.dates.split(',').map((d) => d.trim());
  } else if (args.values.date) {
    dates = [args.values.date];
  } else {
    dates = ['2025-11-28', '2025-11-29', '2025-11-30'];
  }

  // Get Shopify connection
  const connection = await getShopifyConnection(tenantId);
  if (!connection?.meta?.store_domain) {
    throw new Error(`No Shopify connection found for tenant ${tenantSlug}`);
  }

  const shopDomain = connection.meta.store_domain;

  console.log(`\n🔍 Testing Dimension Breakdown for tenant: ${tenantSlug}`);
  console.log(`📅 Dates: ${dates.join(', ')}\n`);

  const allBreakdowns: DimensionBreakdown[] = [];

  for (const dateStr of dates) {
    console.log(`\n📊 Processing ${dateStr}...`);

    // Fetch orders with wider range
    const date = new Date(dateStr);
    const startDate = new Date(date);
    startDate.setDate(startDate.getDate() - 1);
    const endDate = new Date(date);
    endDate.setDate(endDate.getDate() + 1);

    const graphqlOrders = await fetchShopifyOrdersGraphQL({
      tenantId,
      shopDomain,
      since: startDate.toISOString().slice(0, 10),
      until: endDate.toISOString().slice(0, 10),
      excludeTest: true,
    });

    // Filter orders that contribute to this date in Shopify Mode (order.createdAt)
    const ordersForDate = graphqlOrders.filter((order) => {
      if (order.test) return false;
      const orderCreatedDate = new Date(order.createdAt).toLocaleDateString('en-CA', {
        timeZone: 'Europe/Stockholm',
      });
      return orderCreatedDate === dateStr;
    });

    console.log(`  Found ${ordersForDate.length} orders for ${dateStr}`);

    // Aggregate by dimensions
    const breakdownMap = new Map<string, DimensionBreakdown>();

    for (const order of ordersForDate) {
      // Determine customer type
      let customerType: 'NEW' | 'RETURNING' | 'GUEST' = 'GUEST';
      if (order.customer?.id) {
        const numberOfOrders = parseInt(order.customer.numberOfOrders || '0', 10);
        if (numberOfOrders === 1) {
          customerType = 'NEW';
        } else if (numberOfOrders > 1) {
          customerType = 'RETURNING';
        }
      }

      // Get country (prefer countryCode, fallback to country name)
      const country =
        order.billingAddress?.countryCode?.toUpperCase() ||
        order.billingAddress?.country ||
        order.shippingAddress?.countryCode?.toUpperCase() ||
        order.shippingAddress?.country ||
        null;

      // Calculate order-level totals (INCL tax)
      const subtotalPrice = parseFloat(order.subtotalPriceSet?.shopMoney?.amount || '0'); // After discounts, INCL tax
      const totalTax = parseFloat(order.totalTaxSet?.shopMoney?.amount || '0');
      const totalDiscountsInclTax = parseFloat(order.totalDiscountsSet?.shopMoney?.amount || '0');
      
      // Net Sales EXCL tax BEFORE refunds (Shopify method)
      const netSalesExclTaxBeforeRefunds = subtotalPrice - totalTax;
      
      // Calculate Gross Sales INCL tax: sum of all original line item prices
      let grossSalesInclTax = 0;
      for (const lineItemEdge of order.lineItems.edges || []) {
        const lineItem = lineItemEdge.node;
        const unitPriceInclTax = parseFloat(lineItem.originalUnitPriceSet?.shopMoney?.amount || '0');
        const quantity = lineItem.quantity || 0;
        grossSalesInclTax += unitPriceInclTax * quantity;
      }
      
      // Discounts EXCL tax:
      // Convert from INCL to EXCL tax using tax rate on subtotal
      // Discounts EXCL tax = Discounts INCL tax / (1 + tax_rate)
      let discountsExclTax = 0;
      if (subtotalPrice > 0 && totalTax > 0) {
        const taxRateOnSubtotal = totalTax / subtotalPrice;
        discountsExclTax = totalDiscountsInclTax / (1 + taxRateOnSubtotal);
      } else {
        // No tax, discounts are already EXCL tax
        discountsExclTax = totalDiscountsInclTax;
      }
      
      // Calculate total refunds for this order (EXCL tax) - needed for Gross Sales calculation
      let orderTotalRefundsExclTax = 0;
      for (const refund of order.refunds || []) {
        for (const refundEdge of refund.refundLineItems.edges || []) {
          const refundAmount = parseFloat(
            refundEdge.node.subtotalSet?.shopMoney?.amount || '0',
          );
          orderTotalRefundsExclTax += refundAmount;
        }
      }
      
      // Gross Sales EXCL tax calculation:
      // We know: Net Sales EXCL tax (after refunds) = Gross Sales EXCL tax - Discounts EXCL tax - Returns EXCL tax
      // Therefore: Gross Sales EXCL tax = Net Sales EXCL tax (after refunds) + Discounts EXCL tax + Returns EXCL tax
      // But Gross Sales is not affected by refunds, so we use netSalesExclTaxAfterRefunds
      const netSalesExclTaxAfterRefunds = netSalesExclTaxBeforeRefunds - orderTotalRefundsExclTax;
      const grossSalesExclTax = netSalesExclTaxAfterRefunds + discountsExclTax + orderTotalRefundsExclTax;

      // Calculate total line item values for proportioning
      let totalLineItemGrossSalesInclTax = 0;
      const lineItemData: Array<{
        lineItem: typeof order.lineItems.edges[0]['node'];
        grossSalesInclTax: number;
        discountsInclTax: number;
        tax: number;
      }> = [];

      for (const lineItemEdge of order.lineItems.edges || []) {
        const lineItem = lineItemEdge.node;
        
        // Gross Sales INCL tax per line item
        const unitPriceInclTax = parseFloat(lineItem.originalUnitPriceSet?.shopMoney?.amount || '0');
        const quantity = lineItem.quantity || 0;
        const lineGrossSalesInclTax = unitPriceInclTax * quantity;
        
        // Discounts INCL tax per line item
        let lineDiscountsInclTax = 0;
        for (const allocation of lineItem.discountAllocations || []) {
          lineDiscountsInclTax += parseFloat(allocation.allocatedAmountSet?.shopMoney?.amount || '0');
        }
        
        // Tax per line item
        let lineTax = 0;
        for (const taxLine of lineItem.taxLines || []) {
          lineTax += parseFloat(taxLine.priceSet?.shopMoney?.amount || '0');
        }
        
        totalLineItemGrossSalesInclTax += lineGrossSalesInclTax;
        lineItemData.push({
          lineItem,
          grossSalesInclTax: lineGrossSalesInclTax,
          discountsInclTax: lineDiscountsInclTax,
          tax: lineTax,
        });
      }

      // netSalesExclTaxAfterRefunds is now calculated above in Gross Sales section
      const grossSalesProportionFactor = totalLineItemGrossSalesInclTax > 0 
        ? grossSalesExclTax / totalLineItemGrossSalesInclTax
        : 0;
      
      // For discounts, proportion based on line item discounts
      let totalLineItemDiscountsInclTax = 0;
      for (const item of lineItemData) {
        totalLineItemDiscountsInclTax += item.discountsInclTax;
      }
      
      const discountsProportionFactor = totalLineItemDiscountsInclTax > 0
        ? discountsExclTax / totalLineItemDiscountsInclTax
        : 0;
      
      // For net sales, proportion based on line item values
      // Use the same proportion as gross sales since net = gross - discounts - refunds
      const netSalesProportionFactor = totalLineItemGrossSalesInclTax > 0 && grossSalesExclTax > 0
        ? netSalesExclTaxAfterRefunds / grossSalesExclTax
        : 0;

      // Process line items
      for (const { lineItem, grossSalesInclTax: lineGrossSalesInclTax, discountsInclTax: lineDiscountsInclTax, tax: lineTax } of lineItemData) {
        const productSku = lineItem.sku || null;
        const productTitle = lineItem.name || null;

        // Proportion Gross Sales EXCL tax to this line item
        const grossSalesExclTaxForLine = lineGrossSalesInclTax * grossSalesProportionFactor;
        
        // Proportion Discounts EXCL tax to this line item
        const discountsExclTaxForLine = lineDiscountsInclTax * discountsProportionFactor;

        // Get refunds for this specific line item (already EXCL tax)
        let refundsExclTax = 0;
        for (const refund of order.refunds || []) {
          for (const refundEdge of refund.refundLineItems.edges || []) {
            if (refundEdge.node.lineItem?.id === lineItem.id) {
              const refundAmount = parseFloat(
                refundEdge.node.subtotalSet?.shopMoney?.amount || '0',
              );
              refundsExclTax += refundAmount;
            }
          }
        }

        // Calculate Net Sales for this line item
        // Use proportioned order-level net sales BEFORE refunds, then subtract line item refunds
        // Proportion factor: line item's share of gross sales (EXCL tax)
        const lineItemShareOfGrossSales = totalLineItemGrossSalesInclTax > 0
          ? grossSalesExclTaxForLine / grossSalesExclTax
          : 0;
        
        // Proportion order-level net sales (before refunds) to this line item
        const lineItemNetExclTaxBeforeRefunds = netSalesExclTaxBeforeRefunds * lineItemShareOfGrossSales;
        
        // Subtract refunds for this specific line item
        const finalNetSales = lineItemNetExclTaxBeforeRefunds - refundsExclTax;

        // Create key for aggregation
        const key = `${dateStr}|${productSku || 'NO_SKU'}|${country || 'NO_COUNTRY'}|${customerType}`;

        if (!breakdownMap.has(key)) {
          breakdownMap.set(key, {
            date: dateStr,
            productSku,
            productTitle,
            country,
            customerType,
            ordersCount: 0,
            netSalesExclTax: 0,
            grossSalesExclTax: 0,
            discountsExclTax: 0,
            refundsExclTax: 0,
            tax: 0,
          });
        }

        const breakdown = breakdownMap.get(key)!;
        breakdown.ordersCount += 1;
        breakdown.grossSalesExclTax += grossSalesExclTaxForLine;
        breakdown.discountsExclTax += discountsExclTaxForLine;
        breakdown.refundsExclTax += refundsExclTax;
        breakdown.netSalesExclTax += finalNetSales;
        breakdown.tax += lineTax;
      }
    }

    allBreakdowns.push(...Array.from(breakdownMap.values()));
  }

  // Display results
  console.log(`\n\n📊 Dimension Breakdown Results:\n`);
  const separator = '─'.repeat(150);
  console.log(separator);
  console.log(
    `Date       | Product SKU           | Country | Customer Type | Orders | Net Sales (EXCL tax) | Gross Sales | Discounts | Returns`,
  );
  console.log(separator);

  // Sort the breakdowns
  const sortedBreakdowns = allBreakdowns.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.productSku !== b.productSku) return (a.productSku || '').localeCompare(b.productSku || '');
    if (a.country !== b.country) return (a.country || '').localeCompare(b.country || '');
    return a.customerType.localeCompare(b.customerType);
  });

  // Group and display
  for (const breakdown of sortedBreakdowns) {
    const sku = (breakdown.productSku || 'NO_SKU').padEnd(20).substring(0, 20);
    const country = (breakdown.country || 'NO_COUNTRY').padEnd(7).substring(0, 7);
    const customerType = breakdown.customerType.padEnd(13).substring(0, 13);
    const orders = breakdown.ordersCount.toString().padStart(6);
    const netSales = breakdown.netSalesExclTax.toFixed(2).padStart(18);
    const grossSales = breakdown.grossSalesExclTax.toFixed(2).padStart(12);
    const discounts = breakdown.discountsExclTax.toFixed(2).padStart(10);
    const returns = breakdown.refundsExclTax.toFixed(2).padStart(8);

    console.log(
      `${breakdown.date} | ${sku} | ${country} | ${customerType} | ${orders} | ${netSales} SEK | ${grossSales} SEK | ${discounts} SEK | ${returns} SEK`,
    );
  }

  // Summary totals
  const totalNetSales = allBreakdowns.reduce((sum, b) => sum + b.netSalesExclTax, 0);
  const totalGrossSales = allBreakdowns.reduce((sum, b) => sum + b.grossSalesExclTax, 0);
  const totalDiscounts = allBreakdowns.reduce((sum, b) => sum + b.discountsExclTax, 0);
  const totalReturns = allBreakdowns.reduce((sum, b) => sum + b.refundsExclTax, 0);
  
  // Count unique orders (aggregate from all breakdowns by date)
  const uniqueOrderIds = new Set<string>();
  for (const dateStr of dates) {
    // Re-fetch to count orders (simplified - we'll count from breakdown instead)
  }
  
  // Count unique order+date combinations from breakdowns
  const totalOrders = new Set(
    allBreakdowns.map((b) => `${b.date}-${b.productSku}-${b.country}-${b.customerType}`),
  ).size;

  console.log(separator);
  console.log(`\n📊 Summary Totals:`);
  console.log(`  Net Sales (EXCL tax): ${totalNetSales.toFixed(2)} SEK`);
  console.log(`  Gross Sales (EXCL tax): ${totalGrossSales.toFixed(2)} SEK`);
  console.log(`  Discounts (EXCL tax): ${totalDiscounts.toFixed(2)} SEK`);
  console.log(`  Returns (EXCL tax): ${totalReturns.toFixed(2)} SEK`);
  console.log(`  Total Orders: ${totalOrders}`);
  console.log(`  Total Line Items: ${allBreakdowns.reduce((sum, b) => sum + b.ordersCount, 0)}`);

  // Aggregations by dimension
  console.log(`\n📊 Breakdown by Customer Type:`);
  const byCustomerType = new Map<'NEW' | 'RETURNING' | 'GUEST', { netSales: number; orders: number }>();
  for (const breakdown of allBreakdowns) {
    const existing = byCustomerType.get(breakdown.customerType) || { netSales: 0, orders: 0 };
    existing.netSales += breakdown.netSalesExclTax;
    existing.orders += breakdown.ordersCount;
    byCustomerType.set(breakdown.customerType, existing);
  }
  for (const [type, data] of Array.from(byCustomerType.entries()).sort()) {
    console.log(`  ${type.padEnd(13)}: ${data.netSales.toFixed(2)} SEK (${data.orders} line items)`);
  }

  console.log(`\n📊 Breakdown by Country:`);
  const byCountry = new Map<string | null, { netSales: number; orders: number }>();
  for (const breakdown of allBreakdowns) {
    const key = breakdown.country || 'NO_COUNTRY';
    const existing = byCountry.get(key) || { netSales: 0, orders: 0 };
    existing.netSales += breakdown.netSalesExclTax;
    existing.orders += breakdown.ordersCount;
    byCountry.set(key, existing);
  }
  for (const [country, data] of Array.from(byCountry.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${(country || 'NO_COUNTRY').padEnd(10)}: ${data.netSales.toFixed(2)} SEK (${data.orders} line items)`);
  }

  console.log(`\n✅ Breakdown complete!\n`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
