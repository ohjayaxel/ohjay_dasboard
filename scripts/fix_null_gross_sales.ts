#!/usr/bin/env tsx

/**
 * Fix orders with gross_sales=null but total_price > 0
 * This script updates existing orders to set gross_sales from total_price
 */

import { ArgumentParser } from 'argparse';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const parser = new ArgumentParser({
    description: 'Fix orders with gross_sales=null but total_price > 0',
  });
  parser.add_argument('--tenant', {
    help: 'Tenant slug',
    required: true,
  });
  parser.add_argument('--since', {
    help: 'Start date (YYYY-MM-DD)',
    required: false,
  });
  parser.add_argument('--until', {
    help: 'End date (YYYY-MM-DD)',
    required: false,
  });
  parser.add_argument('--dry-run', {
    action: 'store_true',
    help: 'Dry run - show what would be updated',
  });

  const args = parser.parse_args();
  const tenantSlug = args.tenant;
  const since = args.since;
  const until = args.until;

  console.log(`[fix_null_gross_sales] Starting fix for tenant: ${tenantSlug}`);
  if (since) {
    console.log(`[fix_null_gross_sales] Date range: ${since} to ${until || since}`);
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

  console.log(`[fix_null_gross_sales] Found tenant: ${tenant.name} (${tenant.id})\n`);

  // Build query
  let query = supabase
    .from('shopify_orders')
    .select('order_id, total_sales, tax, discount_total, total_refunds, total_tax')
    .eq('tenant_id', tenant.id)
    .is('gross_sales', null)
    .gt('total_price', 0);

  if (since) {
    query = query.gte('processed_at', since);
  }
  if (until) {
    query = query.lte('processed_at', until);
  }

  const { data: orders, error: ordersError } = await query;

  if (ordersError) {
    throw new Error(`Failed to fetch orders: ${ordersError.message}`);
  }

  console.log(`[fix_null_gross_sales] Found ${orders.length} orders with gross_sales=null but total_price > 0\n`);

  if (orders.length === 0) {
    console.log('✅ No orders to fix!');
    return;
  }

  if (args.dry_run) {
    console.log('[fix_null_gross_sales] DRY RUN - Would update:');
    orders.slice(0, 10).forEach((order: any) => {
      const grossSales = order.total_price;
      const netSales = grossSales - (order.discount_total || 0) - (order.total_refunds || 0);
      console.log(`  Order ${order.order_id}: gross_sales=${grossSales.toFixed(2)}, net_sales=${netSales.toFixed(2)}`);
    });
    if (orders.length > 10) {
      console.log(`  ... and ${orders.length - 10} more`);
    }
    return;
  }

  // Update orders in batches
  const batchSize = 100;
  let updated = 0;

  for (let i = 0; i < orders.length; i += batchSize) {
    const batch = orders.slice(i, i + batchSize);
    const updates = batch.map((order: any) => {
      const grossSales = order.total_price;
      const netSales = grossSales - (order.discount_total || 0) - (order.total_refunds || 0);
      
      return {
        tenant_id: tenant.id,
        order_id: order.order_id,
        gross_sales: Math.round(grossSales * 100) / 100,
        net_sales: Math.round(netSales * 100) / 100,
      };
    });

    const { error: updateError } = await supabase
      .from('shopify_orders')
      .upsert(updates, {
        onConflict: 'tenant_id,order_id',
      });

    if (updateError) {
      throw new Error(`Failed to update orders: ${updateError.message}`);
    }

    updated += batch.length;
    console.log(`[fix_null_gross_sales] Updated ${updated}/${orders.length} orders...`);
  }

  console.log(`\n[fix_null_gross_sales] ✅ Successfully updated ${updated} orders!`);
  
  // Recalculate KPIs if date range provided
  if (since) {
    console.log(`\n[fix_null_gross_sales] Recalculating KPIs...`);
    // Note: This would require importing recalculate_kpis logic or calling it separately
  }
}

main().catch((error) => {
  console.error('\n[fix_null_gross_sales] ❌ Error:', error);
  process.exit(1);
});

