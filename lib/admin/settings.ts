import { getSupabaseServiceClient } from '@/lib/supabase/server'

export type PlatformAdmin = {
  id: string
  userId: string
  email: string | null
  tenantId: string
  tenantName: string
  tenantSlug: string
  role: string
}

export type AdminTenantMembership = {
  tenantId: string
  tenantName: string
  tenantSlug: string
  role: string
}

/**
 * Get all users with platform_admin role across all tenants
 */
export async function getPlatformAdmins(): Promise<PlatformAdmin[]> {
  const client = getSupabaseServiceClient()

  const { data, error } = await client
    .from('members')
    .select(
      `
      id,
      user_id,
      email,
      role,
      tenant_id,
      tenants!inner(
        id,
        name,
        slug
      )
    `,
    )
    .eq('role', 'platform_admin')
    .order('email')

  if (error) {
    throw new Error(`Failed to fetch platform admins: ${error.message}`)
  }

  return (data ?? []).map((member: any) => ({
    id: member.id as string,
    userId: member.user_id as string,
    email: member.email as string | null,
    tenantId: member.tenant_id as string,
    tenantName: (member.tenants as any)?.name as string,
    tenantSlug: (member.tenants as any)?.slug as string,
    role: member.role as string,
  }))
}

/**
 * Get all tenant memberships for a specific user
 */
export async function getUserTenants(userId: string): Promise<AdminTenantMembership[]> {
  const client = getSupabaseServiceClient()

  const { data, error } = await client
    .from('members')
    .select(
      `
      tenant_id,
      role,
      tenants!inner(
        id,
        name,
        slug
      )
    `,
    )
    .eq('user_id', userId)
    .order('tenants(name)')

  if (error) {
    throw new Error(`Failed to fetch user tenants: ${error.message}`)
  }

  return (data ?? []).map((member: any) => ({
    tenantId: member.tenant_id as string,
    tenantName: (member.tenants as any)?.name as string,
    tenantSlug: (member.tenants as any)?.slug as string,
    role: member.role as string,
  }))
}

/**
 * Check if a user has platform_admin role in any tenant
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const client = getSupabaseServiceClient()

  const { data, error } = await client
    .from('members')
    .select('id')
    .eq('user_id', userId)
    .eq('role', 'platform_admin')
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to check platform admin status: ${error.message}`)
  }

  return !!data
}

/**
 * Group platform admins by userId to see all their tenant memberships
 */
export async function getPlatformAdminsGrouped(): Promise<
  Array<{
    userId: string
    email: string | null
    tenantMemberships: Array<AdminTenantMembership & { memberId: string }>
  }>
> {
  const admins = await getPlatformAdmins()

  // Group by userId
  const grouped = new Map<string, { userId: string; email: string | null; tenantMemberships: Array<AdminTenantMembership & { memberId: string }> }>()

  for (const admin of admins) {
    const existing = grouped.get(admin.userId)
    if (existing) {
      existing.tenantMemberships.push({
        memberId: admin.id,
        tenantId: admin.tenantId,
        tenantName: admin.tenantName,
        tenantSlug: admin.tenantSlug,
        role: admin.role,
      })
    } else {
      grouped.set(admin.userId, {
        userId: admin.userId,
        email: admin.email,
        tenantMemberships: [
          {
            memberId: admin.id,
            tenantId: admin.tenantId,
            tenantName: admin.tenantName,
            tenantSlug: admin.tenantSlug,
            role: admin.role,
          },
        ],
      })
    }
  }

  return Array.from(grouped.values()).sort((a, b) => {
    const emailA = a.email?.toLowerCase() ?? ''
    const emailB = b.email?.toLowerCase() ?? ''
    return emailA.localeCompare(emailB)
  })
}

export type AllUsersGrouped = Array<{
  userId: string
  name: string | null
  email: string | null
  userType: 'platform_admin' | 'admin' | 'editor' | 'viewer'
  tenantMemberships: Array<AdminTenantMembership & { memberId: string }>
}>

/**
 * Get all users grouped by userId with all their tenant memberships
 * Platform admins are shown with access to all tenants
 */
export async function getAllUsersGrouped(): Promise<AllUsersGrouped> {
  const client = getSupabaseServiceClient()

  // Get all members
  const { data, error } = await client
    .from('members')
    .select(
      `
      id,
      user_id,
      name,
      email,
      role,
      tenant_id,
      tenants!inner(
        id,
        name,
        slug
      )
    `,
    )
    .order('email')

  if (error) {
    throw new Error(`Failed to fetch all users: ${error.message}`)
  }

  // Group by userId
  const grouped = new Map<string, { userId: string; name: string | null; email: string | null; roles: Set<string>; tenantMemberships: Array<AdminTenantMembership & { memberId: string }> }>()

  for (const member of data ?? []) {
    const userId = member.user_id as string
    const existing = grouped.get(userId)
    
    const membership: AdminTenantMembership & { memberId: string } = {
      memberId: member.id as string,
      tenantId: member.tenant_id as string,
      tenantName: (member.tenants as any)?.name as string,
      tenantSlug: (member.tenants as any)?.slug as string,
      role: member.role as string,
    }

    if (existing) {
      existing.roles.add(member.role as string)
      existing.tenantMemberships.push(membership)
      if (!existing.name && (member.name as string | null)) {
        existing.name = member.name as string
      }
    } else {
      grouped.set(userId, {
        userId,
        name: member.name as string | null,
        email: member.email as string | null,
        roles: new Set([member.role as string]),
        tenantMemberships: [membership],
      })
    }
  }

  // Determine user type (platform_admin > admin > editor > viewer)
  const rolePriority: Record<string, number> = {
    platform_admin: 4,
    admin: 3,
    editor: 2,
    viewer: 1,
  }

  return Array.from(grouped.values())
    .map((user) => {
      const highestRole = Array.from(user.roles).sort((a, b) => (rolePriority[b] ?? 0) - (rolePriority[a] ?? 0))[0] ?? 'viewer'
      
      return {
        userId: user.userId,
        name: user.name,
        email: user.email,
        userType: highestRole as 'platform_admin' | 'admin' | 'editor' | 'viewer',
        tenantMemberships: user.tenantMemberships.sort((a, b) => a.tenantName.localeCompare(b.tenantName)),
      }
    })
    .sort((a, b) => {
      const emailA = a.email?.toLowerCase() ?? ''
      const emailB = b.email?.toLowerCase() ?? ''
      return emailA.localeCompare(emailB)
    })
}

