export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import {
  disconnectMeta,
  disconnectShopify,
  disconnectGoogleAds,
  queueMetaBackfillJobs,
  startMetaConnect,
  startShopifyConnectAction,
  startGoogleAdsConnect,
  triggerMetaSyncNow,
  updateMetaSelectedAccount,
  updateGoogleAdsSelectedCustomer,
  refreshGoogleAdsCustomers,
  updateIntegrationSettings,
  triggerShopifyBackfill,
  verifyShopifyConnection,
  testShopifyCustomAppToken,
  connectShopifyCustomAppAction,
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

  // Get available accounts from new data model (available_customers)
  const availableAccounts = Array.isArray(googleDetails.available_customers)
    ? (googleDetails.available_customers as Array<{
        customer_id: string;
        descriptive_name: string;
        currency_code?: string;
        time_zone?: string;
        is_manager: boolean;
        manager_customer_id?: string;
      }>)
    : []

  // Filter to only child accounts (non-manager)
  const childAccounts = availableAccounts.filter(a => !a.is_manager)

  // Fallback to legacy accessible_customers if available_customers not set
  const googleCustomers = childAccounts.length > 0
    ? childAccounts.map(a => ({ id: a.customer_id, name: a.descriptive_name }))
    : Array.isArray(googleDetails.accessible_customers)
      ? (googleDetails.accessible_customers as Array<{ id: string; name: string }>)
      : []

  const selectedGoogleCustomerId =
    typeof googleDetails.selected_customer_id === 'string' && googleDetails.selected_customer_id.length > 0
      ? (googleDetails.selected_customer_id as string)
      : typeof googleDetails.customer_id === 'string' && googleDetails.customer_id.length > 0
        ? (googleDetails.customer_id as string)
        : null

  const selectedGoogleCustomerName =
    typeof googleDetails.selected_customer_name === 'string'
      ? googleDetails.selected_customer_name
      : googleCustomers.find((c) => c.id === selectedGoogleCustomerId)?.name ??
        (typeof googleDetails.customer_name === 'string' ? googleDetails.customer_name : null) ??
        selectedGoogleCustomerId ??
        'Not set'

  const googleCustomersError =
    typeof googleDetails.customers_error === 'string' && googleDetails.customers_error.length > 0
      ? (googleDetails.customers_error as string)
      : null

  // Check if only manager accounts were found
  const onlyManagerAccountsFound = availableAccounts.length > 0 && childAccounts.length === 0

  const shopifyStoreDomain =
    typeof shopifyDetails.store_domain === 'string' && shopifyDetails.store_domain.length > 0
      ? (shopifyDetails.store_domain as string)
      : null

  const shopifyBackfillSince =
    typeof shopifyDetails.backfill_since === 'string' && shopifyDetails.backfill_since.length > 0
      ? (shopifyDetails.backfill_since as string)
      : null

  // Get recent Shopify sync jobs
  const { data: shopifyJobs, error: shopifyJobsError } = await supabase
    .from('jobs_log')
    .select('id, status, started_at, finished_at, error')
    .eq('tenant_id', tenant.id)
    .eq('source', 'shopify')
    .order('started_at', { ascending: false })
    .limit(1)

  if (shopifyJobsError) {
    console.warn('Failed to load Shopify jobs:', shopifyJobsError.message)
  }

  const latestShopifyJob = shopifyJobs && shopifyJobs.length > 0 ? shopifyJobs[0] : null

  // Verify connection if connected
  let shopifyConnectionErrors: string[] | null = null
  if (shopify.status === 'connected') {
    try {
      const verification = await verifyShopifyConnection(tenant.id)
      if (!verification.connected) {
        shopifyConnectionErrors = verification.errors || []
      }
    } catch (error) {
      console.error('Failed to verify Shopify connection:', error)
      shopifyConnectionErrors = [`Verification failed: ${error instanceof Error ? error.message : String(error)}`]
    }
  }

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
          case 'googleads-connected':
            return 'Google Ads connection established. Initial sync triggered.'
          case 'googleads-disconnected':
            return 'Google Ads connection removed.'
          case 'meta-account-updated':
            return 'Meta ad account selection saved.'
          case 'google-ads-customer-updated':
            return 'Google Ads customer selection saved.'
          case 'google-ads-customers-refreshed':
        case 'google-ads-customers-info':
            return 'Google Ads customers refreshed successfully.'
          case 'google-ads-customers-refresh-error':
            return error ? `Failed to refresh customers: ${error}` : 'Failed to refresh customers.'
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
  const googleAdsConnectAction = startGoogleAdsConnect.bind(null, { 
    tenantId: tenant.id, 
    tenantSlug: tenant.slug,
    loginCustomerId: selectedGoogleCustomerId ?? undefined,
  })
  const googleAdsDisconnectAction = disconnectGoogleAds.bind(null, { tenantId: tenant.id, tenantSlug: tenant.slug })

  const googleAdsCustomerForm = google.status === 'connected' ? (
    onlyManagerAccountsFound ? (
      // Special case: Only manager accounts found
      <div className="space-y-3">
        <form
          action={refreshGoogleAdsCustomers}
          className="flex flex-col gap-2 rounded-xl border border-dashed border-muted/60 bg-background/80 p-4 text-sm md:flex-row md:items-center md:justify-between"
        >
          <div className="space-y-1">
            <p className="font-medium text-foreground">Detect Google Ads accounts</p>
            <p className="text-xs text-muted-foreground">
              Automatically detect accessible Google Ads accounts for this connection.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input type="hidden" name="tenantId" value={tenant.id} />
            <input type="hidden" name="tenantSlug" value={tenant.slug} />
            <FormSubmitButton type="submit" variant="secondary" className="md:w-auto" pendingLabel="Detecting...">
              Detect Google Ads accounts
            </FormSubmitButton>
          </div>
        </form>
        <div className="rounded-xl border border-dashed border-yellow-500/50 bg-yellow-500/10 p-4 text-sm">
          <p className="font-medium text-yellow-900 dark:text-yellow-100">Only Manager (MCC) Accounts Detected</p>
          <p className="mt-2 text-xs text-yellow-800 dark:text-yellow-200">
            We detected only Manager (MCC) accounts. To sync data, you must have access to at least one standard Google Ads account.
            Please verify your permissions in Google Ads.
          </p>
          {googleCustomersError && (
            <div className="mt-3 rounded-md bg-yellow-500/20 p-3">
              <p className="text-xs font-medium text-yellow-900 dark:text-yellow-100">Additional Info:</p>
              <p className="mt-1 text-xs text-yellow-800 dark:text-yellow-200">{googleCustomersError}</p>
            </div>
          )}
        </div>
      </div>
    ) : googleCustomers.length > 0 ? (
      // Child accounts available - show dropdown for selection
      <div className="space-y-3">
        <form
          action={refreshGoogleAdsCustomers}
          className="flex flex-col gap-2 rounded-xl border border-dashed border-muted/60 bg-background/80 p-4 text-sm md:flex-row md:items-center md:justify-between"
        >
          <div className="space-y-1">
            <p className="font-medium text-foreground">Detect Google Ads accounts</p>
            <p className="text-xs text-muted-foreground">
              Automatically detect accessible Google Ads accounts for this connection.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input type="hidden" name="tenantId" value={tenant.id} />
            <input type="hidden" name="tenantSlug" value={tenant.slug} />
            <FormSubmitButton type="submit" variant="secondary" className="md:w-auto" pendingLabel="Detecting...">
              Detect Google Ads accounts
            </FormSubmitButton>
          </div>
        </form>
        <form
          action={updateGoogleAdsSelectedCustomer}
          className="grid gap-3 rounded-xl border border-dashed border-muted/60 bg-background/80 p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end"
        >
          <input type="hidden" name="tenantId" value={tenant.id} />
          <input type="hidden" name="tenantSlug" value={tenant.slug} />
          <div className="space-y-2">
            <Label htmlFor="google-ads-customer">Child Google Ads Account to Sync</Label>
            <select
              id="google-ads-customer"
              name="customerId"
              defaultValue={selectedGoogleCustomerId || ''}
              className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              required
            >
              <option value="">-- Select an account --</option>
              {googleCustomers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name && customer.name !== customer.id ? `${customer.name} (${customer.id})` : customer.id}
                </option>
              ))}
            </select>
          </div>
          <Button 
            type="submit" 
            variant="outline" 
            className="md:w-auto"
            disabled={!selectedGoogleCustomerId}
          >
            Save
          </Button>
          {selectedGoogleCustomerId && (
            <div className="md:col-span-2 rounded-md bg-muted/50 p-3">
              <p className="text-xs font-medium text-foreground">Selected:</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedGoogleCustomerName && selectedGoogleCustomerName !== selectedGoogleCustomerId
                  ? `${selectedGoogleCustomerName} (${selectedGoogleCustomerId})`
                  : selectedGoogleCustomerId}
              </p>
            </div>
          )}
          {googleCustomersError && (
            <div className="md:col-span-2 rounded-md bg-muted/50 p-3">
              <p className="text-sm font-medium text-foreground">Note:</p>
              <p className="mt-1 text-xs text-muted-foreground">{googleCustomersError}</p>
            </div>
          )}
        </form>
      </div>
    ) : (
      // No accounts detected yet - show detect button
      <div className="space-y-3 rounded-xl border border-dashed border-muted/60 bg-background/80 p-4 text-sm">
        <form
          action={refreshGoogleAdsCustomers}
          className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between"
        >
          <div className="space-y-1">
            <p className="font-medium text-foreground">Detect Google Ads accounts</p>
            <p className="text-xs text-muted-foreground">
              Automatically detect accessible Google Ads accounts for this connection.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input type="hidden" name="tenantId" value={tenant.id} />
            <input type="hidden" name="tenantSlug" value={tenant.slug} />
            <FormSubmitButton type="submit" variant="default" className="md:w-auto" pendingLabel="Detecting...">
              Detect Google Ads accounts
            </FormSubmitButton>
          </div>
        </form>
        {googleCustomersError && (
          <div className="rounded-md bg-muted/50 p-3">
            <p className="text-xs font-medium text-foreground">Note:</p>
            <p className="mt-1 text-xs text-muted-foreground">{googleCustomersError}</p>
          </div>
        )}
      </div>
    )
  ) : null

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
      <div className="space-y-4">
        <Alert>
          <AlertDescription>
            <p className="font-medium mb-2">💡 Rekommendation: Använd lokal backfill</p>
            <p className="text-sm text-muted-foreground mb-2">
              För stora backfills (mer än ~100 ordrar eller längre än 1 månad) rekommenderas att köra backfill lokalt istället för online via denna knapp.
            </p>
            <p className="text-sm font-mono bg-muted p-2 rounded mt-2">
              pnpm tsx scripts/shopify_backfill.ts --tenant {tenant.slug} --since {defaultShopifyBackfillSince}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Se <code className="text-xs">scripts/README_SHOPIFY_BACKFILL.md</code> för mer information.
            </p>
          </AlertDescription>
        </Alert>
      <form
        action={triggerShopifyBackfill}
        className="grid gap-3 rounded-xl border border-muted/60 bg-background/80 p-4 text-sm md:grid-cols-[minmax(0,1fr)_auto] md:items-end"
      >
        <input type="hidden" name="tenantId" value={tenant.id} />
        <input type="hidden" name="tenantSlug" value={tenant.slug} />
        <div className="space-y-2">
            <Label htmlFor="shopify-backfill-since">Backfill från datum (online)</Label>
          <Input
            id="shopify-backfill-since"
            type="date"
            name="since"
            defaultValue={defaultShopifyBackfillSince}
            className="h-10"
            required
          />
          <p className="text-xs text-muted-foreground">
              Hämtar ordrar från valt datum fram till idag en gång. Rekommenderas endast för små backfills (&lt;100 ordrar, &lt;1 månad). Flaggan återställs automatiskt efter körning.
          </p>
        </div>
        <FormSubmitButton type="submit" className="md:w-auto" pendingLabel="Backfillar...">
            Kör backfill (online)
        </FormSubmitButton>
      </form>
      </div>
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
          customerId={selectedGoogleCustomerId}
          customerName={selectedGoogleCustomerName}
          lastSyncedAt={google.updatedAt ?? undefined}
          onConnect={googleAdsConnectAction}
          onDisconnect={googleAdsDisconnectAction}
        />
      ),
      syncStartDate: googleSyncStartDate,
      selectedKpis: googleDisplayKpis,
      preferencesHint: 'Choose when Google Ads data should start and which KPIs to surface.',
      extra: googleAdsCustomerForm,
    },
    {
      source: 'shopify' as const,
      connect: (
        <ShopifyConnect
          status={shopify.status}
          shopDomain={shopifyStoreDomain}
          lastSyncedAt={shopify.updatedAt ?? undefined}
          tenantId={tenant.id}
          backfillSince={shopifyBackfillSince ?? undefined}
          latestJob={latestShopifyJob && latestShopifyJob.status ? {
            status: latestShopifyJob.status as 'pending' | 'running' | 'succeeded' | 'failed',
            startedAt: latestShopifyJob.started_at || null,
            finishedAt: latestShopifyJob.finished_at || null,
            error: latestShopifyJob.error || null,
          } : undefined}
          connectionErrors={shopifyConnectionErrors}
          onConnect={shopifyConnectAction}
          onDisconnect={shopifyDisconnectAction}
          onTestCustomAppToken={testShopifyCustomAppToken}
          onConnectCustomApp={connectShopifyCustomAppAction}
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

      {/* Semantic layer / data model info section to explain how
          marketing spend and aMER are computed across Meta + Google Ads. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Data model & semantic layer</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Daily performance metrics (net sales, new customer net sales, marketing spend, aMER) are now powered by a unified semantic layer.
            </p>
            <ul className="list-disc list-inside space-y-2 pl-2">
              <li>
                <span className="font-medium text-foreground">Marketing spend</span> is aggregated from both Meta Ads and Google Ads:
                <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                  total marketing spend = Meta spend + Google Ads spend
                </code>
              </li>
              <li>
                <span className="font-medium text-foreground">aMER</span> (adjusted Marketing Efficiency Ratio) is defined as:
                <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                  new customer net sales ÷ total marketing spend
                </code>
              </li>
              <li>
                The semantic layer reads from:
                <ul className="ml-4 mt-1 list-disc space-y-1">
                  <li>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                      v_marketing_spend_daily
                    </code>{' '}
                    (cross-channel spend per day)
                  </li>
                  <li>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                      v_daily_metrics
                    </code>{' '}
                    (combined sales + marketing metrics per day)
                  </li>
                </ul>
              </li>
              <li>
                Calculated metrics (like aMER) are validated against legacy aggregation logic to ensure parity.
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

