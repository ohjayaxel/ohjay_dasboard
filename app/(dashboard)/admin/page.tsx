import { addTenantMember, removeTenantMember } from '@/app/(dashboard)/admin/actions'
import { listAdminTenants } from '@/lib/admin/tenants'
import { Roles } from '@/lib/auth/roles'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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

export default async function AdminTenantsPage() {
  const tenants = await listAdminTenants()

  return (
    <div className="space-y-6">
      {tenants.map((tenant) => (
        <Card key={tenant.id}>
          <CardHeader>
            <CardTitle className="flex flex-col gap-1">
              <span className="text-lg font-semibold">{tenant.name}</span>
              <span className="text-sm font-normal text-muted-foreground">/{tenant.slug}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead className="w-[110px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tenant.members.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                        No members yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    tenant.members.map((member) => (
                      <TableRow key={member.id}>
                        <TableCell className="font-medium">{member.email ?? 'Unknown email'}</TableCell>
                        <TableCell className="uppercase tracking-wide text-sm text-muted-foreground">
                          {member.role.replace('_', ' ')}
                        </TableCell>
                        <TableCell className="text-right">
                          <form action={removeTenantMember}>
                            <input type="hidden" name="memberId" value={member.id} />
                            <Button type="submit" variant="ghost" size="sm">
                              Remove
                            </Button>
                          </form>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <form action={addTenantMember} className="flex flex-col gap-4 rounded-xl border p-4 md:flex-row md:items-end">
              <input type="hidden" name="tenantId" value={tenant.id} />
              <div className="flex-1 space-y-2">
                <Label htmlFor={`email-${tenant.id}`}>Email</Label>
                <Input
                  id={`email-${tenant.id}`}
                  name="email"
                  type="email"
                  placeholder="user@example.com"
                  required
                />
              </div>
              <div className="w-full md:w-[200px] space-y-2">
                <Label htmlFor={`role-${tenant.id}`}>Role</Label>
                <select
                  id={`role-${tenant.id}`}
                  name="role"
                  defaultValue={Roles.viewer}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" className="md:self-end">
                Add member
              </Button>
            </form>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

