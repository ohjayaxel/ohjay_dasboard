export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { listAdminTenants } from '@/lib/admin/tenants'
import { getUserTenants } from '@/lib/admin/settings'
import { requirePlatformAdmin } from '@/lib/auth/current-user'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export default async function AdminTenantsPage() {
  const user = await requirePlatformAdmin()
  const allTenants = await listAdminTenants()
  const userTenants = await getUserTenants(user.id)
  const userTenantIds = new Set(userTenants.map((t) => t.tenantId))
  
  // Filter tenants to only show those the user has access to
  const tenants = allTenants.filter((tenant) => userTenantIds.has(tenant.id))

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-lg font-semibold">Tenants</CardTitle>
            <CardDescription>Manage customer workspaces, access, and integrations.</CardDescription>
          </div>
          <Button asChild variant="default">
            <Link href="/admin/tenants/new">Add new tenant</Link>
          </Button>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Members</TableHead>
                  <TableHead>Integrations</TableHead>
                  <TableHead className="w-[140px] text-right">Manage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                      No tenants found.
                    </TableCell>
                  </TableRow>
                ) : (
                  tenants.map((tenant) => {
                    const totalIntegrations = Object.values(tenant.connections).length
                    const connectedIntegrations = Object.values(tenant.connections).filter(
                      (connection) => connection.status === 'connected',
                    ).length

                    return (
                      <TableRow key={tenant.id} className="cursor-pointer hover:bg-accent/50">
                        <TableCell>
                          <Link href={`/admin/tenants/${tenant.slug}`} className="block">
                            <div className="flex flex-col">
                              <span className="font-medium">{tenant.name}</span>
                              <span className="text-sm text-muted-foreground">/{tenant.slug}</span>
                            </div>
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Link href={`/admin/tenants/${tenant.slug}`} className="block">
                            <Badge variant="secondary" className="text-xs">
                              {tenant.members.length} member{tenant.members.length === 1 ? '' : 's'}
                            </Badge>
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Link href={`/admin/tenants/${tenant.slug}`} className="block">
                            <Badge variant={connectedIntegrations > 0 ? 'outline' : 'secondary'} className="text-xs">
                              {connectedIntegrations}/{totalIntegrations} connected
                            </Badge>
                          </Link>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button asChild variant="outline" size="sm">
                            <Link href={`/admin/tenants/${tenant.slug}`}>Open tenant</Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

