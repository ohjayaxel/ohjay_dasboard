#!/usr/bin/env tsx
/**
 * Recalculate KPIs from existing shopify_orders in database
 * This is useful when orders have been updated or when KPIs need to be regenerated
 */

import { createClient } from '@supabase/supabase-js';

function loadEnvFile() {
  const fs = require('fs');
  const envFiles = ['.env.local', 'env/local.prod.sh'].filter(Boolean) as string[];
  for (const envFile of envFiles) {
    try {
      const content = fs.readFileSync(envFile, 'utf-8');
      const envVars: Record<string, string> = {};
      content.split('\n').forEach((line: string) => {
        const exportMatch = line.match(/^export\s+(\w+)=(.+)$/);
        const directMatch = line.match(/^(\w+)=(.+)$/);
        const match = exportMatch || directMatch;
        if (match && !line.trim().startsWith('#')) {
          const [, key, value] = match;
          envVars[key] = value.replace(/^["']|["']$/g, '').trim();
        }
      });
      Object.assign(process.env, envVars);
      break;
    } catch {}
  }
}

loadEnvFile();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

type ShopifyOrderRow = {
  tenant_id: string;
  order_id: string;
  processed_at: string | null;
  gross_sales: number | null;
  net_sales: number | null;
  total_price: number | null;
  total_tax: number | null;
  currency: string | null;
  is_new_customer: boolean | null;
  is_refund: boolean | null;
};

function aggregateKpis(rows: ShopifyOrderRow[]) {
  const byDate = new Map<
    string,
    {
      revenue: number;
      total_sales: number; // Total Sales (SUM(line_item.price × quantity)) - stored in gross_sales column
      total_tax: number; // Total tax aggregated
      net_sales: number;
      conversions: number;
      new_customer_conversions: number;
      returning_customer_conversions: number;
      new_customer_net_sales: number;
      returning_customer_net_sales: number;
      currencies: Map<string, number>; // Track currency frequency
    }
  >();

  for (const row of rows) {
    if (!row.processed_at) continue;
    
    // Filter out orders with gross_sales = null or <= 0 (match Orders page logic)
    const grossSalesValue = row.gross_sales ?? 0;
    if (grossSalesValue <= 0) continue;
    
    const existing = byDate.get(row.processed_at) ?? {
      revenue: 0,
      total_sales: 0,
      total_tax: 0,
      net_sales: 0,
      conversions: 0,
      new_customer_conversions: 0,
      returning_customer_conversions: 0,
      new_customer_net_sales: 0,
      returning_customer_net_sales: 0,
      currencies: new Map<string, number>(),
    };

    // Add all orders (both regular orders and refunds) to totals
    existing.revenue += row.total_price ?? 0;
    existing.total_sales += row.gross_sales ?? 0; // gross_sales in shopify_orders is Total Sales
    existing.total_tax += row.total_tax ?? 0;
    const netValue = row.net_sales ?? 0;
    existing.net_sales += netValue;
    
    // Only count conversions for non-refund orders
    if (!row.is_refund) {
      existing.conversions += 1;
      
      // Track currency frequency (use most common currency for the day)
      if (row.currency) {
        const count = existing.currencies.get(row.currency) ?? 0;
        existing.currencies.set(row.currency, count + 1);
      }
      
      if (row.is_new_customer) {
        existing.new_customer_conversions += 1;
        existing.new_customer_net_sales += netValue;
      } else {
        existing.returning_customer_conversions += 1;
        existing.returning_customer_net_sales += netValue;
      }
    }
    byDate.set(row.processed_at, existing);
  }

  return Array.from(byDate.entries()).map(([date, values]) => {
    const aov = values.conversions > 0 ? values.revenue / values.conversions : null;
    
    // Find most common currency for this date
    let mostCommonCurrency: string | null = null;
    let maxCount = 0;
    for (const [currency, count] of values.currencies.entries()) {
      if (count > maxCount) {
        maxCount = count;
        mostCommonCurrency = currency;
      }
    }
    
    // Calculate Gross Sales as Total Sales - Tax (to match Orders page)
    const grossSales = values.total_sales - values.total_tax;
    
    return {
      date,
      spend: 0,
      clicks: null,
      conversions: values.conversions || null,
      revenue: values.revenue || null,
      gross_sales: grossSales || null,
      net_sales: values.net_sales || null,
      new_customer_conversions: values.new_customer_conversions || null,
      returning_customer_conversions: values.returning_customer_conversions || null,
      new_customer_net_sales: values.new_customer_net_sales || null,
      returning_customer_net_sales: values.returning_customer_net_sales || null,
      currency: mostCommonCurrency,
      aov,
      cos: null,
      roas: null,
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const tenantSlugIndex = args.indexOf('--tenant');
  const sinceIndex = args.indexOf('--since');
  const untilIndex = args.indexOf('--until');

  if (tenantSlugIndex === -1 || !args[tenantSlugIndex + 1]) {
    console.error('Usage: pnpm tsx scripts/recalculate_kpis.ts --tenant <slug> --since <YYYY-MM-DD> --until <YYYY-MM-DD>');
    process.exit(1);
  }

  const tenantSlug = args[tenantSlugIndex + 1];
  const since = sinceIndex !== -1 && args[sinceIndex + 1] ? args[sinceIndex + 1] : null;
  const until = untilIndex !== -1 && args[untilIndex + 1] ? args[untilIndex + 1] : null;

  console.log(`[recalculate_kpis] Starting KPI recalculation for tenant: ${tenantSlug}`);
  if (since && until) {
    console.log(`[recalculate_kpis] Period: ${since} to ${until}`);
  }

  // Get tenant
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, name')
    .eq('slug', tenantSlug)
    .single();

  if (tenantError || !tenant) {
    throw new Error(`Tenant not found: ${tenantSlug}`);
  }

  console.log(`[recalculate_kpis] Found tenant: ${tenant.name} (${tenant.id})`);

  // Fetch orders from database
  let ordersQuery = supabase
    .from('shopify_orders')
    .select('tenant_id, order_id, processed_at, gross_sales, net_sales, total_sales, tax, revenue, total_tax, currency, is_new_customer, is_refund')
    .eq('tenant_id', tenant.id)
    .not('processed_at', 'is', null);

  if (since) {
    ordersQuery = ordersQuery.gte('processed_at', since);
  }
  if (until) {
    ordersQuery = ordersQuery.lte('processed_at', until);
  }

  const { data: orders, error: ordersError } = await ordersQuery;

  if (ordersError) {
    throw new Error(`Failed to fetch orders: ${ordersError.message}`);
  }

  if (!orders || orders.length === 0) {
    console.log(`[recalculate_kpis] No orders found for the specified period`);
    return;
  }

  console.log(`[recalculate_kpis] Found ${orders.length} orders in database`);

  // Aggregate KPIs
  const aggregates = aggregateKpis(orders as ShopifyOrderRow[]);
  const kpiRows = aggregates.map((row) => ({
    tenant_id: tenant.id,
    date: row.date,
    source: 'shopify',
    spend: row.spend,
    clicks: row.clicks,
    conversions: row.conversions,
    revenue: row.revenue,
    gross_sales: row.gross_sales,
    net_sales: row.net_sales,
    new_customer_conversions: row.new_customer_conversions,
    returning_customer_conversions: row.returning_customer_conversions,
    new_customer_net_sales: row.new_customer_net_sales,
    returning_customer_net_sales: row.returning_customer_net_sales,
    currency: row.currency,
    aov: row.aov,
    cos: row.cos,
    roas: row.roas,
  }));

  console.log(`\n[recalculate_kpis] Aggregated ${kpiRows.length} KPI rows`);

  // Save KPIs to database
  console.log(`[recalculate_kpis] Upserting KPIs to kpi_daily table...`);
  const { error: kpiError } = await supabase.from('kpi_daily').upsert(kpiRows, {
    onConflict: 'tenant_id,date,source',
  });

  if (kpiError) {
    throw new Error(`Failed to upsert KPIs: ${kpiError.message}`);
  }

  console.log(`[recalculate_kpis] Successfully saved ${kpiRows.length} KPI rows`);

  console.log('\n[recalculate_kpis] ✅ KPI recalculation completed successfully!');
  console.log(`\n[recalculate_kpis] Summary:`);
  console.log(`  - Orders processed: ${orders.length}`);
  console.log(`  - KPI rows created: ${kpiRows.length}`);
  if (since && until) {
    console.log(`  - Date range: ${since} to ${until}`);
  }
}

main().catch((error) => {
  console.error('\n[recalculate_kpis] ❌ Error:', error);
  process.exit(1);
});

