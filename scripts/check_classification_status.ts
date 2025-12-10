#!/usr/bin/env tsx

/**
 * Quick script to check classification status
 */

import { readFileSync } from 'fs';

function loadEnvFile() {
  const possible = [
    'env/local.prod.sh',
    'env/local.dev.sh',
    '.env.local',
    '.env',
  ].filter(Boolean) as string[];

  for (const envFile of possible) {
    try {
      const content = readFileSync(envFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (trimmed.startsWith('export ')) {
          const match = trimmed.match(/^export\s+([^=]+)=["']?([^"']+)["']?/);
          if (match) {
            const key = match[1].trim();
            let value = match[2].trim();
            if ((value.startsWith('"') && value.endsWith('"')) || 
                (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            process.env[key] = value;
          }
        } else {
          const match = trimmed.match(/^([^=:#]+)=(.*)$/);
          if (match) {
            const key = match[1].trim();
            let value = match[2].trim();
            if ((value.startsWith('"') && value.endsWith('"')) || 
                (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            process.env[key] = value;
          }
        }
      }
      return;
    } catch {
      // try next
    }
  }
}

loadEnvFile();

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function checkStatus(tenantSlug: string) {
  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0'; // skinome
  
  // Get total orders
  const { count: totalOrders } = await supabase
    .from('shopify_orders')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  
  // Get orders with classification
  const { count: ordersWithClassification } = await supabase
    .from('shopify_orders')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .not('customer_type_shopify_mode', 'is', null);
  
  // Get breakdown for January 2025
  const { data: janOrders } = await supabase
    .from('shopify_orders')
    .select('customer_type_shopify_mode')
    .eq('tenant_id', tenantId)
    .gte('created_at', '2025-01-01')
    .lte('created_at', '2025-01-31T23:59:59');
  
  const janFirstTime = janOrders?.filter(o => o.customer_type_shopify_mode === 'FIRST_TIME').length || 0;
  const janReturning = janOrders?.filter(o => o.customer_type_shopify_mode === 'RETURNING').length || 0;
  const janGuest = janOrders?.filter(o => o.customer_type_shopify_mode === 'GUEST').length || 0;
  const janNull = janOrders?.filter(o => !o.customer_type_shopify_mode).length || 0;
  
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Classification Status');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log(`Total orders: ${totalOrders || 0}`);
  console.log(`Orders with classification: ${ordersWithClassification || 0} (${Math.round((ordersWithClassification || 0) / (totalOrders || 1) * 100)}%)\n`);
  console.log('January 2025 breakdown:');
  console.log(`  FIRST_TIME: ${janFirstTime}`);
  console.log(`  RETURNING: ${janReturning}`);
  console.log(`  GUEST: ${janGuest}`);
  console.log(`  NULL: ${janNull}`);
  console.log(`  Total: ${janOrders?.length || 0}\n`);
}

checkStatus('skinome').catch(console.error);


