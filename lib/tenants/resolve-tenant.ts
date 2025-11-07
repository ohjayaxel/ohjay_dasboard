import { cache } from 'react';

import { getSupabaseServiceClient } from '@/lib/supabase/server';

export type TenantRecord = {
  id: string;
  slug: string;
  name: string;
};

async function fetchTenant(slug: string): Promise<TenantRecord> {
  const client = getSupabaseServiceClient();

  const { data, error } = await client
    .from('tenants')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to resolve tenant for slug "${slug}": ${error.message}`);
  }

  if (!data) {
    throw new Error(`Tenant not found for slug "${slug}".`);
  }

  return data;
}

export const resolveTenantBySlug = cache((slug: string) => fetchTenant(slug));

export async function resolveTenantId(slug: string): Promise<string> {
  const tenant = await resolveTenantBySlug(slug);
  return tenant.id;
}

