import { ReactNode } from 'react'

import { AppSidebar } from '@/components/app-sidebar'
import { SiteHeader } from '@/components/site-header'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { requirePlatformAdmin } from '@/lib/auth/current-user'
import { listAdminTenants } from '@/lib/admin/tenants'
import { getUserTenants } from '@/lib/admin/settings'

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const user = await requirePlatformAdmin()
  const allTenants = await listAdminTenants()
  const userTenants = await getUserTenants(user.id)
  const userTenantIds = new Set(userTenants.map((t) => t.tenantId))
  
  // Filter tenants to only show those the user has access to
  const tenants = allTenants.filter((tenant) => userTenantIds.has(tenant.id))
  
  const environment = process.env.APP_ENV ?? 'development'

  const navMain = [
    {
      title: 'All tenants',
      url: '/admin',
      icon: 'gauge',
      items: tenants.map((tenant) => ({
        title: tenant.name,
        url: `/admin/tenants/${tenant.slug}`,
      })),
    },
    {
      title: 'Audits',
      url: '/admin/audits',
      icon: 'list-details',
      items: [
        {
          title: 'Orders',
          url: '/admin/audits/orders',
        },
      ],
    },
    {
      title: 'Settings',
      url: '/settings',
      icon: 'settings',
    },
  ]

  return (
    <SidebarProvider
      style={{
        '--sidebar-width': 'calc(var(--spacing) * 72)',
        '--header-height': 'calc(var(--spacing) * 12)',
      }}
    >
      <AppSidebar
        variant="inset"
        tenantName="Admin Console"
        navMain={navMain}
        navSecondary={[
          { title: 'Get Help', url: '#', icon: 'help' },
          { title: 'Search', url: '#', icon: 'search' },
        ]}
        documents={[]}
        user={{
          name: user.name,
          email: user.email,
          avatar: user.avatar ?? '/placeholder-user.jpg',
        }}
      />
      <SidebarInset>
        <SiteHeader title="Admin Console" environment={environment} />
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex flex-1 flex-col gap-6 p-4 md:p-6">{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

