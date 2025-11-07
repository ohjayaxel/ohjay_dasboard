import { getSupabaseServiceClient } from '@/lib/supabase/server';

import { triggerSyncJob } from '../scheduler';

export async function runShopifySyncRunner() {
  const client = getSupabaseServiceClient();

  const { data, error } = await client
    .from('connections')
    .select('tenant_id, status')
    .eq('source', 'shopify');

  if (error) {
    throw new Error(`Shopify runner failed to list connections: ${error.message}`);
  }

  const connectedTenants = new Set<string>();
  for (const row of data ?? []) {
    if (row.status === 'connected' && row.tenant_id) {
      connectedTenants.add(row.tenant_id as string);
    }
  }

  if (connectedTenants.size === 0) {
    return { triggered: false, reason: 'No connected Shopify tenants.' };
  }

  const result = await triggerSyncJob('shopify');
  return {
    triggered: true,
    tenantCount: connectedTenants.size,
    result,
  };
}

