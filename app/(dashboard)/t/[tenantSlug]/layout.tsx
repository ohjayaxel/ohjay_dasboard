import { ReactNode } from 'react'
import { AppSidebar } from '@/components/app-sidebar'
import { SiteHeader } from '@/components/site-header'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { getCurrentUser } from '@/lib/auth/current-user'
import { isPlatformAdmin } from '@/lib/auth/roles'
import { resolveTenantBySlug } from '@/lib/tenants/resolve-tenant'

interface TenantLayoutProps {
  children: ReactNode
  params: Promise<{ tenantSlug: string }>
}

export default async function TenantLayout({ children, params }: TenantLayoutProps) {
  const { tenantSlug } = await params
  const tenant = await resolveTenantBySlug(tenantSlug)
  const user = await getCurrentUser()
  const environment = process.env.APP_ENV ?? 'development'

  const navMain = [
    {
      title: 'Overview',
      url: `/t/${tenantSlug}`,
      icon: 'gauge',
    },
    {
      title: 'Meta Ads',
      url: `/t/${tenantSlug}/meta`,
      icon: 'brand-meta',
    },
    {
      title: 'Google Ads',
      url: `/t/${tenantSlug}/google`,
      icon: 'brand-google',
    },
    {
      title: 'Shopify',
      url: `/t/${tenantSlug}/shopify`,
      icon: 'brand-shopify',
    },
  ]

  if (isPlatformAdmin(user.role)) {
    navMain.push({
      title: 'Admin Console',
      url: '/admin',
      icon: 'settings',
    })
  }

  const documents = [
    {
      name: 'KPI Library',
      url: `/t/${tenantSlug}`,
      icon: 'chart-dots',
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
        tenantName={tenant.name}
        navMain={navMain}
        documents={documents}
        user={{
          name: user.name,
          email: user.email,
          avatar: user.avatar ?? '/placeholder-user.jpg',
        }}
      />
      <SidebarInset>
        <SiteHeader title={tenant.name} environment={environment} />
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex flex-1 flex-col gap-6 p-4 md:p-6">
            {children}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
