export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import {
  disconnectMeta,
  disconnectShopify,
  queueMetaBackfillJobs,
  startMetaConnect,
  startShopifyConnectAction,
  triggerMetaSyncNow,
  updateMetaSelectedAccount,
  updateIntegrationSettings,
  triggerShopifyBackfill,
} from '@/app/(dashboard)/admin/actions'
import { getAdminTenantBySlug } from '@/lib/admin/tenants'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

import { KpiDropdown } from '@/components/admin/kpi-dropdown'
import { FormSubmitButton } from '@/components/admin/form-submit-button'
import { GoogleAdsConnect } from '@/components/connections/GoogleAdsConnect'
import { MetaConnect } from '@/components/connections/MetaConnect'
import { ShopifyConnect } from '@/components/connections/ShopifyConnect'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

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

export default async function AdminTenantIntegrationsPage(props: PageProps) {
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

  const supabase = getSupabaseServiceClient()
  const { data: metaBackfillJobs, error: metaBackfillJobsError } = await supabase
    .from('meta_backfill_jobs')
    .select(
      'id, mode, status, since, until, progress_completed, progress_total, started_at, finished_at, error_message, created_at, updated_at',
    )
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: false })
    .limit(10)

  if (metaBackfillJobsError) {
    console.warn('Failed to load Meta backfill jobs:', metaBackfillJobsError.message)
  }

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
          case 'meta-backfill-queued':
            return 'Två backfill-jobb skapade. Du ser statusen nedan.'
          case 'meta-backfill-triggered':
            return 'Meta-backfill startad. Data fylls på i bakgrunden.'
          case 'shopify-connected':
            return 'Shopify connection established. Initial sync triggered.'
          case 'shopify-disconnected':
            return 'Shopify connection removed.'
          case 'shopify-backfill-triggered':
            return 'Shopify-backfill startad. Data fylls på i bakgrunden.'
          case 'meta-account-updated':
            return 'Meta ad account selection saved.'
          default:
            return 'Changes saved.'
        }
      })()
    : null
  const metaConnectAction = startMetaConnect.bind(null, { tenantId: tenant.id, tenantSlug: tenant.slug })
  const metaDisconnectAction = disconnectMeta.bind(null, { tenantId: tenant.id, tenantSlug: tenant.slug })
  const shopifyConnectAction = startShopifyConnectAction.bind(null, { 
    tenantId: tenant.id, 
    tenantSlug: tenant.slug,
    shopDomain: shopifyStoreDomain ?? undefined,
  })
  const shopifyDisconnectAction = disconnectShopify.bind(null, { tenantId: tenant.id, tenantSlug: tenant.slug })

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
          <FormSubmitButton type="submit" variant="secondary" className="md:w-auto" pendingLabel="Triggar...">
            Trigger Meta sync
          </FormSubmitButton>
        </div>
      </form>
    ) : null

  const hasSelectedMetaAccount = Boolean(selectedMetaAccountId)

  const metaQueueForm =
    meta.status === 'connected'
      ? hasSelectedMetaAccount
        ? (
          <form
            action={queueMetaBackfillJobs}
            className="grid gap-3 rounded-xl border border-muted/60 bg-background/80 p-4 text-sm md:grid-cols-[repeat(3,minmax(0,1fr))_auto] md:items-end"
          >
            <input type="hidden" name="tenantId" value={tenant.id} />
            <input type="hidden" name="tenantSlug" value={tenant.slug} />
            <input type="hidden" name="accountId" value={selectedMetaAccountId ?? ''} />
            <div className="md:col-span-3 space-y-1">
              <p className="font-medium text-foreground">Köa backfill-jobb</p>
              <p className="text-xs text-muted-foreground">
                Skapar ett snabbt kontojobb och ett detaljerat breakdown-jobb i kön.
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
              <Input
                id="meta-backfill-until"
                type="date"
                name="until"
                defaultValue={todayIso}
                className="h-10"
                required
              />
            </div>
            <FormSubmitButton type="submit" className="md:w-auto" pendingLabel="Lägger till...">
              Lägg till i kön
            </FormSubmitButton>
          </form>
          )
        : (
          <div className="rounded-xl border border-dashed border-muted/60 bg-background/80 p-4 text-sm text-muted-foreground">
            Välj ett Meta-konto innan du kan köa backfill-jobb.
          </div>
          )
      : null

  const metaBackfillQueue =
    metaBackfillJobs && metaBackfillJobs.length > 0 ? (
      <div className="space-y-2 rounded-xl border border-muted/60 bg-background/80 p-4 text-sm">
        <p className="font-medium text-foreground">Backfill-kö</p>
        <p className="text-xs text-muted-foreground">Senaste backfill-jobben för detta tenant.</p>
        <div className="space-y-2">
          {metaBackfillJobs.map((job) => {
            const total = job.progress_total ?? 0
            const completed = job.progress_completed ?? 0
            const percent = total > 0 ? Math.floor((completed / total) * 100) : 0

            return (
              <div
                key={job.id}
                className="space-y-1 rounded-lg border border-dashed border-muted/40 bg-background/60 p-3 text-xs text-muted-foreground"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] uppercase tracking-wide">
                  <span className="font-semibold text-foreground">{job.mode}</span>
                  <span className="text-muted-foreground">{job.status}</span>
                </div>
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    Period:{' '}
                    <span className="font-mono">{job.since}</span> → <span className="font-mono">{job.until}</span>
                  </span>
                  <span className="text-muted-foreground">
                    Progress: {completed}/{total} {total > 0 ? `(${percent}%)` : ''}
                  </span>
                </div>
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <span>Startad: {job.started_at ? formatTimestamp(job.started_at) ?? job.started_at : '–'}</span>
                  <span>Klar: {job.finished_at ? formatTimestamp(job.finished_at) ?? job.finished_at : '–'}</span>
                </div>
                {job.error_message ? <div className="text-destructive">Fel: {job.error_message}</div> : null}
              </div>
            )
          })}
        </div>
      </div>
    ) : null

  const defaultShopifyBackfillSince = shopifySyncStartDate || '2025-01-01'
  const shopifyBackfillForm =
    shopify.status === 'connected' ? (
      <form
        action={triggerShopifyBackfill}
        className="grid gap-3 rounded-xl border border-muted/60 bg-background/80 p-4 text-sm md:grid-cols-[minmax(0,1fr)_auto] md:items-end"
      >
        <input type="hidden" name="tenantId" value={tenant.id} />
        <input type="hidden" name="tenantSlug" value={tenant.slug} />
        <div className="space-y-2">
          <Label htmlFor="shopify-backfill-since">Backfill från datum</Label>
          <Input
            id="shopify-backfill-since"
            type="date"
            name="since"
            defaultValue={defaultShopifyBackfillSince}
            className="h-10"
            required
          />
          <p className="text-xs text-muted-foreground">
            Hämtar ordrar från valt datum fram till idag en gång. Flaggan återställs automatiskt efter körning.
          </p>
        </div>
        <FormSubmitButton type="submit" className="md:w-auto" pendingLabel="Backfillar...">
          Kör backfill
        </FormSubmitButton>
      </form>
    ) : (
      <div className="rounded-xl border border-dashed border-muted/60 bg-background/80 p-4 text-sm text-muted-foreground">
        Koppla Shopify för att kunna backfilla historiska ordrar.
      </div>
    )

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
          {metaQueueForm}
          {metaBackfillQueue}
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
          tenantId={tenant.id}
          onConnect={shopifyConnectAction}
          onDisconnect={shopifyDisconnectAction}
        />
      ),
      syncStartDate: shopifySyncStartDate,
      selectedKpis: shopifyDisplayKpis,
      preferencesHint: 'Define the Shopify import window and KPIs shown in reporting.',
      extra: shopifyBackfillForm,
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
            <Link href={`/admin/tenants/${tenantSlug}`}>← Back to overview</Link>
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
    </div>
  )
}

