#!/usr/bin/env tsx

/**
 * Update customer_type_shopify_mode for all orders by fetching customer.createdAt from GraphQL
 * 
 * This script processes orders in chunks, fetches GraphQL data to get customer.createdAt,
 * and updates customer_type_shopify_mode in the database according to "Def 6" logic:
 * - FIRST_TIME if (customer created in period) OR (numberOfOrders === 1) AND order created in period
 * - RETURNING for all other orders with customer
 * - GUEST for orders without customer
 * 
 * Usage:
 *   source env/local.prod.sh  # Load environment variables first
 *   pnpm tsx scripts/update_shopify_mode_classification.ts <tenant-slug> [from-date] [to-date]
 * 
 * Example:
 *   source env/local.prod.sh
 *   pnpm tsx scripts/update_shopify_mode_classification.ts skinome
 *   pnpm tsx scripts/update_shopify_mode_classification.ts skinome 2025-01-01 2025-01-31
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
      console.log(`[update_shopify_mode] Loaded env from ${script}`);
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
      console.log(`[update_shopify_mode] Loaded env from ${envFile}`);
      return;
    } catch {
      // try next
    }
  }
}

loadEnvFile();

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrdersGraphQL } from '@/lib/integrations/shopify-graphql';
import { decryptSecret } from '@/lib/integrations/crypto';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function resolveTenantId(tenantSlug: string): Promise<string> {
  const { data, error } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', tenantSlug)
    .single();
  
  if (error || !data) {
    throw new Error(`Failed to resolve tenant: ${error?.message || 'not found'}`);
  }
  
  return data.id;
}

async function updateShopifyModeClassification(tenantSlug: string, fromDate?: string, toDate?: string) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Update Shopify Mode Classification');
  console.log('═══════════════════════════════════════════════════════\n');

  const tenantId = await resolveTenantId(tenantSlug);
  console.log(`Tenant: ${tenantSlug} (${tenantId})\n`);

  // Get Shopify connection directly from database
  const { data: connection, error: connError } = await supabase
    .from('connections')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('source', 'shopify')
    .maybeSingle();
  
  if (connError) {
    throw new Error(`Failed to fetch Shopify connection: ${connError.message}`);
  }
  
  if (!connection) {
    throw new Error('No Shopify connection found');
  }

  const shopDomain = (connection.meta?.shop || connection.meta?.store_domain || connection.meta?.shopDomain) as string;
  if (!shopDomain) {
    throw new Error('No shop domain found in connection');
  }

  console.log(`Shop domain: ${shopDomain}\n`);

  // Get Shopify access token
  const accessToken = connection.access_token_enc 
    ? await decryptSecret(connection.access_token_enc)
    : null;
  
  if (!accessToken) {
    throw new Error('No Shopify access token found in connection');
  }

  // Determine date range
  let since: string;
  let until: string;

  if (fromDate && toDate) {
    since = fromDate;
    until = toDate;
  } else {
    // Get date range from orders
    const { data: dateRange } = await supabase
      .from('shopify_orders')
      .select('created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: true })
      .limit(1);

    const { data: dateRangeEnd } = await supabase
      .from('shopify_orders')
      .select('created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!dateRange || dateRange.length === 0 || !dateRangeEnd || dateRangeEnd.length === 0) {
      console.log('⚠️  No orders found. Exiting.');
      process.exit(1);
    }

    since = dateRange[0].created_at?.slice(0, 10) || '';
    until = dateRangeEnd[0].created_at?.slice(0, 10) || '';
    
    if (!since || !until) {
      console.log('⚠️  Could not determine date range from orders. Exiting.');
      process.exit(1);
    }
  }

  console.log(`Date range: ${since} to ${until}\n`);

  // Process in monthly chunks to avoid GraphQL rate limits and memory issues
  const startDate = new Date(since + 'T00:00:00');
  const endDate = new Date(until + 'T23:59:59');
  
  let currentStart = new Date(startDate);
  let totalUpdated = 0;

  while (currentStart <= endDate) {
    const currentEnd = new Date(currentStart);
    currentEnd.setMonth(currentEnd.getMonth() + 1);
    if (currentEnd > endDate) {
      currentEnd.setTime(endDate.getTime());
    }
    
    // Break if we've reached the end (same date means we're done)
    if (currentStart.getTime() >= currentEnd.getTime()) {
      break;
    }

    const chunkSince = currentStart.toISOString().slice(0, 10);
    const chunkUntil = currentEnd.toISOString().slice(0, 10);

    console.log(`📅 Processing chunk: ${chunkSince} to ${chunkUntil}`);

    // Fetch orders from database for this chunk
    const { data: orders, error: fetchError } = await supabase
      .from('shopify_orders')
      .select('order_id, customer_id, created_at')
      .eq('tenant_id', tenantId)
      .gte('created_at', chunkSince)
      .lte('created_at', chunkUntil + 'T23:59:59')
      .order('created_at', { ascending: true });

    if (fetchError) {
      throw new Error(`Failed to fetch orders: ${fetchError.message}`);
    }

    if (!orders || orders.length === 0) {
      console.log(`   No orders in this chunk\n`);
      currentStart = currentEnd;
      continue;
    }

    console.log(`   Found ${orders.length} orders`);

    // Fetch GraphQL orders for this chunk
    console.log(`   Fetching GraphQL data...`);
    const graphqlOrders = await fetchShopifyOrdersGraphQL({
      tenantId,
      shopDomain,
      since: chunkSince,
      until: chunkUntil,
      excludeTest: true,
      accessToken, // Pass access token directly
    });
    console.log(`   Fetched ${graphqlOrders.length} orders via GraphQL`);

    // Build order -> classification map
    const orderUpdates = new Map<string, {
      customer_type_shopify_mode: 'FIRST_TIME' | 'RETURNING' | 'GUEST' | 'UNKNOWN';
      is_first_order_for_customer: boolean;
    }>();

    // First, get all orders for customers to determine first_order_id_all_time
    const customerToOrders = new Map<string, Array<{ orderId: string; createdAt: string }>>();
    for (const order of orders) {
      if (!order.customer_id || !order.created_at) continue;
      const customerId = order.customer_id as string;
      if (!customerToOrders.has(customerId)) {
        customerToOrders.set(customerId, []);
      }
      customerToOrders.get(customerId)!.push({
        orderId: order.order_id as string,
        createdAt: order.created_at as string,
      });
    }

    // Determine first_order_id_all_time for each customer
    const customerFirstOrder = new Map<string, string>();
    for (const [customerId, orderList] of customerToOrders.entries()) {
      const sorted = [...orderList].sort((a, b) => 
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      customerFirstOrder.set(customerId, sorted[0].orderId);
    }

    // Process GraphQL orders and build classification
    const fromDateObj = new Date(chunkSince + 'T00:00:00');
    const toDateObj = new Date(chunkUntil + 'T23:59:59');

    for (const graphqlOrder of graphqlOrders) {
      const orderId = (graphqlOrder.legacyResourceId || graphqlOrder.id).toString();
      
      if (!graphqlOrder.customer) {
        // Guest checkout
        orderUpdates.set(orderId, {
          customer_type_shopify_mode: 'GUEST',
          is_first_order_for_customer: false,
        });
      } else {
        const customerCreatedAt = graphqlOrder.customer.createdAt || null;
        const numberOfOrders = parseInt(graphqlOrder.customer.numberOfOrders || '0', 10);
        const graphqlOrderCreatedAt = graphqlOrder.createdAt;
        
        // Get order.createdAt date in Europe/Stockholm timezone
        const orderCreatedAtDate = graphqlOrderCreatedAt 
          ? new Date(graphqlOrderCreatedAt).toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' })
          : null;
        const orderCreatedInPeriod = orderCreatedAtDate && orderCreatedAtDate >= chunkSince && orderCreatedAtDate <= chunkUntil;

        let shopifyMode: 'FIRST_TIME' | 'RETURNING' | 'GUEST' | 'UNKNOWN' = 'RETURNING';
        let isFirstOrder = false;

        if (orderCreatedInPeriod) {
          // Order was created in period - check if customer is new using Def 6 logic
          if (customerCreatedAt) {
            const customerCreatedDate = new Date(customerCreatedAt);
            const customerCreatedInPeriod = customerCreatedDate >= fromDateObj && customerCreatedDate <= toDateObj;
            
            // Def 6: NEW if (customer created in period) OR (numberOfOrders === 1)
            if (customerCreatedInPeriod || numberOfOrders === 1) {
              shopifyMode = 'FIRST_TIME';
            } else {
              shopifyMode = 'RETURNING';
            }
          } else if (numberOfOrders === 1) {
            // No customer.createdAt but numberOfOrders === 1 - classify as FIRST_TIME
            shopifyMode = 'FIRST_TIME';
          } else {
            shopifyMode = 'RETURNING';
          }
        } else {
          // Order was NOT created in period - always RETURNING
          shopifyMode = 'RETURNING';
        }

        // Check if this is the customer's first order all-time
        const customerId = graphqlOrder.customer.id;
        const firstOrderId = customerFirstOrder.get(customerId);
        isFirstOrder = firstOrderId === orderId;

        orderUpdates.set(orderId, {
          customer_type_shopify_mode: shopifyMode,
          is_first_order_for_customer: isFirstOrder,
        });
      }
    }

    // Update database in batches
    console.log(`   Updating ${orderUpdates.size} orders in database...`);
    const BATCH_SIZE = 500;
    let batchNum = 0;
    let updated = 0;

    const updatesArray = Array.from(orderUpdates.entries()).map(([orderId, data]) => ({
      tenant_id: tenantId,
      order_id: orderId,
      customer_type_shopify_mode: data.customer_type_shopify_mode,
      is_first_order_for_customer: data.is_first_order_for_customer,
    }));

    for (let i = 0; i < updatesArray.length; i += BATCH_SIZE) {
      batchNum++;
      const batch = updatesArray.slice(i, i + BATCH_SIZE);
      
      const { error } = await supabase
        .from('shopify_orders')
        .upsert(batch, {
          onConflict: 'tenant_id,order_id',
        });

      if (error) {
        console.error(`   ✗ Batch ${batchNum} failed: ${error.message}`);
      } else {
        updated += batch.length;
        if (batchNum % 10 === 0 || batchNum === Math.ceil(updatesArray.length / BATCH_SIZE)) {
          console.log(`   ✓ Batch ${batchNum} (${updated}/${updatesArray.length} orders updated)`);
        }
      }
    }

    console.log(`   ✅ Updated ${updated} orders in this chunk`);
    totalUpdated += updated;
    console.log('');

    // Move to next chunk
    currentStart = currentEnd;
  }

  console.log(`✅ Done! Total updated: ${totalUpdated} orders`);
}

const tenantSlug = process.argv[2] || 'skinome';
const fromDate = process.argv[3];
const toDate = process.argv[4];

updateShopifyModeClassification(tenantSlug, fromDate, toDate).catch((error) => {
  console.error('\n❌ Error:', error);
  process.exit(1);
});
