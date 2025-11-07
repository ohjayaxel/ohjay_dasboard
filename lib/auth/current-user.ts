import { redirect } from 'next/navigation'

import { isPlatformAdmin, Roles, type Role } from '@/lib/auth/roles'

export type CurrentUser = {
  id: string
  email: string
  name: string
  role: Role
  avatar?: string | null
}

/**
 * TODO: Replace this stub with real session lookup when Supabase Auth is wired up.
 */
export async function getCurrentUser(): Promise<CurrentUser> {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    email: 'admin@ohjay.co',
    name: 'Platform Admin',
    role: Roles.platformAdmin,
    avatar: '/placeholder-user.jpg',
  }
}

export async function requirePlatformAdmin(): Promise<CurrentUser> {
  const user = await getCurrentUser()

  if (!isPlatformAdmin(user.role)) {
    redirect('/signin')
  }

  return user
}

