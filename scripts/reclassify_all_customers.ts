#!/usr/bin/env tsx

/**
 * Reclassify all orders with correct customer classification based on full customer history
 * This fixes classification issues from sequential backfill processing
 * 
 * Usage:
 *   pnpm tsx scripts/reclassify_all_customers.ts <tenant-slug>
 * 
 * Example:
 *   pnpm tsx scripts/reclassify_all_customers.ts skinome
 */

import { readFileSync } from 'fs';

// Load environment variables
function loadEnvFile() {
  const possibleEnvFiles = [
    process.env.ENV_FILE,
    '.env.local',
    '.env.production.local',
    '.env.development.local',
    '.env',
  ].filter(Boolean) as string[];

  for (const envFile of possibleEnvFiles) {
    try {
      const content = readFileSync(envFile, 'utf-8');
      for (const line of content.split('\n')) {
        const match = line.match(/^([^=:#]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          const value = match[2].trim().replace(/^["']|["']$/g, '');
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
      console.log(`[reclassify] Loaded environment variables from ${envFile}`);
      return;
    } catch (error) {
      // Continue to next file
    }
  }
}

loadEnvFile();

import { createClient } from '@supabase/supabase-js';
import { resolveTenantId } from '@/lib/tenants/resolve-tenant';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('\n❌ Error: Missing environment variables');
  console.error('   NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL');
  console.error('   SUPABASE_SERVICE_ROLE_KEY\n');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

type CustomerOrderInfo = {
  order_id: string;
  created_at: string;
  net_sales: number;
  is_cancelled: boolean;
  is_full_refunded: boolean;
};

type CustomerHistory = {
  first_order_id_all_time: string;
  first_revenue_order_id: string | null;
  all_orders: CustomerOrderInfo[];
};

async function reclassifyAllCustomers(tenantSlug: string) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Reclassify All Customers');
  console.log('═══════════════════════════════════════════════════════\n');
  
  console.log(`Tenant: ${tenantSlug}`);
  
  const tenantId = await resolveTenantId(tenantSlug);
  console.log(`Tenant ID: ${tenantId}\n`);

  // Fetch all orders for this tenant (with pagination to handle large datasets)
  console.log('📥 Fetching all orders...');
  let allOrders: any[] = [];
  let page = 0;
  const pageSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data: orders, error: fetchError } = await supabase
      .from('shopify_orders')
      .select('order_id, customer_id, created_at, processed_at, net_sales, gross_sales, financial_status, total_refunds')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (fetchError) {
      throw new Error(`Failed to fetch orders: ${fetchError.message}`);
    }

    if (!orders || orders.length === 0) {
      hasMore = false;
    } else {
      allOrders = allOrders.concat(orders);
      console.log(`   Fetched ${allOrders.length} orders so far...`);
      hasMore = orders.length === pageSize;
      page++;
    }
  }

  if (allOrders.length === 0) {
    console.log('⚠️  No orders found. Nothing to reclassify.');
    return;
  }

  console.log(`✅ Fetched ${allOrders.length} orders total\n`);

  // Group orders by customer and calculate history
  console.log('🔍 Calculating customer history...');
  const customerHistories = new Map<string, CustomerHistory>();
  const ordersByCustomer = new Map<string, CustomerOrderInfo[]>();

  // Group orders by customer
  for (const order of allOrders) {
    if (!order.customer_id || !order.created_at) continue;

    const customerId = order.customer_id as string;
    if (!ordersByCustomer.has(customerId)) {
      ordersByCustomer.set(customerId, []);
    }

    const netSales = parseFloat((order.net_sales || 0).toString()) || 0;
    const totalRefunds = parseFloat((order.total_refunds || 0).toString()) || 0;
    
    // Check if cancelled based on financial_status
    const financialStatus = (order.financial_status as string) || '';
    const isCancelled = 
      financialStatus === 'voided' || 
      financialStatus.toLowerCase().includes('cancelled');
    
    const isFullRefunded = !isCancelled && netSales > 0 && Math.abs(totalRefunds) >= Math.abs(netSales);

    ordersByCustomer.get(customerId)!.push({
      order_id: order.order_id as string,
      created_at: order.created_at as string,
      net_sales: netSales,
      is_cancelled: isCancelled,
      is_full_refunded: isFullRefunded,
    });
  }

  // Calculate history for each customer
  for (const [customerId, orders] of ordersByCustomer.entries()) {
    const sortedOrders = [...orders].sort((a, b) => a.created_at.localeCompare(b.created_at));
    
    if (sortedOrders.length === 0) continue;

    const firstOrderAllTime = sortedOrders[0];

    // Find first revenue-generating order (NetSales > 0 and not cancelled/full-refunded)
    let firstRevenueOrder: CustomerOrderInfo | null = null;
    for (const order of sortedOrders) {
      if (order.net_sales > 0 && !order.is_cancelled && !order.is_full_refunded) {
        firstRevenueOrder = order;
        break;
      }
    }

    customerHistories.set(customerId, {
      first_order_id_all_time: firstOrderAllTime.order_id,
      first_revenue_order_id: firstRevenueOrder?.order_id || null,
      all_orders: sortedOrders,
    });
  }

  console.log(`✅ Calculated history for ${customerHistories.size} customers\n`);

  // Reclassify all orders
  console.log('🔄 Reclassifying orders...');
  const updates: Array<{
    order_id: string;
    is_first_order_for_customer: boolean;
    customer_type_financial_mode: 'NEW' | 'RETURNING' | 'GUEST' | 'UNKNOWN';
  }> = [];

  for (const order of allOrders) {
    if (!order.customer_id) {
      // Guest checkout
      updates.push({
        order_id: order.order_id as string,
        is_first_order_for_customer: false,
        customer_type_financial_mode: 'GUEST',
      });
      continue;
    }

    const customerId = order.customer_id as string;
    const history = customerHistories.get(customerId);
    
    if (!history) {
      // No history found (shouldn't happen, but handle gracefully)
      updates.push({
        order_id: order.order_id as string,
        is_first_order_for_customer: false,
        customer_type_financial_mode: 'UNKNOWN',
      });
      continue;
    }

    const isFirstOrderAllTime = order.order_id === history.first_order_id_all_time;
    const isFirstRevenueOrder = history.first_revenue_order_id && order.order_id === history.first_revenue_order_id;

    // Financial mode classification
    let financialMode: 'NEW' | 'RETURNING' | 'GUEST' | 'UNKNOWN' = 'RETURNING';
    if (isFirstRevenueOrder) {
      financialMode = 'NEW';
    }

    updates.push({
      order_id: order.order_id as string,
      is_first_order_for_customer: isFirstOrderAllTime,
      customer_type_financial_mode: financialMode,
    });
  }

  console.log(`✅ Prepared ${updates.length} classification updates\n`);

  // Update orders in batches
  console.log('💾 Updating orders in database...');
  const BATCH_SIZE = 500;
  let updatedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(updates.length / BATCH_SIZE);

    // Build update queries for batch
    const updatePromises = batch.map((update) =>
      supabase
        .from('shopify_orders')
        .update({
          is_first_order_for_customer: update.is_first_order_for_customer,
          customer_type_financial_mode: update.customer_type_financial_mode,
        })
        .eq('tenant_id', tenantId)
        .eq('order_id', update.order_id)
    );

    try {
      await Promise.all(updatePromises);
      updatedCount += batch.length;
      console.log(`   ✓ Batch ${batchNum}/${totalBatches}: ${batch.length} orders updated`);
    } catch (error) {
      failedCount += batch.length;
      console.error(`   ✗ Batch ${batchNum}/${totalBatches} failed:`, error);
    }
  }

  console.log(`\n✅ Classification complete!`);
  console.log(`   - Updated: ${updatedCount} orders`);
  if (failedCount > 0) {
    console.log(`   - Failed: ${failedCount} orders`);
  }

  // Print summary
  const newCount = updates.filter(u => u.customer_type_financial_mode === 'NEW').length;
  const returningCount = updates.filter(u => u.customer_type_financial_mode === 'RETURNING').length;
  const guestCount = updates.filter(u => u.customer_type_financial_mode === 'GUEST').length;
  const unknownCount = updates.filter(u => u.customer_type_financial_mode === 'UNKNOWN').length;

  console.log(`\n📊 Classification Summary:`);
  console.log(`   - NEW (Financial Mode): ${newCount}`);
  console.log(`   - RETURNING (Financial Mode): ${returningCount}`);
  console.log(`   - GUEST: ${guestCount}`);
  console.log(`   - UNKNOWN: ${unknownCount}`);
  console.log(`\n💡 Next step: Run recalculate_daily_sales script to update daily sales aggregation\n`);
}

const tenantSlug = process.argv[2] || 'skinome';
reclassifyAllCustomers(tenantSlug).catch((error) => {
  console.error('\n❌ Error:', error);
  process.exit(1);
});

