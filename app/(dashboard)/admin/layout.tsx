import { ReactNode } from 'react'

import { AppSidebar } from '@/components/app-sidebar'
import { SiteHeader } from '@/components/site-header'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { requirePlatformAdmin } from '@/lib/auth/current-user'
import { listAdminTenants } from '@/lib/admin/tenants'

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requirePlatformAdmin()
  const tenants = await listAdminTenants()
  const environment = process.env.APP_ENV ?? 'development'

  const navMain = [
    {
      title: 'All tenants',
      url: '/admin',
      icon: 'gauge',
    },
    {
      title: 'Settings',
      url: '/admin/settings',
      icon: 'settings',
    },
    ...tenants.map((tenant) => ({
      title: tenant.name,
      url: `/admin/tenants/${tenant.slug}`,
      icon: 'users',
    })),
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

