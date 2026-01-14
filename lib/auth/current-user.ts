import { redirect } from 'next/navigation'

import { isPlatformAdmin, Roles, type Role } from '@/lib/auth/roles'
import { getSupabaseServerComponentClient } from '@/lib/supabase/server-auth'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export type CurrentUser = {
  id: string
  email: string
  name: string
  role: Role
  avatar?: string | null
}

/**
 * Current user lookup via Supabase Auth session + members role.
 */
export async function getCurrentUser(): Promise<CurrentUser> {
  const supabase = getSupabaseServerComponentClient()
  const { data, error } = await supabase.auth.getUser()

  if (error || !data.user) {
    redirect('/signin')
  }

  const user = data.user
  const email = user.email ?? ''

  // Resolve role from members table (service role to bypass RLS safely server-side)
  const service = getSupabaseServiceClient()
  const { data: memberships, error: memberError } = await service
    .from('members')
    .select('role')
    .eq('user_id', user.id)

  if (memberError) {
    // If we can't resolve membership, treat as unauthenticated for protected areas.
    redirect('/signin')
  }

  const roles = new Set<string>((memberships ?? []).map((m: any) => m.role).filter(Boolean))
  const role: Role = roles.has(Roles.platformAdmin)
    ? Roles.platformAdmin
    : roles.has(Roles.admin)
      ? Roles.admin
      : roles.has(Roles.editor)
        ? Roles.editor
        : Roles.viewer

  return {
    id: user.id,
    email,
    name: (user.user_metadata?.full_name as string) || email || 'User',
    role,
    avatar: (user.user_metadata?.avatar_url as string) ?? '/placeholder-user.jpg',
  }
}

export async function requirePlatformAdmin(): Promise<CurrentUser> {
  const user = await getCurrentUser()

  if (!isPlatformAdmin(user.role)) {
    redirect('/signin')
  }

  return user
}

