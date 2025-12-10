#!/usr/bin/env tsx

/**
 * Recalculate shopify_daily_sales for Shopify Mode only
 * using stored customer classification from shopify_orders table.
 * 
 * This script fetches orders from GraphQL (same as backfill) and uses
 * customer_type_shopify_mode from the database for classification.
 * It requires that update_shopify_mode_classification.ts has been run first.
 * 
 * Usage:
 *   source env/local.prod.sh  # Load environment variables first
 *   pnpm tsx scripts/recalculate_daily_sales_shopify_mode.ts <tenant-slug> [from-date] [to-date]
 * 
 * Example:
 *   source env/local.prod.sh
 *   pnpm tsx scripts/recalculate_daily_sales_shopify_mode.ts skinome
 *   pnpm tsx scripts/recalculate_daily_sales_shopify_mode.ts skinome 2025-01-01 2025-01-31
 */

import { readFileSync } from 'fs';

// Load environment variables
function loadEnvFile() {
  // First try to source from shell script if it exists (preferred for local.prod.sh)
  const shellScripts = [
    'env/local.prod.sh',
    'env/local.dev.sh',
  ];

  for (const script of shellScripts) {
    try {
      const content = readFileSync(script, 'utf-8');
      // Parse export statements from shell script
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        // Only process lines starting with 'export '
        if (!trimmed.startsWith('export ')) continue;
        // Match: export KEY="value" or export KEY=value
        const match = trimmed.match(/^export\s+([^=]+)=["']?([^"']+)["']?/);
        if (match) {
          const key = match[1].trim();
          let value = match[2].trim();
          // Remove surrounding quotes if still present
          if ((value.startsWith('"') && value.endsWith('"')) || 
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          process.env[key] = value;
        }
      }
      console.log(`[recalc_shopify_mode] Loaded env from ${script}`);
      return;
    } catch {
      // try next
    }
  }

  // Fallback to standard env files
  const possible = [
    process.env.ENV_FILE,
    '.env.local',
    '.env.production.local',
    '.env.development.local',
    '.env',
  ].filter(Boolean) as string[];

  for (const envFile of possible) {
    try {
      const content = readFileSync(envFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([^=:#]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          let value = match[2].trim();
          // Remove surrounding quotes
          if ((value.startsWith('"') && value.endsWith('"')) || 
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          process.env[key] = value;
        }
      }
      console.log(`[recalc_shopify_mode] Loaded env from ${envFile}`);
      return;
    } catch {
      // try next
    }
  }
}

loadEnvFile();

import { createClient } from '@supabase/supabase-js';
import { decryptSecret } from '@/lib/integrations/crypto';
import { getShopifyConnection, getShopifyAccessToken } from '@/lib/integrations/shopify';
import { calculateDailySales, type OrderCustomerClassification, type SalesMode } from '@/lib/shopify/sales';
import { fetchShopifyOrdersGraphQL, type GraphQLOrder } from '@/lib/integrations/shopify-graphql';
import { convertGraphQLOrderToShopifyOrder } from '@/lib/shopify/order-converter';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Create Supabase client directly
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

type OrderRow = {
  order_id: string;
  customer_type_shopify_mode: 'FIRST_TIME' | 'RETURNING' | 'GUEST' | 'UNKNOWN' | null;
  is_first_order_for_customer: boolean | null;
};

async function recalcShopifyMode(tenantSlug: string, fromDate?: string, toDate?: string) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Recalculate Daily Sales (Shopify Mode Only)');
  console.log('═══════════════════════════════════════════════════════\n');

  // Resolve tenant ID manually instead of using resolveTenantId (which uses getSupabaseServiceClient)
  const { data: tenantData, error: tenantError } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', tenantSlug)
    .single();
  
  if (tenantError || !tenantData) {
    throw new Error(`Failed to resolve tenant: ${tenantError?.message || 'not found'}`);
  }
  
  const tenantId = tenantData.id;
  console.log(`Tenant: ${tenantSlug} (${tenantId})\n`);

  // Determine date range
  let since: string;
  let until: string;

  if (fromDate && toDate) {
    since = fromDate;
    until = toDate;
  } else {
    // Get date range from existing daily sales data
    const { data: dateRange } = await supabase
      .from('shopify_daily_sales')
      .select('date')
      .eq('tenant_id', tenantId)
      .eq('mode', 'shopify')
      .order('date', { ascending: true })
      .limit(1);

    const { data: dateRangeEnd } = await supabase
      .from('shopify_daily_sales')
      .select('date')
      .eq('tenant_id', tenantId)
      .eq('mode', 'shopify')
      .order('date', { ascending: false })
      .limit(1);

    if (!dateRange || dateRange.length === 0 || !dateRangeEnd || dateRangeEnd.length === 0) {
      console.log('⚠️  No existing daily sales data found. Please provide from-date and to-date.');
      process.exit(1);
    }

    since = dateRange[0].date;
    until = dateRangeEnd[0].date;
  }

  console.log(`Date range: ${since} to ${until}\n`);

  // Get Shopify connection and access token (fetch directly from database)
  console.log('🔑 Fetching Shopify connection...');
  const { data: connectionData, error: connError } = await supabase
    .from('connections')
    .select('meta, access_token_enc')
    .eq('tenant_id', tenantId)
    .eq('source', 'shopify')
    .single();
  
  if (connError || !connectionData) {
    throw new Error(`No Shopify connection found: ${connError?.message || 'not found'}`);
  }
  
  const shopDomain = connectionData.meta?.shop || connectionData.meta?.store_domain || connectionData.meta?.shopDomain;
  if (!shopDomain) {
    throw new Error('No shop domain found in connection');
  }
  
  // Decrypt access token
  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
  if (!ENCRYPTION_KEY) {
    throw new Error('Missing ENCRYPTION_KEY environment variable');
  }
  
  if (!connectionData.access_token_enc) {
    throw new Error('No access token found in connection');
  }
  
  const accessToken = await decryptSecret(
    connectionData.access_token_enc,
    ENCRYPTION_KEY,
  );
  
  if (!accessToken) {
    throw new Error('Failed to decrypt access token');
  }
  
  console.log(`✅ Connected to ${shopDomain}\n`);

  // Fetch orders from GraphQL (same as backfill - this ensures we get correct data structure)
  console.log('📥 Fetching orders from Shopify GraphQL API...');
  const graphqlOrders = await fetchShopifyOrdersGraphQL({
    tenantId,
    shopDomain,
    since,
    until,
    excludeTest: true,
    accessToken,
  });
  console.log(`✅ Fetched ${graphqlOrders.length} orders from GraphQL\n`);

  // Convert to ShopifyOrderWithTransactions format (same as backfill)
  const shopifyOrdersWithTransactions = graphqlOrders
    .filter((order) => !order.test)
    .map(convertGraphQLOrderToShopifyOrder);
  
  console.log(`✅ Converted ${shopifyOrdersWithTransactions.length} orders\n`);

  // Fetch customer classification from database
  console.log('📥 Fetching customer classification from database...');
  const orderIds = graphqlOrders.map(o => (o.legacyResourceId || o.id).toString());
  
  // Helper function for retry with exponential backoff
  async function retryFetch<T>(fn: () => Promise<T>, maxRetries = 3, delay = 1000): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delay * attempt));
        }
      }
    }
    throw lastError || new Error('Failed after retries');
  }
  
  // Fetch in batches (Supabase limit is 1000 items in IN clause)
  const pageSize = 500; // Smaller batches for better reliability
  const orderClassifications: OrderRow[] = [];
  const totalBatches = Math.ceil(orderIds.length / pageSize);
  
  for (let i = 0; i < orderIds.length; i += pageSize) {
    const batch = orderIds.slice(i, i + pageSize);
    const batchNum = Math.floor(i / pageSize) + 1;
    
    try {
      await retryFetch(async () => {
        const { data, error } = await supabase
          .from('shopify_orders')
          .select('order_id, customer_type_shopify_mode, is_first_order_for_customer')
          .eq('tenant_id', tenantId)
          .in('order_id', batch);
        
        if (error) throw error;
        if (data) {
          orderClassifications.push(...(data as OrderRow[]));
        }
      }, 3, 2000);
      
      if (batchNum % 5 === 0 || batchNum === totalBatches) {
        console.log(`   Fetched ${orderClassifications.length} classifications so far... (batch ${batchNum}/${totalBatches})`);
      }
    } catch (err) {
      console.warn(`⚠️  Warning: Failed to fetch batch ${batchNum}/${totalBatches} after retries: ${err instanceof Error ? err.message : String(err)}`);
      // Continue with next batch - we'll use fallback classification
    }
  }
  console.log(`✅ Fetched ${orderClassifications.length} order classifications\n`);

  // Check how many orders have classification
  const ordersWithClassification = orderClassifications.filter(o => o.customer_type_shopify_mode);
  const ordersWithoutClassification = graphqlOrders.length - ordersWithClassification.length;
  
  if (ordersWithoutClassification > 0) {
    console.log(`⚠️  Warning: ${ordersWithoutClassification} orders (${Math.round(ordersWithoutClassification / graphqlOrders.length * 100)}%) do not have customer_type_shopify_mode set.`);
    console.log(`   Run update_shopify_mode_classification.ts first to set classification.\n`);
  }

  // Build classification map from database
  const orderCustomerClassification = new Map<string, OrderCustomerClassification>();
  const classificationMap = new Map<string, OrderRow>();
  for (const dbOrder of orderClassifications) {
    classificationMap.set(dbOrder.order_id, dbOrder);
  }

  for (const graphqlOrder of graphqlOrders) {
    const orderId = (graphqlOrder.legacyResourceId || graphqlOrder.id).toString();
    const dbOrder = classificationMap.get(orderId);
    
    if (dbOrder) {
      const shopifyMode = (dbOrder.customer_type_shopify_mode || 'UNKNOWN') as 'FIRST_TIME' | 'RETURNING' | 'GUEST' | 'UNKNOWN';
      orderCustomerClassification.set(orderId, {
        shopifyMode,
        financialMode: 'RETURNING', // DEPRECATED - not used
        customerCreatedAt: graphqlOrder.customer?.createdAt || null,
        isFirstOrderForCustomer: dbOrder.is_first_order_for_customer || false,
      });
    } else {
      // Fallback: classify on the fly if not in database
      if (!graphqlOrder.customer) {
        orderCustomerClassification.set(orderId, {
          shopifyMode: 'GUEST',
          financialMode: 'RETURNING', // DEPRECATED
          customerCreatedAt: null,
          isFirstOrderForCustomer: false,
        });
      } else {
        const numberOfOrders = parseInt(graphqlOrder.customer.numberOfOrders || '0', 10);
        orderCustomerClassification.set(orderId, {
          shopifyMode: numberOfOrders === 1 ? 'FIRST_TIME' : 'RETURNING',
          financialMode: 'RETURNING', // DEPRECATED
          customerCreatedAt: graphqlOrder.customer.createdAt || null,
          isFirstOrderForCustomer: numberOfOrders === 1,
        });
      }
    }
  }

  // Calculate daily sales for Shopify Mode (same as backfill)
  console.log('🧮 Calculating daily sales (Shopify mode)...');
  const shopifyModeDaily = calculateDailySales(
    shopifyOrdersWithTransactions,
    'shopify',
    'Europe/Stockholm',
    undefined, // Legacy orderCustomerMap not used
    orderCustomerClassification, // Use classification map from database
    since, // Reporting period start (needed for Shopify Mode customer.createdAt check)
    until, // Reporting period end
  ).filter((row) => row.date && row.date !== 'Invalid Date');

  console.log(`✅ Calculated ${shopifyModeDaily.length} daily sales rows\n`);

  // Show summary
  const totalNew = shopifyModeDaily.reduce((sum, row) => sum + (row.newCustomerNetSales || 0), 0);
  const totalReturning = shopifyModeDaily.reduce((sum, row) => sum + (row.returningCustomerNetSales || 0), 0);
  const totalGuest = shopifyModeDaily.reduce((sum, row) => sum + (row.guestNetSales || 0), 0);
  const totalNetSales = shopifyModeDaily.reduce((sum, row) => sum + row.netSalesExclTax, 0);

  console.log('📊 Summary:');
  console.log(`   Total days: ${shopifyModeDaily.length}`);
  console.log(`   Total Net Sales: ${totalNetSales.toFixed(2)}`);
  console.log(`   New Customer Net Sales: ${totalNew.toFixed(2)}`);
  console.log(`   Returning Customer Net Sales: ${totalReturning.toFixed(2)}`);
  console.log(`   Guest Net Sales: ${totalGuest.toFixed(2)}\n`);

  // Prepare rows for upsert (Shopify Mode only)
  const dailySalesRows = shopifyModeDaily.map((row) => ({
    tenant_id: tenantId,
    date: row.date,
    mode: 'shopify' as SalesMode,
    net_sales_excl_tax: row.netSalesExclTax,
    gross_sales_excl_tax: row.grossSalesExclTax || null,
    refunds_excl_tax: row.refundsExclTax || null,
    discounts_excl_tax: row.discountsExclTax || null,
    orders_count: row.ordersCount,
    currency: row.currency || null,
    new_customer_net_sales: row.newCustomerNetSales || 0,
    returning_customer_net_sales: row.returningCustomerNetSales || 0,
    guest_net_sales: row.guestNetSales || 0,
  }));

  // Upsert to database
  console.log(`💾 Upserting ${dailySalesRows.length} daily sales rows (Shopify Mode)...`);
  const BATCH_SIZE = 500;
  let saved = 0;
  const failed: number[] = [];

  for (let i = 0; i < dailySalesRows.length; i += BATCH_SIZE) {
    const batch = dailySalesRows.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(dailySalesRows.length / BATCH_SIZE);
    const { error } = await supabase.from('shopify_daily_sales').upsert(batch, {
      onConflict: 'tenant_id,date,mode',
    });
    if (error) {
      console.error(`   ✗ Batch ${batchNum}/${totalBatches} failed: ${error.message}`);
      failed.push(batchNum);
    } else {
      saved += batch.length;
      if (batchNum % 20 === 0 || batchNum === totalBatches) {
        console.log(`   ✓ Batch ${batchNum}/${totalBatches} (${saved}/${dailySalesRows.length} rows)`);
      }
    }
  }

  console.log('\n✅ Done!');
  console.log(`   Saved rows: ${saved}/${dailySalesRows.length}`);
  if (failed.length > 0) {
    console.log(`   Failed batches: ${failed.join(', ')}`);
  }
}

const tenantSlug = process.argv[2] || 'skinome';
const fromDate = process.argv[3];
const toDate = process.argv[4];

recalcShopifyMode(tenantSlug, fromDate, toDate).catch((error) => {
  console.error('\n❌ Error:', error);
  process.exit(1);
});
