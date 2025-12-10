#!/usr/bin/env tsx

/**
 * Verification script for Shopify Mode
 * 
 * Compares our calculated daily sales (Shopify Mode) against Shopify Analytics
 * for specified dates to verify 1:1 matching.
 * 
 * Usage:
 *   pnpm tsx scripts/verify_shopify_mode.ts --tenant=skinome --date=2025-11-30
 *   pnpm tsx scripts/verify_shopify_mode.ts --tenant=skinome --dates=2025-11-28,2025-11-29,2025-11-30
 */

import { parseArgs } from 'node:util';
import { fetchShopifyOrdersGraphQL } from '@/lib/integrations/shopify-graphql';
import { calculateDailySales } from '@/lib/shopify/sales';
import { convertGraphQLOrderToShopifyOrder } from '@/lib/shopify/order-converter';
import { getShopifyConnection } from '@/lib/integrations/shopify';
import { resolveTenantId } from '@/lib/tenants/resolve-tenant';

// Load environment variables
import { readFileSync } from 'fs';

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
    // Default: test dates from previous analysis
    dates = ['2025-11-28', '2025-11-29', '2025-11-30'];
  }

  // Get Shopify connection
  const connection = await getShopifyConnection(tenantId);
  if (!connection?.meta?.store_domain) {
    throw new Error(`No Shopify connection found for tenant ${tenantSlug}`);
  }

  const shopDomain = connection.meta.store_domain;

  console.log(`\n🔍 Verifying Shopify Mode for tenant: ${tenantSlug}`);
  console.log(`📅 Dates to verify: ${dates.join(', ')}\n`);

  const results: Array<{
    date: string;
    shopifyExpected: number | null;
    ourShopifyMode: number;
    diff: number;
    ordersCount: number;
    match: boolean;
  }> = [];

  for (const dateStr of dates) {
    console.log(`\n📊 Verifying ${dateStr}...`);

    // Fetch orders with wider range to ensure we get all relevant orders
    // (orders created on this date might have transactions on different dates)
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

    // Convert to ShopifyOrder format
    const shopifyOrders = graphqlOrders
      .filter((o) => !o.test)
      .map(convertGraphQLOrderToShopifyOrder);

    // Calculate daily sales in Shopify Mode
    const shopifyModeDaily = calculateDailySales(shopifyOrders, 'shopify', 'Europe/Stockholm');

    // Find the row for this date
    const dateRow = shopifyModeDaily.find((row) => row.date === dateStr);

    if (!dateRow) {
      console.log(`  ⚠️  No data found for ${dateStr}`);
      results.push({
        date: dateStr,
        shopifyExpected: null,
        ourShopifyMode: 0,
        diff: 0,
        ordersCount: 0,
        match: false,
      });
      continue;
    }

    const ourNetSales = dateRow.netSalesExclTax;
    const ordersCount = dateRow.ordersCount;

    console.log(`  ✅ Our Shopify Mode:`);
    console.log(`     Net Sales (EXCL tax): ${ourNetSales.toFixed(2)} SEK`);
    console.log(`     Orders: ${ordersCount}`);
    console.log(`     Gross Sales (EXCL tax): ${dateRow.grossSalesExclTax?.toFixed(2) || 'N/A'} SEK`);
    console.log(`     Discounts (EXCL tax): ${dateRow.discountsExclTax?.toFixed(2) || 'N/A'} SEK`);
    console.log(`     Returns (EXCL tax): ${dateRow.refundsExclTax?.toFixed(2) || 'N/A'} SEK`);

    // Prompt user for Shopify Analytics value (or skip if not provided)
    console.log(`\n  📝 Enter Net Sales (EXCL tax) from Shopify Analytics for ${dateStr}, or press Enter to skip:`);

    // For non-interactive mode, just show our values
    // In interactive mode, you would read from stdin
    console.log(`  ℹ️  Please compare with Shopify Analytics manually:`);
    console.log(`     Expected: (from Shopify Analytics)`);
    console.log(`     Our value: ${ourNetSales.toFixed(2)} SEK`);

    results.push({
      date: dateStr,
      shopifyExpected: null, // Would be filled in interactive mode
      ourShopifyMode: ourNetSales,
      diff: 0,
      ordersCount,
      match: false,
    });
  }

  // Summary
  console.log(`\n\n📋 Verification Summary:`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Date          | Our Net Sales | Orders | Status`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  for (const result of results) {
    const status = result.shopifyExpected !== null
      ? (Math.abs(result.diff) < 0.01 ? '✅ MATCH' : `❌ DIFF: ${result.diff.toFixed(2)}`)
      : '⏸️  PENDING';
    console.log(
      `${result.date} | ${result.ourShopifyMode.toFixed(2).padStart(13)} SEK | ${result.ordersCount.toString().padStart(6)} | ${status}`,
    );
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  console.log(`\n✅ Verification complete!`);
  console.log(`\nNext steps:`);
  console.log(`1. Compare "Our Net Sales" values with Shopify Analytics`);
  console.log(`2. Differences should be 0 or rounding (< 0.01 SEK)`);
  console.log(`3. If differences are larger, check:`);
  console.log(`   - Date grouping logic (order.createdAt vs refund.processedAt)`);
  console.log(`   - Order filtering (test orders, cancelled orders)`);
  console.log(`   - Refund handling (refund.processedAt date)`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});


