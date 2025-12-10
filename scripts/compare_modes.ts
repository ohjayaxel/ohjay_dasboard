#!/usr/bin/env tsx

/**
 * Compare Shopify Mode vs Financial Mode for specified dates
 * 
 * Usage:
 *   pnpm tsx scripts/compare_modes.ts --tenant=skinome --from=2025-11-28 --to=2025-11-30
 */

import { parseArgs } from 'node:util';
import { fetchShopifyDailySales } from '@/lib/data/fetchers';
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
      from: { type: 'string', short: 'f', default: '2025-11-28' },
      to: { type: 'string', short: 'e', default: '2025-11-30' },
    },
  });

  const tenantSlug = args.values.tenant || 'skinome';
  const tenantId = await resolveTenantId(tenantSlug);
  const from = args.values.from || '2025-11-28';
  const to = args.values.to || '2025-11-30';

  console.log(`\n📊 Comparing Sales Modes for tenant: ${tenantSlug}`);
  console.log(`📅 Date range: ${from} to ${to}\n`);

  // Fetch both modes
  const [shopifyMode, financialMode] = await Promise.all([
    fetchShopifyDailySales({ tenantId, from, to, mode: 'shopify', order: 'asc' }),
    fetchShopifyDailySales({ tenantId, from, to, mode: 'financial', order: 'asc' }),
  ]);

  if (shopifyMode.length === 0 && financialMode.length === 0) {
    console.log('⚠️  No data found. Make sure backfill has been run first.');
    console.log('   Run: pnpm tsx scripts/shopify_backfill.ts --tenant=skinome --since=2025-01-01');
    return;
  }

  // Create maps for easier lookup
  const shopifyMap = new Map(shopifyMode.map((r) => [r.date, r]));
  const financialMap = new Map(financialMode.map((r) => [r.date, r]));

  // Get all unique dates
  const allDates = new Set([...shopifyMap.keys(), ...financialMap.keys()]);
  const sortedDates = Array.from(allDates).sort();

  // Summary table
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Date       | Mode      | Net Sales (EXCL tax) | Orders | Difference');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let totalShopifyNet = 0;
  let totalFinancialNet = 0;
  let totalShopifyOrders = 0;
  let totalFinancialOrders = 0;

  for (const date of sortedDates) {
    const shopify = shopifyMap.get(date);
    const financial = financialMap.get(date);

    const shopifyNet = shopify?.net_sales_excl_tax || 0;
    const financialNet = financial?.net_sales_excl_tax || 0;
    const diff = shopifyNet - financialNet;
    const diffPercent = financialNet !== 0 ? ((diff / financialNet) * 100).toFixed(1) : 'N/A';

    if (shopify) {
      totalShopifyNet += shopifyNet;
      totalShopifyOrders += shopify.orders_count;
      console.log(
        `${date} | Shopify   | ${shopifyNet.toFixed(2).padStart(20)} SEK | ${shopify.orders_count.toString().padStart(6)} | ${diff > 0 ? '+' : ''}${diff.toFixed(2)} SEK (${diffPercent}%)`,
      );
    }

    if (financial) {
      totalFinancialNet += financialNet;
      totalFinancialOrders += financial.orders_count;
      console.log(
        `${date} | Financial | ${financialNet.toFixed(2).padStart(20)} SEK | ${financial.orders_count.toString().padStart(6)} |`,
      );
    }

    if (!shopify || !financial) {
      const missingMode = !shopify ? 'Shopify' : 'Financial';
      console.log(`${date} | ${missingMode.padEnd(9)} | (no data)                          |`);
    }

    if (shopify && financial) {
      console.log(`           |           | ${'─'.repeat(20)}`);
    }
  }

  const totalDiff = totalShopifyNet - totalFinancialNet;
  const totalDiffPercent = totalFinancialNet !== 0 ? ((totalDiff / totalFinancialNet) * 100).toFixed(1) : 'N/A';

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`TOTAL      | Shopify   | ${totalShopifyNet.toFixed(2).padStart(20)} SEK | ${totalShopifyOrders.toString().padStart(6)} |`);
  console.log(`           | Financial | ${totalFinancialNet.toFixed(2).padStart(20)} SEK | ${totalFinancialOrders.toString().padStart(6)} |`);
  console.log(`           | DIFF      | ${(totalDiff > 0 ? '+' : '') + totalDiff.toFixed(2).padStart(20)} SEK | ${(totalShopifyOrders - totalFinancialOrders).toString().padStart(6)} | ${totalDiffPercent}%`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Summary explanation
  console.log('📝 Summary:');
  console.log('');
  console.log('Shopify Mode:');
  console.log(`  • Net Sales: ${totalShopifyNet.toFixed(2)} SEK`);
  console.log(`  • Orders: ${totalShopifyOrders}`);
  console.log(`  • Date logic: order.createdAt (Stockholm timezone)`);
  console.log(`  • Includes: cancelled orders, orders without payment`);
  console.log(`  • Matches: Shopify Analytics "Net Sales (excl. tax)"`);
  console.log('');
  console.log('Financial Mode:');
  console.log(`  • Net Sales: ${totalFinancialNet.toFixed(2)} SEK`);
  console.log(`  • Orders: ${totalFinancialOrders}`);
  console.log(`  • Date logic: transaction.processedAt (first successful SALE)`);
  console.log(`  • Excludes: cancelled orders, orders without payment`);
  console.log(`  • Represents: "real money in/out" per day`);
  console.log('');
  console.log(`Difference: ${totalDiff.toFixed(2)} SEK (${totalDiffPercent}%)`);
  console.log(`  • This represents orders that were created but never paid, or were cancelled`);
  console.log(`  • ${totalShopifyOrders - totalFinancialOrders} more orders in Shopify Mode`);
  console.log('');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});

