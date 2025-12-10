#!/usr/bin/env -S tsx

import { readFileSync } from 'fs';

function loadEnvFile() {
  const possibleEnvFiles = ['.env.local', 'env/local.prod.sh'].filter(Boolean);
  for (const envFile of possibleEnvFiles) {
    try {
      const content = readFileSync(envFile, 'utf-8');
      const envVars: Record<string, string> = {};
      content.split('\n').forEach((line) => {
        const match = line.match(/^(?:export\s+)?(\w+)=(.+)$/);
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

import { createClient } from '@supabase/supabase-js';

const client = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function debug() {
  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0';
  
  // Get orders with classification
  const { data: orders } = await client
    .from('shopify_orders')
    .select('order_id, created_at, processed_at, customer_type_shopify_mode, is_first_order_for_customer, net_sales')
    .eq('tenant_id', tenantId)
    .gte('processed_at', '2025-01-01')
    .lte('processed_at', '2025-01-07');
  
  console.log(`\nTotal orders: ${orders?.length || 0}`);
  
  const firstTime = orders?.filter(o => o.customer_type_shopify_mode === 'FIRST_TIME') || [];
  const firstTimeInPeriod = firstTime.filter(o => {
    const created = o.created_at;
    return created && created >= '2025-01-01' && created <= '2025-01-07';
  });
  
  console.log(`FIRST_TIME total: ${firstTime.length}`);
  console.log(`FIRST_TIME with created_at in period: ${firstTimeInPeriod.length}`);
  console.log(`FIRST_TIME with created_at OUTSIDE period: ${firstTime.length - firstTimeInPeriod.length}`);
}

debug().catch(console.error);

