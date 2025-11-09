import { getSupabaseServiceClient } from '@/lib/supabase/server';

import { triggerSyncJob, triggerSyncJobForTenant } from '../scheduler';

export async function runMetaSyncRunner() {
  const client = getSupabaseServiceClient();

  const { data, error } = await client
    .from('connections')
    .select('tenant_id, status')
    .eq('source', 'meta');

  if (error) {
    throw new Error(`Meta runner failed to list connections: ${error.message}`);
  }

  const connectedTenants = new Set<string>();
  for (const row of data ?? []) {
    if (row.status === 'connected' && row.tenant_id) {
      connectedTenants.add(row.tenant_id as string);
    }
  }

  if (connectedTenants.size === 0) {
    return { triggered: false, reason: 'No connected Meta tenants.' };
  }

  const result = await triggerSyncJob('meta');
  return {
    triggered: true,
    tenantCount: connectedTenants.size,
    result,
  };
}

export async function runMetaSyncForTenant(tenantId: string) {
  return triggerSyncJobForTenant('meta', tenantId);
}

