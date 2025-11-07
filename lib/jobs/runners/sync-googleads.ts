import { getSupabaseServiceClient } from '@/lib/supabase/server';

import { triggerSyncJob } from '../scheduler';

export async function runGoogleAdsSyncRunner() {
  const client = getSupabaseServiceClient();

  const { data, error } = await client
    .from('connections')
    .select('tenant_id, status')
    .eq('source', 'google_ads');

  if (error) {
    throw new Error(`Google Ads runner failed to list connections: ${error.message}`);
  }

  const connectedTenants = new Set<string>();
  for (const row of data ?? []) {
    if (row.status === 'connected' && row.tenant_id) {
      connectedTenants.add(row.tenant_id as string);
    }
  }

  if (connectedTenants.size === 0) {
    return { triggered: false, reason: 'No connected Google Ads tenants.' };
  }

  const result = await triggerSyncJob('google_ads');
  return {
    triggered: true,
    tenantCount: connectedTenants.size,
    result,
  };
}

