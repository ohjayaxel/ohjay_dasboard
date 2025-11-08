export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import {
  addTenantMember,
  disconnectMeta,
  removeTenantMember,
  startMetaConnect,
  updateMetaSelectedAccount,
} from '@/app/(dashboard)/admin/actions'
import { getAdminTenantBySlug } from '@/lib/admin/tenants'
import { Roles } from '@/lib/auth/roles'

import { GoogleAdsConnect } from '@/components/connections/GoogleAdsConnect'
import { MetaConnect } from '@/components/connections/MetaConnect'
import { ShopifyConnect } from '@/components/connections/ShopifyConnect'
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

export default async function AdminTenantDetailPage(props: PageProps) {
  const [{ tenantSlug }, searchParams] = await Promise.all([props.params, props.searchParams ?? Promise.resolve({})])
  const tenant = await getAdminTenantBySlug(tenantSlug)

  if (!tenant) {
    notFound()
  }

  const meta = tenant.connections.meta
  const google = tenant.connections.google_ads
  const shopify = tenant.connections.shopify
  const status = searchParams?.status
  const error = searchParams?.error
  const metaDetails = (meta.meta ?? {}) as Record<string, unknown>
  const metaAccounts = Array.isArray(metaDetails.accounts)
    ? (metaDetails.accounts as Array<{ account_id?: string; name?: string }>)
        .filter((account) => typeof account?.account_id === 'string')
        .map((account) => ({
          id: account.account_id as string,
          name: account?.name ?? account.account_id,
        }))
    : []
  const selectedMetaAccountId =
    typeof metaDetails.selected_account_id === 'string' ? (metaDetails.selected_account_id as string) : null
  const selectedMetaAccountName =
    metaAccounts.find((account) => account.id === selectedMetaAccountId)?.name ?? selectedMetaAccountId ?? 'Not set'
  const formatTimestamp = (value?: string | null) => {
    if (!value) return null
    try {
      return new Intl.DateTimeFormat('sv-SE', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Europe/Stockholm',
      }).format(new Date(value))
    } catch (formatError) {
      console.warn('Failed to format timestamp', formatError)
      return value
    }
  }
  const metaLastSyncedLabel = formatTimestamp(meta.updatedAt)
  const statusMessage = status
    ? (() => {
        switch (status) {
          case 'member-added':
            return 'Member added successfully.'
          case 'member-removed':
            return 'Member removed successfully.'
          case 'meta-connected':
            return 'Meta connection established.'
          case 'meta-disconnected':
            return 'Meta connection removed.'
          default:
            return 'Changes saved.'
        }
      })()
    : null
  const metaConnectAction = startMetaConnect.bind(null, { tenantId: tenant.id, tenantSlug: tenant.slug })
  const metaDisconnectAction = disconnectMeta.bind(null, { tenantId: tenant.id, tenantSlug: tenant.slug })

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
            <Link href="/admin">← Back to all tenants</Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Integrations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-8">
          <MetaConnect
            status={meta.status}
            lastSyncedAt={meta.updatedAt ?? undefined}
            lastSyncedLabel={metaLastSyncedLabel ?? undefined}
            onConnect={metaConnectAction}
            onDisconnect={metaDisconnectAction}
          />
          <GoogleAdsConnect status={google.status} lastSyncedAt={google.updatedAt ?? undefined} />
          <ShopifyConnect status={shopify.status} lastSyncedAt={shopify.updatedAt ?? undefined} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-lg font-semibold">Meta ad account</CardTitle>
            <p className="text-sm text-muted-foreground">Choose which ad account to sync data from.</p>
          </div>
          <Badge variant={selectedMetaAccountId ? 'default' : 'secondary'} className="text-xs">
            {selectedMetaAccountId ? 'Connected' : 'Not selected'}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">Current selection</p>
            <p className="font-medium">{selectedMetaAccountName}</p>
          </div>

          {metaAccounts.length > 0 ? (
            <form action={updateMetaSelectedAccount} className="flex flex-col gap-3 md:flex-row md:items-end">
              <input type="hidden" name="tenantId" value={tenant.id} />
              <input type="hidden" name="tenantSlug" value={tenant.slug} />
              <div className="flex-1 space-y-2">
                <Label htmlFor="meta-account">Select ad account</Label>
                <select
                  id="meta-account"
                  name="accountId"
                  defaultValue={selectedMetaAccountId ?? metaAccounts[0]?.id ?? ''}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  required
                >
                  {metaAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" className="md:w-auto">
                Save selection
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              No ad accounts were returned for this user. Reconnect Meta or verify that the user has access to the desired
              ad account.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg font-semibold">Members</CardTitle>
          <Badge variant="secondary" className="text-xs">
            {tenant.members.length} member{tenant.members.length === 1 ? '' : 's'}
          </Badge>
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

          <form action={addTenantMember} className="flex flex-col gap-4 rounded-xl border p-4 md:flex-row md:items-end">
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


