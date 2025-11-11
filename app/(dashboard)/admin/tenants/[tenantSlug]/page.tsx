export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import {
  addTenantMember,
  disconnectMeta,
  removeTenantMember,
  startMetaConnect,
  triggerMetaBackfill,
  triggerMetaSyncNow,
  updateMetaSelectedAccount,
  updateIntegrationSettings,
} from '@/app/(dashboard)/admin/actions'
import { getAdminTenantBySlug } from '@/lib/admin/tenants'
import { Roles } from '@/lib/auth/roles'

import { KpiDropdown } from '@/components/admin/kpi-dropdown'
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

const KPI_OPTIONS = [
  { value: 'spend', label: 'Spend', description: 'Total advertising spend' },
  { value: 'revenue', label: 'Revenue', description: 'Attributed revenue' },
  { value: 'conversions', label: 'Purchases', description: 'Total orders or conversions' },
  { value: 'clicks', label: 'Clicks', description: 'Total ad clicks' },
  { value: 'roas', label: 'ROAS', description: 'Return on ad spend' },
  { value: 'cos', label: 'Cost of sale', description: 'Spend divided by revenue' },
  { value: 'aov', label: 'Average order value', description: 'Revenue per conversion' },
] as const

const DEFAULT_KPI_KEYS = ['spend', 'revenue', 'conversions', 'roas']

const SOURCE_LABELS: Record<string, string> = {
  meta: 'Meta Ads',
  google_ads: 'Google Ads',
  shopify: 'Shopify',
}

