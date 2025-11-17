export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { addTenantMember, removeTenantMember } from '@/app/(dashboard)/admin/actions'
import { getAdminTenantBySlug } from '@/lib/admin/tenants'
import { Roles } from '@/lib/auth/roles'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
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

type PageProps = {
  params: Promise<{
    tenantSlug: string
  }>
  searchParams?: Promise<{
    status?: string
    error?: string
  }>
}

export default async function AdminTenantMembersPage(props: PageProps) {
  const [{ tenantSlug }, searchParams] = await Promise.all([props.params, props.searchParams ?? Promise.resolve({})])
  const tenant = await getAdminTenantBySlug(tenantSlug)

  if (!tenant) {
    notFound()
  }

  const status = searchParams?.status
  const error = searchParams?.error

  const statusMessage = status
    ? (() => {
        switch (status) {
          case 'member-added':
            return 'Member added successfully.'
          case 'member-removed':
            return 'Member removed successfully.'
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
            <Link href={`/admin/tenants/${tenantSlug}`}>← Back to overview</Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg font-semibold">Members</CardTitle>
          <Badge variant="secondary" className="text-xs">
            {tenant.members.length} member{tenant.members.length === 1 ? '' : 's'}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="overflow-hidden rounded-xl border border-border/60 bg-background/60">
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
                          <input type="hidden" name="tenantSlug" value={tenant.slug} />
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

          <form
            action={addTenantMember}
            className="grid gap-4 rounded-xl border border-dashed border-muted/60 bg-background/60 p-4 md:grid-cols-[minmax(0,1fr)_200px_auto] md:items-end"
          >
            <input type="hidden" name="tenantId" value={tenant.id} />
            <input type="hidden" name="tenantSlug" value={tenant.slug} />
            <div className="flex-1 space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" placeholder="user@example.com" required />
            </div>
            <div className="w-full space-y-2 md:w-[200px]">
              <Label htmlFor="role">Role</Label>
              <select
                id="role"
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
    </div>
  )
}

