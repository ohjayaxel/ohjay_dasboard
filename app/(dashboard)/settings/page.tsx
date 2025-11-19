export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'

import { addPlatformAdmin, removePlatformAdmin, updatePlatformAdminRole } from '@/app/(dashboard)/admin/actions'
import { getPlatformAdminsGrouped } from '@/lib/admin/settings'
import { requirePlatformAdmin } from '@/lib/auth/current-user'
import { Roles } from '@/lib/auth/roles'
import { listAdminTenants } from '@/lib/admin/tenants'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const ROLE_OPTIONS = [
  { label: 'Platform admin', value: Roles.platformAdmin },
  { label: 'Tenant admin', value: Roles.admin },
  { label: 'Editor', value: Roles.editor },
  { label: 'Viewer', value: Roles.viewer },
]

type PageProps = {
  searchParams?: Promise<{
    status?: string
    error?: string
  }>
}

export default async function AdminSettingsPage(props: PageProps) {
  const user = await requirePlatformAdmin()
  const searchParams = await props.searchParams ?? Promise.resolve({})
  const platformAdmins = await getPlatformAdminsGrouped()
  const tenants = await listAdminTenants()

  const status = searchParams?.status
  const error = searchParams?.error

  const statusMessage = status
    ? (() => {
        switch (status) {
          case 'platform-admin-added':
            return 'Platform admin added successfully.'
          case 'platform-admin-removed':
            return 'Platform admin removed successfully.'
          case 'role-updated':
            return 'Role updated successfully.'
          default:
            return 'Changes saved.'
        }
      })()
    : null

  return (
    <div className="space-y-6">
      {(statusMessage || error) && (
        <Alert variant={error ? 'destructive' : 'default'}>
          <AlertDescription>
            {error ?? statusMessage}
          </AlertDescription>
        </Alert>
      )}

      <div>
        <h1 className="text-2xl font-semibold leading-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage platform administrators</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Platform Admins</CardTitle>
          <CardDescription>
            Users with platform_admin role have full access to all tenants and admin features. Only you (super-admin) can manage these.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="overflow-hidden rounded-xl border border-border/60 bg-background/60">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Tenants</TableHead>
                  <TableHead className="w-[110px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {platformAdmins.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                      No platform admins yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  platformAdmins.map((admin) => (
                    <TableRow key={admin.userId}>
                      <TableCell className="font-medium">
                        {admin.email ?? 'Unknown email'}
                        {admin.userId === user.id && (
                          <Badge variant="default" className="ml-2 text-xs">
                            You
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {admin.tenantMemberships.map((membership) => (
                            <Badge key={membership.tenantId} variant="outline" className="text-xs">
                              {membership.tenantName}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {admin.userId === user.id ? (
                          <span className="text-xs text-muted-foreground">Current user</span>
                        ) : (
                          <div className="flex gap-2 justify-end">
                            {admin.tenantMemberships.map((membership) => (
                              <form key={membership.memberId} action={removePlatformAdmin}>
                                <input type="hidden" name="memberId" value={membership.memberId} />
                                <Button type="submit" variant="ghost" size="sm">
                                  Remove from {membership.tenantName}
                                </Button>
                              </form>
                            ))}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <form
            action={addPlatformAdmin}
            className="grid gap-4 rounded-xl border border-dashed border-muted/60 bg-background/60 p-4 md:grid-cols-[minmax(0,1fr)_200px_auto] md:items-end"
          >
            <div className="flex-1 space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" placeholder="user@example.com" required />
            </div>
            <div className="w-full space-y-2 md:w-[200px]">
              <Label htmlFor="tenantId">Tenant</Label>
              <select
                id="tenantId"
                name="tenantId"
                className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                required
              >
                {tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" className="md:self-end">
              Add Platform Admin
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

