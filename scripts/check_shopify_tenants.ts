#!/usr/bin/env -S tsx

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function check() {
  console.log('=== Shopify Connections ===\n');

  const { data: connections, error } = await supabase
    .from('connections')
    .select('tenant_id, status, meta')
    .eq('source', 'shopify')
    .eq('status', 'connected');

  if (error) {
    console.error('Error:', error);
    return;
  }

  if (!connections || connections.length === 0) {
    console.log('No connected Shopify tenants found.');
    return;
  }

  for (const conn of connections) {
    const { data: tenant } = await supabase
      .from('tenants')
      .select('slug, name')
      .eq('id', conn.tenant_id)
      .single();

    console.log(`Tenant: ${tenant?.slug || conn.tenant_id} (${tenant?.name || 'Unknown'})`);
    console.log(`  Shop: ${(conn.meta as any)?.shop || 'Unknown'}`);
    console.log('');
  }
}

check().catch(console.error);

