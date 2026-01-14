export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'

import { addPlatformAdmin, removePlatformAdmin, updatePlatformAdminRole } from '@/app/(dashboard)/admin/actions'
import { getAllUsersGrouped, getUserTenants } from '@/lib/admin/settings'
import { requirePlatformAdmin } from '@/lib/auth/current-user'
import { Roles, isPlatformAdmin } from '@/lib/auth/roles'
import { listAdminTenants } from '@/lib/admin/tenants'

import { AddUserForm } from '@/components/admin/add-user-form'
import { EditUserDialog } from '@/components/admin/edit-user-dialog'
import { TenantPopover } from '@/components/admin/tenant-popover'
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

const USER_TYPE_LABELS: Record<string, string> = {
  platform_admin: 'Platform Admin',
  admin: 'Tenant Admin',
  editor: 'Editor',
  viewer: 'Viewer',
}

type PageProps = {
  searchParams?: Promise<{
    status?: string
    error?: string
  }>
}

export default async function AdminSettingsPage(props: PageProps) {
  const user = await requirePlatformAdmin()
  const searchParams = await props.searchParams ?? Promise.resolve({})
  const allUsers = await getAllUsersGrouped()
  const allTenants = await listAdminTenants()
  const userTenants = await getUserTenants(user.id)
  const userTenantIds = new Set(userTenants.map((t) => t.tenantId))
  
  // Filter tenants to only show those the user has access to (for navigation/listings)
  const tenants = allTenants.filter((tenant) => userTenantIds.has(tenant.id))
  
  // For user management forms, Platform Admins should see all tenants
  const tenantsForUserManagement = isPlatformAdmin(user.role) ? allTenants : tenants

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
          case 'user-added':
            return 'User added successfully.'
          case 'user-updated':
            return 'User updated successfully.'
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
        <p className="text-sm text-muted-foreground">Manage users and platform administrators</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Users</CardTitle>
          <CardDescription>
            All users with access to tenants. Click on the tenant count to see details.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="overflow-hidden rounded-xl border border-border/60 bg-background/60">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Tenants</TableHead>
                  <TableHead>User Type</TableHead>
                  <TableHead className="w-[100px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allUsers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                      No users yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  allUsers.map((userData) => (
                    <TableRow key={userData.userId}>
                      <TableCell className="font-medium">
                        {userData.name ?? '—'}
                      </TableCell>
                      <TableCell className="font-medium">
                        {userData.email ?? 'Unknown email'}
                        {userData.userId === user.id && (
                          <Badge variant="default" className="ml-2 text-xs">
                            You
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <TenantPopover tenants={userData.tenantMemberships}>
                          {userData.tenantMemberships.length}
                        </TenantPopover>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {USER_TYPE_LABELS[userData.userType] ?? userData.userType}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <EditUserDialog user={userData} tenants={tenantsForUserManagement} roleOptions={ROLE_OPTIONS} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <AddUserForm tenants={tenantsForUserManagement} roleOptions={ROLE_OPTIONS} />
        </CardContent>
      </Card>
    </div>
  )
}

