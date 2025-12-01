#!/usr/bin/env tsx
/**
 * Script to connect Shopify via Custom App method
 * 
 * Usage:
 *   pnpm tsx scripts/connect-shopify-custom-app.ts --tenant skinome --shop your-store.myshopify.com --token shpat_...
 */

import { z } from 'zod';
import { getSupabaseServiceClient } from '../lib/supabase/server';
import { connectShopifyCustomApp } from '../lib/integrations/shopify';
import { resolveTenantId } from '../lib/tenants/resolve-tenant';

const argsSchema = z.object({
  tenant: z.string().min(1, 'Tenant slug is required'),
  shop: z.string().min(1, 'Shop domain is required'),
  token: z.string().min(1, 'Access token is required'),
});

async function main() {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const value = args[i + 1];
    if (key && value) {
      parsed[key] = value;
    }
  }

  const result = argsSchema.safeParse(parsed);

  if (!result.success) {
    console.error('Error: Invalid arguments');
    console.error(result.error.errors);
    console.error('\nUsage:');
    console.error('  pnpm tsx scripts/connect-shopify-custom-app.ts --tenant <slug> --shop <domain> --token <token>');
    process.exit(1);
  }

  const { tenant, shop, token } = result.data;

  console.log(`Connecting Shopify Custom App for tenant: ${tenant}`);
  console.log(`Shop domain: ${shop}`);
  console.log('');

  try {
    // Resolve tenant ID
    const tenantId = await resolveTenantId(tenant);
    console.log(`Tenant ID: ${tenantId}`);

    // Connect
    await connectShopifyCustomApp({
      tenantId,
      shopDomain: shop,
      accessToken: token,
    });

    console.log('');
    console.log('✅ Successfully connected Shopify Custom App!');
    console.log('✅ Webhooks should be registered automatically');
    console.log('');
    console.log('Next steps:');
    console.log(`  1. Visit /admin/tenants/${tenant}/integrations to verify connection`);
    console.log('  2. Trigger initial sync or wait for scheduled sync');
  } catch (error) {
    console.error('');
    console.error('❌ Failed to connect:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();

