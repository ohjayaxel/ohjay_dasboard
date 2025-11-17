export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { getAdminTenantBySlug } from '@/lib/admin/tenants'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type PageProps = {
  params: Promise<{
    tenantSlug: string
  }>
}

export default async function AdminTenantOverviewPage(props: PageProps) {
  const { tenantSlug } = await props.params
  const tenant = await getAdminTenantBySlug(tenantSlug)

  if (!tenant) {
    notFound()
  }

  const totalIntegrations = Object.values(tenant.connections).length
  const connectedIntegrations = Object.values(tenant.connections).filter(
    (connection) => connection.status === 'connected',
  ).length

  const membersByRole = tenant.members.reduce(
    (acc, member) => {
      acc[member.role] = (acc[member.role] || 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )

  const platformAdmins = membersByRole.platform_admin || 0
  const tenantAdmins = membersByRole.admin || 0
  const editors = membersByRole.editor || 0
  const viewers = membersByRole.viewer || 0

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Tenant</p>
          <h1 className="text-2xl font-semibold leading-tight">{tenant.name}</h1>
          <p className="text-sm text-muted-foreground">/{tenant.slug}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild variant="default">
            <Link href={`/t/${tenant.slug}`}>Open {tenant.name}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin">← Back to all tenants</Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="cursor-pointer transition-colors hover:bg-accent/50" asChild>
          <Link href={`/admin/tenants/${tenantSlug}/integrations`}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg font-semibold">Integrations</CardTitle>
                <Badge variant={connectedIntegrations > 0 ? 'outline' : 'secondary'} className="text-xs">
                  {connectedIntegrations}/{totalIntegrations} connected
                </Badge>
              </div>
              <CardDescription>Manage Meta Ads, Google Ads, and Shopify connections</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Meta Ads</span>
                  <Badge
                    variant={tenant.connections.meta.status === 'connected' ? 'default' : 'secondary'}
                    className="text-xs"
                  >
                    {tenant.connections.meta.status}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Google Ads</span>
                  <Badge
                    variant={tenant.connections.google_ads.status === 'connected' ? 'default' : 'secondary'}
                    className="text-xs"
                  >
                    {tenant.connections.google_ads.status}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Shopify</span>
                  <Badge
                    variant={tenant.connections.shopify.status === 'connected' ? 'default' : 'secondary'}
                    className="text-xs"
                  >
                    {tenant.connections.shopify.status}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Link>
        </Card>

        <Card className="cursor-pointer transition-colors hover:bg-accent/50" asChild>
          <Link href={`/admin/tenants/${tenantSlug}/members`}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg font-semibold">Members</CardTitle>
                <Badge variant="secondary" className="text-xs">
                  {tenant.members.length} member{tenant.members.length === 1 ? '' : 's'}
                </Badge>
              </div>
              <CardDescription>Manage user access and roles for this tenant</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {platformAdmins > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Platform admins</span>
                    <Badge variant="default" className="text-xs">
                      {platformAdmins}
                    </Badge>
                  </div>
                )}
                {tenantAdmins > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Tenant admins</span>
                    <Badge variant="secondary" className="text-xs">
                      {tenantAdmins}
                    </Badge>
                  </div>
                )}
                {editors > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Editors</span>
                    <Badge variant="outline" className="text-xs">
                      {editors}
                    </Badge>
                  </div>
                )}
                {viewers > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Viewers</span>
                    <Badge variant="outline" className="text-xs">
                      {viewers}
                    </Badge>
                  </div>
                )}
                {tenant.members.length === 0 && (
                  <p className="text-sm text-muted-foreground">No members yet</p>
                )}
              </div>
            </CardContent>
          </Link>
        </Card>
      </div>
    </div>
  )
}
