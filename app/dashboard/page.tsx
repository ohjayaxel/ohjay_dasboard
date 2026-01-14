import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'

import { getCurrentUser } from '@/lib/auth/current-user'
import { getUserTenants } from '@/lib/admin/settings'
import { isPlatformAdmin } from '@/lib/auth/roles'
import { DashboardSelection } from '@/components/dashboard-selection'

export default async function DashboardPage() {
  const user = await getCurrentUser()
  const userTenants = await getUserTenants(user.id)
  const userIsAdmin = isPlatformAdmin(user.role)

  // Check for saved tenant preference in cookies
  const cookieStore = await cookies()
  const savedTenantSlug = cookieStore.get('selectedTenant')?.value

  // If user has a saved tenant preference, redirect to it
  if (savedTenantSlug) {
    const savedTenant = userTenants.find((t) => t.tenantSlug === savedTenantSlug)
    if (savedTenant) {
      redirect(`/t/${savedTenantSlug}`)
    }
  }

  // If user only has one tenant, redirect directly to it
  if (userTenants.length === 1) {
    redirect(`/t/${userTenants[0].tenantSlug}`)
  }

  // If user has multiple tenants or admin access, show selection page
  if (userTenants.length > 1 || userIsAdmin) {
    return <DashboardSelection userTenants={userTenants} isAdmin={userIsAdmin} />
  }

  // Fallback: if no tenants, redirect to signin
  redirect('/signin')
}
