import { getSupabaseServiceClient } from '@/lib/supabase/server'

export type IntegrationSource = 'meta' | 'google_ads' | 'shopify'

export type AdminMember = {
  id: string
  tenantId: string
  userId: string | null
  email: string | null
  role: string
}

export type AdminConnection = {
  source: IntegrationSource
  status: 'connected' | 'disconnected' | 'error'
  updatedAt: string | null
  meta: Record<string, unknown> | null
}

export type AdminTenant = {
  id: string
  name: string
  slug: string
  members: AdminMember[]
  connections: Record<IntegrationSource, AdminConnection>
}

const INTEGRATION_SOURCES: IntegrationSource[] = ['meta', 'google_ads', 'shopify']

export async function listAdminTenants(): Promise<AdminTenant[]> {
  const client = getSupabaseServiceClient()

  const { data, error } = await client
    .from('tenants')
    .select('id, name, slug, members(id, tenant_id, user_id, email, role), connections(id, source, status, updated_at, meta)')
    .order('name', { ascending: true })

  if (error) {
    throw new Error(`Failed to list tenants for admin: ${error.message}`)
  }

  return (data ?? []).map((tenant: any) => {
    const connectionMap: Record<IntegrationSource, AdminConnection> = Object.fromEntries(
      INTEGRATION_SOURCES.map((source) => [
        source,
        {
          source,
          status: 'disconnected',
          updatedAt: null,
          meta: null,
        },
      ]),
    ) as Record<IntegrationSource, AdminConnection>

    for (const connection of tenant.connections ?? []) {
      const source = connection.source as IntegrationSource
      if (!source || !INTEGRATION_SOURCES.includes(source)) {
        continue
      }

      connectionMap[source] = {
        source,
        status: (connection.status ?? 'disconnected') as 'connected' | 'disconnected' | 'error',
        updatedAt: connection.updated_at ?? null,
        meta: connection.meta ?? null,
      }
    }

    const members: AdminMember[] = (tenant.members ?? []).map((member: any) => ({
      id: member.id as string,
      tenantId: member.tenant_id as string,
      userId: member.user_id ?? null,
      email: member.email ?? null,
      role: member.role as string,
    }))

    return {
      id: tenant.id as string,
      name: tenant.name as string,
      slug: tenant.slug as string,
      members,
      connections: connectionMap,
    }
  })
}

