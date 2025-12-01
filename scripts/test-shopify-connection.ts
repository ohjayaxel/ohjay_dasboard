#!/usr/bin/env tsx
/**
 * Test Shopify Custom App connection
 * 
 * Usage:
 *   pnpm tsx scripts/test-shopify-connection.ts --tenant skinome
 */

import { ArgumentParser } from 'argparse';
import { createClient } from '@supabase/supabase-js';
import { validateCustomAppToken } from '../lib/integrations/shopify';
import { decryptSecret } from '../lib/integrations/crypto';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

const supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

async function main() {
  const parser = new ArgumentParser({
    description: 'Test Shopify Custom App connection',
  });

  parser.add_argument('--tenant', {
    required: true,
    help: 'Tenant slug (e.g., skinome)',
  });

  const args = parser.parse_args();

  console.log(`\n[test-shopify-connection] Testing Shopify connection for tenant: ${args.tenant}\n`);

  try {
    // 1. Get tenant ID
    const { data: tenant, error: tenantError } = await supabaseClient
      .from('tenants')
      .select('id, name, slug')
      .eq('slug', args.tenant)
      .maybeSingle();

    if (tenantError) {
      throw new Error(`Failed to fetch tenant: ${tenantError.message}`);
    }

    if (!tenant) {
      throw new Error(`Tenant not found: ${args.tenant}`);
    }

    const tenantId = tenant.id;
    console.log(`✅ Tenant ID resolved: ${tenantId} (${tenant.name})`);

    // 2. Check connection in database
    const supabase = supabaseClient;
    const { data: connection, error: connError } = await supabase
      .from('connections')
      .select('id, status, meta, updated_at')
      .eq('tenant_id', tenantId)
      .eq('source', 'shopify')
      .maybeSingle();

    if (connError) {
      throw new Error(`Failed to fetch connection: ${connError.message}`);
    }

    if (!connection) {
      console.log('❌ No Shopify connection found in database');
      return;
    }

    console.log(`✅ Connection found in database:`);
    console.log(`   Status: ${connection.status}`);
    console.log(`   Updated: ${connection.updated_at || 'Never'}`);
    
    const meta = connection.meta as Record<string, unknown> | null;
    const shopDomain = meta?.store_domain || meta?.shop || 'Not set';
    const connectionMethod = meta?.connection_method || 'unknown';
    console.log(`   Shop Domain: ${shopDomain}`);
    console.log(`   Connection Method: ${connectionMethod}`);

    if (connection.status !== 'connected') {
      console.log(`\n⚠️  Connection status is "${connection.status}", not "connected"`);
      return;
    }

    // 3. Get and test access token
    const { data: connData, error: tokenError } = await supabase
      .from('connections')
      .select('access_token_enc')
      .eq('tenant_id', tenantId)
      .eq('source', 'shopify')
      .maybeSingle();

    if (tokenError) {
      throw new Error(`Failed to fetch token: ${tokenError.message}`);
    }

    if (!connData || !connData.access_token_enc) {
      console.log('❌ No access token found in database');
      return;
    }

    let accessToken: string;
    try {
      accessToken = decryptSecret(connData.access_token_enc as Buffer);
    } catch (error) {
      console.log(`❌ Failed to decrypt access token: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    console.log(`✅ Access token found (length: ${accessToken.length})`);

    // 4. Validate token against Shopify API
    if (typeof shopDomain === 'string' && shopDomain !== 'Not set') {
      console.log(`\n🔍 Testing token against Shopify API...`);
      const validation = await validateCustomAppToken(shopDomain, accessToken);
      
      if (validation.valid) {
        console.log(`✅ Token is valid and can access Shopify API`);
      } else {
        console.log(`❌ Token validation failed: ${validation.error}`);
        return;
      }

      // 5. Test fetching orders (just a few to verify API works)
      console.log(`\n🔍 Testing orders API access...`);
      try {
        const ordersUrl = `https://${shopDomain}/admin/api/2023-10/orders.json?limit=5&status=any`;
        const ordersRes = await fetch(ordersUrl, {
          headers: {
            'X-Shopify-Access-Token': accessToken,
          },
        });

        if (ordersRes.ok) {
          const ordersData = await ordersRes.json();
          const orderCount = ordersData.orders?.length || 0;
          console.log(`✅ Orders API accessible (fetched ${orderCount} sample orders)`);
        } else {
          const errorText = await ordersRes.text();
          console.log(`⚠️  Orders API returned ${ordersRes.status}: ${errorText.slice(0, 200)}`);
        }
      } catch (error) {
        console.log(`⚠️  Failed to test orders API: ${error instanceof Error ? error.message : String(error)}`);
      }

      // 6. Check webhooks
      console.log(`\n🔍 Checking webhook registrations...`);
      try {
        const webhooksUrl = `https://${shopDomain}/admin/api/2023-10/webhooks.json`;
        const webhooksRes = await fetch(webhooksUrl, {
          headers: {
            'X-Shopify-Access-Token': accessToken,
          },
        });

        if (webhooksRes.ok) {
          const webhooksData = await webhooksRes.json();
          const webhooks = webhooksData.webhooks || [];
          const ourWebhooks = webhooks.filter((wh: any) => 
            wh.topic === 'orders/create' || wh.topic === 'orders/updated'
          );
          
          if (ourWebhooks.length > 0) {
            console.log(`✅ Found ${ourWebhooks.length} order webhooks:`);
            for (const wh of ourWebhooks) {
              console.log(`   - ${wh.topic}: ${wh.address}`);
            }
          } else {
            console.log(`⚠️  No order webhooks found (expected orders/create and orders/updated)`);
          }
        } else {
          console.log(`⚠️  Failed to check webhooks: ${webhooksRes.status}`);
        }
      } catch (error) {
        console.log(`⚠️  Error checking webhooks: ${error instanceof Error ? error.message : String(error)}`);
      }

      // 7. Check recent sync jobs
      console.log(`\n🔍 Checking recent sync jobs...`);
      const { data: jobs, error: jobsError } = await supabase
        .from('jobs_log')
        .select('id, status, started_at, finished_at, error')
        .eq('tenant_id', tenantId)
        .eq('source', 'shopify')
        .order('started_at', { ascending: false })
        .limit(5);

      if (jobsError) {
        console.log(`⚠️  Failed to fetch jobs: ${jobsError.message}`);
      } else if (jobs && jobs.length > 0) {
        console.log(`✅ Found ${jobs.length} recent sync jobs:`);
        for (const job of jobs) {
          const status = job.status === 'succeeded' ? '✅' : job.status === 'failed' ? '❌' : '⏳';
          console.log(`   ${status} ${job.status} - Started: ${job.started_at || 'N/A'}`);
          if (job.error) {
            console.log(`      Error: ${job.error.slice(0, 100)}`);
          }
        }
      } else {
        console.log(`⚠️  No sync jobs found (connection might be new)`);
      }

      // 8. Check if we have any orders in database
      console.log(`\n🔍 Checking orders in database...`);
      const { count: orderCount, error: orderError } = await supabase
        .from('shopify_orders')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId);

      if (orderError) {
        console.log(`⚠️  Failed to count orders: ${orderError.message}`);
      } else {
        console.log(`📊 Total orders in database: ${orderCount || 0}`);
        if (orderCount && orderCount > 0) {
          const { data: recentOrder } = await supabase
            .from('shopify_orders')
            .select('order_id, processed_at, gross_sales, net_sales')
            .eq('tenant_id', tenantId)
            .order('processed_at', { ascending: false })
            .limit(1)
            .single();

          if (recentOrder) {
            console.log(`   Most recent order: ${recentOrder.order_id} (${recentOrder.processed_at})`);
          }
        }
      }
    }

    console.log(`\n✅ Connection test completed!\n`);
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();