type PageProps = {
  params: Promise<{
    tenantSlug: string
  }>
  searchParams?: Promise<{
    status?: string
    error?: string
    source?: string
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
  const statusSource = searchParams?.source
  const error = searchParams?.error

  const toDateInputValue = (value: unknown): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return ''
    }
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10)
    }
    return value.slice(0, 10)
  }

  const normalizeKpis = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string')
    }
    return DEFAULT_KPI_KEYS
  }

  const metaDetails = (meta.meta ?? {}) as Record<string, unknown>
  const googleDetails = (google.meta ?? {}) as Record<string, unknown>
  const shopifyDetails = (shopify.meta ?? {}) as Record<string, unknown>

  const todayIso = new Date().toISOString().slice(0, 10)

  const metaSyncStartDate = toDateInputValue(metaDetails.sync_start_date)
  const googleSyncStartDate = toDateInputValue(googleDetails.sync_start_date)
  const shopifySyncStartDate = toDateInputValue(shopifyDetails.sync_start_date)

  const metaDisplayKpis = normalizeKpis(metaDetails.display_kpis)
  const googleDisplayKpis = normalizeKpis(googleDetails.display_kpis)
  const shopifyDisplayKpis = normalizeKpis(shopifyDetails.display_kpis)

  const metaAccounts = Array.isArray(metaDetails.ad_accounts)
    ? (metaDetails.ad_accounts as Array<{ id?: string; account_id?: string; name?: string }>).filter(
        (account) => typeof account?.account_id === 'string',
      )
        .map((account) => ({
          id: account.id ?? (`act_${account.account_id}` as string),
          accountId: account.account_id as string,
          name: account?.name ?? account.account_id,
        }))
    : []

  const selectedMetaAccountId =
    typeof metaDetails.selected_account_id === 'string' ? (metaDetails.selected_account_id as string) : null
  const selectedMetaAccountName =
    metaAccounts.find((account) => account.id === selectedMetaAccountId || account.accountId === selectedMetaAccountId)?.name ??
    selectedMetaAccountId ??
    'Not set'

  const metaAccountsError =
    typeof metaDetails.accounts_error === 'string' && metaDetails.accounts_error.length > 0
      ? (metaDetails.accounts_error as string)
      : null

  const googleCustomerId =
    typeof googleDetails.customer_id === 'string' && googleDetails.customer_id.length > 0
      ? (googleDetails.customer_id as string)
      : null

  const shopifyStoreDomain =
    typeof shopifyDetails.store_domain === 'string' && shopifyDetails.store_domain.length > 0
      ? (shopifyDetails.store_domain as string)
      : null

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
          case 'settings-updated': {
            const label = statusSource ? SOURCE_LABELS[statusSource] : null
            return label ? `${label} preferences saved.` : 'Integration settings saved.'
          }
          case 'meta-sync-triggered':
            return 'Meta sync triggered. Data will refresh shortly.'
          case 'meta-backfill-triggered':
            return 'Meta-backfill startad. Data fylls på i bakgrunden.'
          default:
            return 'Changes saved.'
        }
      })()
    : null
  const metaConnectAction = startMetaConnect.bind(null, { tenantId: tenant.id, tenantSlug: tenant.slug })
  const metaDisconnectAction = disconnectMeta.bind(null, { tenantId: tenant.id, tenantSlug: tenant.slug })

  const metaAccountForm =
    metaAccounts.length > 0 ? (
      <form
        action={updateMetaSelectedAccount}
        className="grid gap-3 rounded-xl border border-dashed border-muted/60 bg-background/80 p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end"
      >
        <input type="hidden" name="tenantId" value={tenant.id} />
        <input type="hidden" name="tenantSlug" value={tenant.slug} />
        <div className="space-y-2">
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
        <Button type="submit" variant="outline" className="md:w-auto">
          Save account
        </Button>
        {metaAccountsError && (
          <p className="md:col-span-2 text-sm text-destructive">
            Meta API response: <span className="font-mono">{metaAccountsError}</span>
          </p>
        )}
      </form>
    ) : meta.status === 'connected' ? (
      <div className="rounded-xl border border-dashed border-muted/60 bg-background/80 p-4 text-sm text-muted-foreground">
        No ad accounts were returned for this connection. Reconnect Meta or verify that the user has access to the desired ad
        account.
        {metaAccountsError && (
          <span className="mt-2 block text-destructive">
            Meta API response: <span className="font-mono">{metaAccountsError}</span>
          </span>
        )}
      </div>
    ) : null

  const metaManualSyncForm =
    meta.status === 'connected' ? (
      <form
        action={triggerMetaSyncNow}
        className="flex flex-col gap-2 rounded-xl border border-muted/60 bg-background/80 p-4 text-sm md:flex-row md:items-center md:justify-between"
      >
        <div className="space-y-1">
          <p className="font-medium text-foreground">Manual sync</p>
          <p className="text-xs text-muted-foreground">
            Start an immediate Meta sync using the current account and preferences.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input type="hidden" name="tenantId" value={tenant.id} />
          <input type="hidden" name="tenantSlug" value={tenant.slug} />
          <Button type="submit" variant="secondary" className="md:w-auto">
            Trigger Meta sync
          </Button>
        </div>
      </form>
    ) : null

  const metaBackfillForm =
    meta.status === 'connected' ? (
      <form
        action={triggerMetaBackfill}
        className="grid gap-3 rounded-xl border border-muted/60 bg-background/80 p-4 text-sm md:grid-cols-[repeat(3,minmax(0,1fr))_auto] md:items-end"
      >
        <input type="hidden" name="tenantId" value={tenant.id} />
        <input type="hidden" name="tenantSlug" value={tenant.slug} />
        {selectedMetaAccountId ? <input type="hidden" name="accountId" value={selectedMetaAccountId} /> : null}
        <div className="md:col-span-3 space-y-1">
          <p className="font-medium text-foreground">Manual backfill</p>
          <p className="text-xs text-muted-foreground">
            Hämta historisk data mellan två datum för det valda Meta-kontot.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="meta-backfill-since">Från datum</Label>
          <Input
            id="meta-backfill-since"
            type="date"
            name="since"
            defaultValue={metaSyncStartDate || todayIso}
            className="h-10"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="meta-backfill-until">Till datum</Label>
          <Input id="meta-backfill-until" type="date" name="until" defaultValue={todayIso} className="h-10" required />
        </div>
        <Button type="submit" className="md:w-auto">
          Starta backfill
        </Button>
      </form>
    ) : null

  const integrationSections = [
    {
      source: 'meta' as const,
      connect: (
        <MetaConnect
          status={meta.status}
          lastSyncedAt={meta.updatedAt ?? undefined}
          lastSyncedLabel={metaLastSyncedLabel ?? undefined}
          selectedAccountName={selectedMetaAccountName}
          onConnect={metaConnectAction}
          onDisconnect={metaDisconnectAction}
        />
      ),
      syncStartDate: metaSyncStartDate,
      selectedKpis: metaDisplayKpis,
      preferencesHint: 'Control the Meta backfill window and KPIs that appear in dashboards.',
      extra: (
        <div className="space-y-3">
          {metaAccountForm}
          {metaManualSyncForm}
          {metaBackfillForm}
        </div>
      ),
    },
    {
      source: 'google_ads' as const,
      connect: (
        <GoogleAdsConnect
          status={google.status}
          customerId={googleCustomerId}
          lastSyncedAt={google.updatedAt ?? undefined}
        />
      ),
      syncStartDate: googleSyncStartDate,
      selectedKpis: googleDisplayKpis,
      preferencesHint: 'Choose when Google Ads data should start and which KPIs to surface.',
      extra: null,
    },
    {
      source: 'shopify' as const,
      connect: (
        <ShopifyConnect
          status={shopify.status}
          shopDomain={shopifyStoreDomain}
          lastSyncedAt={shopify.updatedAt ?? undefined}
        />
      ),
      syncStartDate: shopifySyncStartDate,
      selectedKpis: shopifyDisplayKpis,
      preferencesHint: 'Define the Shopify import window and KPIs shown in reporting.',
      extra: null,
    },
  ]

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
        <CardContent className="space-y-6">
          {integrationSections.map((section) => (
            <section
              key={section.source}
              className="space-y-4 rounded-2xl border border-border/60 bg-card/70 p-5 shadow-sm"
            >
              <div className="space-y-4">
                {section.connect}
                {section.extra}
              </div>
              <div className="space-y-3 rounded-xl border border-dashed border-muted/60 bg-background/70 p-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">Data preferences</p>
                  <p className="text-xs text-muted-foreground">{section.preferencesHint}</p>
                </div>
                <form
                  action={updateIntegrationSettings}
                  className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end"
                >
                  <input type="hidden" name="tenantId" value={tenant.id} />
                  <input type="hidden" name="tenantSlug" value={tenant.slug} />
                  <input type="hidden" name="source" value={section.source} />
                  <div className="space-y-2">
                    <Label htmlFor={`${section.source}-sync-start`}>Sync from date</Label>
                    <Input
                      id={`${section.source}-sync-start`}
                      type="date"
                      name="syncStartDate"
                      defaultValue={section.syncStartDate}
                      className="h-10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Select KPIs</Label>
                    <KpiDropdown name="kpis" options={KPI_OPTIONS} defaultValue={section.selectedKpis} />
                  </div>
                  <Button type="submit" className="md:w-auto">
                    Save settings
                  </Button>
                </form>
              </div>
            </section>
          ))}
        </CardContent>
      </Card>

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


