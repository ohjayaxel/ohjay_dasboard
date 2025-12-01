#!/usr/bin/env tsx

import { ArgumentParser } from 'argparse';
import { createClient } from '@supabase/supabase-js';
import { decryptSecret } from '@/lib/integrations/crypto';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const parser = new ArgumentParser();
  parser.add_argument('--tenant', { required: true });
  parser.add_argument('--orders', { required: true, help: 'Comma-separated order IDs' });

  const args = parser.parse_args();
  const tenantSlug = args.tenant;
  const orderIds = args.orders.split(',').map(id => id.trim());

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', tenantSlug)
    .single();

  const { data: connData } = await supabase
    .from('connections')
    .select('access_token_enc, meta')
    .eq('tenant_id', tenant.id)
    .eq('source', 'shopify')
    .single();

  const shopDomain = connData.meta.store_domain || connData.meta.shop;
  const accessToken = decryptSecret(connData.access_token_enc);

  for (const orderId of orderIds) {
    const url = `https://${shopDomain}/admin/api/2023-10/orders/${orderId}.json`;
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': accessToken },
    });

    if (res.ok) {
      const data = await res.json();
      const order = data.order;
      console.log(`\nOrder ${orderId}:`);
      console.log(`  created_at: ${order.created_at}`);
      console.log(`  processed_at: ${order.processed_at}`);
      console.log(`  updated_at: ${order.updated_at}`);
      console.log(`  financial_status: ${order.financial_status}`);
      console.log(`  fulfillment_status: ${order.fulfillment_status}`);
    } else {
      console.log(`\nOrder ${orderId}: Not found (${res.status})`);
    }
  }
}

main().catch(console.error);

