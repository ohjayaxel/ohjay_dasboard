'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { requirePlatformAdmin, getCurrentUser } from '@/lib/auth/current-user'
import { Roles } from '@/lib/auth/roles'
import { getMetaAuthorizeUrl } from '@/lib/integrations/meta'
import { getShopifyAuthorizeUrl, connectShopifyCustomApp, validateCustomAppToken, getShopifyAccessToken } from '@/lib/integrations/shopify'
import { getGoogleAdsAuthorizeUrl, refreshGoogleAdsTokenIfNeeded } from '@/lib/integrations/googleads'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { logger, withRequestContext } from '@/lib/logger'
import { triggerSyncJobForTenant } from '@/lib/jobs/scheduler'
import { createHmac } from 'crypto'
import { isPlatformAdmin } from '@/lib/auth/roles'

const roleEnum = z.enum([
  Roles.platformAdmin,
  Roles.admin,
  Roles.editor,
  Roles.viewer,
])

const addMemberSchema = z.object({
  tenantId: z.string().uuid({ message: 'Invalid tenant identifier.' }),
  tenantSlug: z
    .string({ required_error: 'Tenant slug is required.' })
    .min(1, { message: 'Tenant slug is required.' }),
  email: z.string().email({ message: 'Invalid email address.' }).transform((value) => value.toLowerCase()),
  role: roleEnum,
})

const removeMemberSchema = z.object({
  memberId: z.string().uuid({ message: 'Invalid member identifier.' }),
  tenantSlug: z
    .string({ required_error: 'Tenant slug is required.' })
    .min(1, { message: 'Tenant slug is required.' }),
})

const createTenantSchema = z.object({
  name: z
    .string({ required_error: 'Tenant name is required.' })
    .min(2, { message: 'Tenant name must be at least 2 characters.' })
    .max(120, { message: 'Tenant name must be at most 120 characters.' }),
})

const connectMetaSchema = z.object({
  tenantId: z.string().uuid({ message: 'Invalid tenant identifier.' }),
  tenantSlug: z
    .string({ required_error: 'Tenant slug is required.' })
    .min(1, { message: 'Tenant slug is required.' }),
})

const disconnectMetaSchema = connectMetaSchema

const disconnectShopifySchema = z.object({
  tenantId: z.string().uuid({ message: 'Invalid tenant identifier.' }),
  tenantSlug: z
    .string({ required_error: 'Tenant slug is required.' })
    .min(1, { message: 'Tenant slug is required.' }),
})

const connectShopifySchema = connectMetaSchema

const connectGoogleAdsSchema = connectMetaSchema
const disconnectGoogleAdsSchema = connectMetaSchema

const updateGoogleAdsCustomerSchema = z.object({
  tenantId: z.string().uuid({ message: 'Invalid tenant identifier.' }),
  tenantSlug: z
    .string({ required_error: 'Tenant slug is required.' })
    .min(1, { message: 'Tenant slug is required.' }),
  customerId: z.string().min(1, { message: 'Customer ID is required.' }),
})

const connectShopifyCustomAppSchema = z.object({
  tenantId: z.string().uuid({ message: 'Invalid tenant identifier.' }),
  tenantSlug: z
    .string({ required_error: 'Tenant slug is required.' })
    .min(1, { message: 'Tenant slug is required.' }),
  shopDomain: z
    .string({ required_error: 'Shop domain is required.' })
    .trim()
    .min(1, { message: 'Shop domain is required.' }),
  accessToken: z
    .string({ required_error: 'Access token is required.' })
    .trim()
    .min(1, { message: 'Access token is required.' }),
})

const updateMetaAccountSchema = z.object({
  tenantId: z.string().uuid({ message: 'Invalid tenant identifier.' }),
  tenantSlug: z
    .string({ required_error: 'Tenant slug is required.' })
    .min(1, { message: 'Tenant slug is required.' }),
  accountId: z
    .string({ required_error: 'Select an ad account.' })
    .min(1, { message: 'Select an ad account.' }),
})

const triggerMetaSyncSchema = z.object({
  tenantId: z.string().uuid({ message: 'Invalid tenant identifier.' }),
  tenantSlug: z
    .string({ required_error: 'Tenant slug is required.' })
    .min(1, { message: 'Tenant slug is required.' }),
})

const queueMetaBackfillSchema = z.object({
  tenantId: z.string().uuid({ message: 'Invalid tenant identifier.' }),
  tenantSlug: z
    .string({ required_error: 'Tenant slug is required.' })
    .min(1, { message: 'Tenant slug is required.' }),
  accountId: z
    .string({ required_error: 'Select an ad account.' })
    .min(1, { message: 'Select an ad account.' }),
  since: z
    .string({ required_error: 'Start date is required.' })
    .min(1, { message: 'Start date is required.' }),
  until: z
    .string({ required_error: 'End date is required.' })
    .min(1, { message: 'End date is required.' }),
})

const triggerMetaBackfillSchema = z.object({
  tenantId: z.string().uuid({ message: 'Invalid tenant identifier.' }),
  tenantSlug: z
    .string({ required_error: 'Tenant slug is required.' })
    .min(1, { message: 'Tenant slug is required.' }),
  since: z
    .string({ required_error: 'Start date is required.' })
    .min(1, { message: 'Start date is required.' }),
  until: z
    .string({ required_error: 'End date is required.' })
    .min(1, { message: 'End date is required.' }),
  accountId: z
    .string()
    .optional()
    .transform((value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)),
})

const triggerShopifyBackfillSchema = z.object({
  tenantId: z.string().uuid({ message: 'Invalid tenant identifier.' }),
  tenantSlug: z
    .string({ required_error: 'Tenant slug is required.' })
    .min(1, { message: 'Tenant slug is required.' }),
  since: z
    .string({ required_error: 'Start date is required.' })
    .min(1, { message: 'Start date is required.' }),
})

const INTEGRATION_SOURCES = ['meta', 'google_ads', 'shopify'] as const
const integrationSourceEnum = z.enum(INTEGRATION_SOURCES)

const updateIntegrationSettingsSchema = z.object({
  tenantId: z.string().uuid({ message: 'Invalid tenant identifier.' }),
  tenantSlug: z
    .string({ required_error: 'Tenant slug is required.' })
    .min(1, { message: 'Tenant slug is required.' }),
  source: integrationSourceEnum,
  syncStartDate: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
  kpis: z.array(z.string()).optional(),
  shopifyBackfillSince: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
})

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

async function revalidateTenantViews(tenantId: string, tenantSlug?: string) {
  revalidatePath('/admin')
  revalidatePath('/settings')

  let slug = tenantSlug
  if (!slug) {
    const client = getSupabaseServiceClient()
    const { data, error } = await client.from('tenants').select('slug').eq('id', tenantId).maybeSingle()

    if (error) {
      console.error('Failed to resolve tenant slug during revalidation:', error.message)
      return
    }

    slug = data?.slug ?? undefined
  }

  if (slug) {
    revalidatePath(`/admin/tenants/${slug}`)
    revalidatePath(`/admin/tenants/${slug}/integrations`)
    revalidatePath(`/admin/tenants/${slug}/members`)
  }
}

export async function addTenantMember(formData: FormData) {
  await requirePlatformAdmin()

  const result = addMemberSchema.safeParse({
    tenantId: formData.get('tenantId'),
    tenantSlug: formData.get('tenantSlug'),
    email: formData.get('email'),
    role: formData.get('role'),
  })

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid member payload.')
  }

  const client = getSupabaseServiceClient()

  const { data: usersData, error: userLookupError } = await client.auth.admin.listUsers({
    page: 1,
    perPage: 1,
    filter: { email: result.data.email },
  })

  if (userLookupError) {
    throw new Error(`Unable to search Supabase Auth: ${userLookupError.message}`)
  }

  const user = usersData?.users?.[0]

  if (!user) {
    redirect(
      `/admin/tenants/${result.data.tenantSlug}/members?error=${encodeURIComponent(
        'No Supabase Auth user found for that email. Invite the user first, then grant access.',
      )}`,
    )
  }

  const { error: insertError } = await client.from('members').insert({
    tenant_id: result.data.tenantId,
    user_id: user.id,
    email: result.data.email,
    role: result.data.role,
  })

  if (insertError) {
    if (insertError.code === '23505') {
      throw new Error('User already has access to this tenant.')
    }

    throw new Error(`Failed to add member: ${insertError.message}`)
  }

  await revalidateTenantViews(result.data.tenantId, result.data.tenantSlug)

  redirect(`/admin/tenants/${result.data.tenantSlug}/members?status=member-added`)
}

export async function removeTenantMember(formData: FormData) {
  await requirePlatformAdmin()

  const result = removeMemberSchema.safeParse({
    memberId: formData.get('memberId'),
    tenantSlug: formData.get('tenantSlug'),
  })

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid member identifier.')
  }

  const client = getSupabaseServiceClient()

  const { data: member, error: lookupError } = await client
    .from('members')
    .select('tenant_id')
    .eq('id', result.data.memberId)
    .maybeSingle()

  if (lookupError) {
    throw new Error(`Failed to load member details: ${lookupError.message}`)
  }

  if (!member) {
    throw new Error('Member not found.')
  }

  const { error } = await client.from('members').delete().eq('id', result.data.memberId)

  if (error) {
    throw new Error(`Failed to remove member: ${error.message}`)
  }

  await revalidateTenantViews(member.tenant_id as string, result.data.tenantSlug)

  redirect(`/admin/tenants/${result.data.tenantSlug}/members?status=member-removed`)
}

export async function createTenant(formData: FormData) {
  await requirePlatformAdmin()

  const result = createTenantSchema.safeParse({
    name: formData.get('name'),
  })

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid tenant payload.')
  }

  const client = getSupabaseServiceClient()

  const baseSlug = slugify(result.data.name) || `tenant-${Date.now()}`
  let slugCandidate = baseSlug
  let attempt = 0
  let insertedTenant: { id: string; slug: string } | null = null

  while (attempt < 5) {
    const { data, error } = await client
      .from('tenants')
      .insert({ name: result.data.name, slug: slugCandidate })
      .select('id, slug')
      .single()

    if (!error && data) {
      insertedTenant = data
      break
    }

    if (error?.code === '23505') {
      attempt += 1
      slugCandidate = `${baseSlug}-${attempt}`
      continue
    }

    throw new Error(`Failed to create tenant: ${error?.message ?? 'Unknown database error.'}`)
  }

  if (!insertedTenant) {
    throw new Error('Failed to generate a unique tenant slug. Try a different name.')
  }

  const connectionSeed = INTEGRATION_SOURCES.map((source) => ({
    tenant_id: insertedTenant.id,
    source,
    status: 'disconnected',
  }))

  const { error: connectionsError } = await client.from('connections').insert(connectionSeed)

  if (connectionsError) {
    await client.from('tenants').delete().eq('id', insertedTenant.id)
    throw new Error(`Tenant created, but failed to seed integrations: ${connectionsError.message}`)
  }

  revalidatePath('/admin')
  revalidatePath(`/admin/tenants/${insertedTenant.slug}`)

  redirect(`/admin/tenants/${insertedTenant.slug}`)
}

export async function startMetaConnect(payload: { tenantId: string; tenantSlug: string }) {
  return withRequestContext(async () => {
    const user = await requirePlatformAdmin()

    const result = connectMetaSchema.safeParse(payload)

    if (!result.success) {
      throw new Error(result.error.errors[0]?.message ?? 'Invalid Meta connection payload.')
    }

    const { tenantId, tenantSlug } = result.data
    const { url, state } = await getMetaAuthorizeUrl(tenantId)
    const client = getSupabaseServiceClient()

    const { data: existing, error: existingError } = await client
      .from('connections')
      .select('id, meta')
      .eq('tenant_id', tenantId)
      .eq('source', 'meta')
      .maybeSingle()

    if (existingError) {
      throw new Error(`Failed to prepare Meta connection: ${existingError.message}`)
    }

    const now = new Date().toISOString()
    const baseMeta =
      existing && typeof existing.meta === 'object' && existing.meta !== null ? (existing.meta as Record<string, unknown>) : {}
    const nextMeta = {
      ...baseMeta,
      oauth_state: state,
      oauth_state_created_at: now,
      oauth_redirect_path: `/admin/tenants/${tenantSlug}/integrations`,
    }

    if (existing) {
      const { error } = await client
        .from('connections')
        .update({
          status: 'disconnected',
          access_token_enc: null,
          refresh_token_enc: null,
          expires_at: null,
          updated_at: now,
          meta: nextMeta,
        })
        .eq('id', existing.id)

      if (error) {
        throw new Error(`Failed to update Meta connection: ${error.message}`)
      }
    } else {
      const { error } = await client.from('connections').insert({
        tenant_id: tenantId,
        source: 'meta',
        status: 'disconnected',
        updated_at: now,
        access_token_enc: null,
        refresh_token_enc: null,
        expires_at: null,
        meta: nextMeta,
      })

      if (error) {
        throw new Error(`Failed to create Meta connection: ${error.message}`)
      }
    }

    await revalidateTenantViews(tenantId, tenantSlug)

    logger.info(
      {
        route: 'admin.meta',
        action: 'connect_initiated',
        endpoint: '/api/oauth/meta/callback',
        tenantId,
        tenantSlug,
        userId: user.id,
        state,
        state_prefix: state.slice(0, 8),
        redirect_url: url,
      },
      'Meta connect initiated',
    )

    return {
      redirectUrl: url,
      state,
    }
  })
}

export async function disconnectMeta(payload: { tenantId: string; tenantSlug: string }) {
  await requirePlatformAdmin()

  const result = disconnectMetaSchema.safeParse(payload)

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid disconnect payload.')
  }

  const { tenantId, tenantSlug } = result.data
  const client = getSupabaseServiceClient()

  const { data: existing, error: existingError } = await client
    .from('connections')
    .select('id, meta')
    .eq('tenant_id', tenantId)
    .eq('source', 'meta')
    .maybeSingle()

  if (existingError) {
    throw new Error(`Failed to load Meta connection: ${existingError.message}`)
  }

  const now = new Date().toISOString()
  const baseMeta =
    existing && typeof existing.meta === 'object' && existing.meta !== null ? (existing.meta as Record<string, unknown>) : {}
  const nextMeta = {
    ...baseMeta,
    oauth_state: null,
    oauth_state_created_at: null,
      oauth_redirect_path: `/admin/tenants/${tenantSlug}/integrations`,
    disconnected_at: now,
  }

  if (existing) {
    const { error } = await client
      .from('connections')
      .update({
        status: 'disconnected',
        updated_at: now,
        access_token_enc: null,
        refresh_token_enc: null,
        expires_at: null,
        meta: nextMeta,
      })
      .eq('id', existing.id)

    if (error) {
      throw new Error(`Failed to disconnect Meta: ${error.message}`)
    }
  } else {
    const { error } = await client.from('connections').insert({
      tenant_id: tenantId,
      source: 'meta',
      status: 'disconnected',
      updated_at: now,
      access_token_enc: null,
      refresh_token_enc: null,
      expires_at: null,
      meta: nextMeta,
    })

    if (error) {
      throw new Error(`Failed to create Meta connection placeholder: ${error.message}`)
    }
  }

  await revalidateTenantViews(tenantId, tenantSlug)
}

export async function updateIntegrationSettings(formData: FormData) {
  await requirePlatformAdmin()

  const kpiValues = formData
    .getAll('kpis')
    .filter((value): value is string => typeof value === 'string' && value.length > 0)

  const result = updateIntegrationSettingsSchema.safeParse({
    tenantId: formData.get('tenantId'),
    tenantSlug: formData.get('tenantSlug'),
    source: formData.get('source'),
    syncStartDate: formData.get('syncStartDate'),
    kpis: kpiValues,
  })

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid integration settings payload.')
  }

  const { tenantId, tenantSlug, source, syncStartDate, kpis } = result.data

  const client = getSupabaseServiceClient()
  const { data: connection, error: fetchError } = await client
    .from('connections')
    .select('id, meta, status')
    .eq('tenant_id', tenantId)
    .eq('source', source)
    .maybeSingle()

  if (fetchError) {
    throw new Error(`Failed to load integration settings: ${fetchError.message}`)
  }

  if (!connection) {
    throw new Error('Integration connection not initialized for this tenant.')
  }

  const baseMeta =
    connection.meta && typeof connection.meta === 'object' ? (connection.meta as Record<string, unknown>) : {}

  const previousSyncStart =
    typeof baseMeta.sync_start_date === 'string' && baseMeta.sync_start_date.length > 0
      ? (baseMeta.sync_start_date as string)
      : null

  const syncStartChanged =
    (previousSyncStart ?? null) !== (syncStartDate ?? null)

  const nextMeta = {
    ...baseMeta,
    sync_start_date: syncStartDate,
    display_kpis: kpis ?? [],
    display_kpis_updated_at: new Date().toISOString(),
  }

  const lastRange =
    baseMeta && typeof baseMeta.last_synced_range === 'object'
      ? (baseMeta.last_synced_range as Record<string, unknown>)
      : null

  let shouldResetSyncState = syncStartChanged

  if (!shouldResetSyncState && syncStartDate) {
    const syncStartDateValue = new Date(syncStartDate)
    if (!Number.isNaN(syncStartDateValue.getTime())) {
      if (lastRange && typeof lastRange.since === 'string') {
        const lastSince = new Date(lastRange.since)
        if (!Number.isNaN(lastSince.getTime()) && lastSince > syncStartDateValue) {
          shouldResetSyncState = true
        }
      } else if (typeof baseMeta.last_synced_at === 'string') {
        const lastSyncedAt = new Date(baseMeta.last_synced_at as string)
        if (!Number.isNaN(lastSyncedAt.getTime()) && lastSyncedAt > syncStartDateValue) {
          shouldResetSyncState = true
        }
      }
    }
  }

  if (shouldResetSyncState) {
    nextMeta.last_synced_at = null
    nextMeta.last_synced_range = null
  }

  const { error: updateError } = await client
    .from('connections')
    .update({
      meta: nextMeta,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connection.id)

  if (updateError) {
    throw new Error(`Failed to update integration settings: ${updateError.message}`)
  }

  const connectionStatus =
    typeof (connection as { status?: string }).status === 'string'
      ? ((connection as { status?: string }).status as string)
      : null

  if (shouldResetSyncState && connectionStatus === 'connected') {
    void triggerSyncJobForTenant(source, tenantId).catch((error: unknown) => {
      logger.error(
        {
          service: source,
          tenantId,
          syncStartDate,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to trigger sync after updating integration settings',
      )
    })
  }

  await revalidateTenantViews(tenantId, tenantSlug)

  redirect(`/admin/tenants/${tenantSlug}/integrations?status=settings-updated&source=${source}`)
}

export async function updateMetaSelectedAccount(formData: FormData) {
  await requirePlatformAdmin()

  const result = updateMetaAccountSchema.safeParse({
    tenantId: formData.get('tenantId'),
    tenantSlug: formData.get('tenantSlug'),
    accountId: formData.get('accountId'),
  })

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid Meta account selection.')
  }

  const client = getSupabaseServiceClient()

  const { data: connection, error } = await client
    .from('connections')
    .select('id, meta')
    .eq('tenant_id', result.data.tenantId)
    .eq('source', 'meta')
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load Meta connection: ${error.message}`)
  }

  if (!connection) {
    throw new Error('No Meta connection found for this tenant.')
  }

  const accounts = Array.isArray((connection.meta as any)?.ad_accounts)
    ? ((connection.meta as any).ad_accounts as Array<{ id?: string; account_id?: string }>)
    : Array.isArray((connection.meta as any)?.accounts)
      ? ((connection.meta as any).accounts as Array<{ id?: string; account_id?: string }>)
      : []

  const matchedAccount = accounts.find(
    (account) => account?.id === result.data.accountId || account?.account_id === result.data.accountId,
  )

  if (!matchedAccount) {
    throw new Error('Selected ad account is not available for this connection.')
  }

  const baseMeta = (connection.meta ?? {}) as Record<string, unknown>
  const previousSelectedAccount = typeof baseMeta.selected_account_id === 'string' ? baseMeta.selected_account_id : null
  const resolvedAccountId = matchedAccount.id ?? matchedAccount.account_id ?? result.data.accountId

  const nextMeta = {
    ...baseMeta,
    selected_account_id: resolvedAccountId,
  }

  if (previousSelectedAccount !== resolvedAccountId) {
    nextMeta.last_synced_at = null
    nextMeta.last_synced_range = null
    nextMeta.last_synced_account_id = null
  }

  const { error: updateError } = await client
    .from('connections')
    .update({ meta: nextMeta })
    .eq('id', connection.id)

  if (updateError) {
    throw new Error(`Failed to update Meta ad account: ${updateError.message}`)
  }

  if (previousSelectedAccount !== resolvedAccountId) {
    void triggerSyncJobForTenant('meta', result.data.tenantId).catch((error: unknown) => {
      logger.error(
        {
          route: 'admin.meta',
          action: 'sync_after_account_change',
          tenantId: result.data.tenantId,
          accountId: resolvedAccountId,
          error_message: error instanceof Error ? error.message : String(error),
        },
        'Failed to trigger Meta sync after account selection change',
      )
    })
  }

  logger.info(
    {
      route: 'admin.meta',
      action: 'account_updated',
      tenantId: result.data.tenantId,
      tenantSlug: result.data.tenantSlug,
      selected_account_id: resolvedAccountId,
      previous_account_id: previousSelectedAccount,
    },
    'Meta ad account selection saved',
  )

  await revalidateTenantViews(result.data.tenantId, result.data.tenantSlug)

  redirect(`/admin/tenants/${result.data.tenantSlug}/integrations?status=meta-account-updated`)
}

export async function triggerMetaSyncNow(formData: FormData) {
  await requirePlatformAdmin()

  const result = triggerMetaSyncSchema.safeParse({
    tenantId: formData.get('tenantId'),
    tenantSlug: formData.get('tenantSlug'),
  })

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid Meta sync request.')
  }

  logger.debug(
    {
      route: 'admin.meta',
      action: 'manual_sync',
      tenantId: result.data.tenantId,
    },
    'Manual Meta sync requested',
  )

  try {
    await triggerSyncJobForTenant('meta', result.data.tenantId)
  } catch (error) {
    logger.error(
      {
        route: 'admin.meta',
        action: 'manual_sync',
        tenantId: result.data.tenantId,
        error_message: error instanceof Error ? error.message : String(error),
      },
      'Failed to trigger Meta sync manually',
    )
    redirect(
      `/admin/tenants/${result.data.tenantSlug}/integrations?error=${encodeURIComponent(
        'Failed to start Meta sync. Check logs for details.',
      )}`,
    )
  }

  logger.info(
    {
      route: 'admin.meta',
      action: 'manual_sync',
      tenantId: result.data.tenantId,
    },
    'Manual Meta sync triggered',
  )

  await revalidateTenantViews(result.data.tenantId, result.data.tenantSlug)

  redirect(`/admin/tenants/${result.data.tenantSlug}/integrations?status=meta-sync-triggered`)
}

export async function triggerMetaBackfill(formData: FormData) {
  await requirePlatformAdmin()

  const parsed = triggerMetaBackfillSchema.safeParse({
    tenantId: formData.get('tenantId'),
    tenantSlug: formData.get('tenantSlug'),
    since: formData.get('since'),
    until: formData.get('until'),
    accountId: formData.get('accountId'),
  })

  if (!parsed.success) {
    throw new Error(parsed.error.errors[0]?.message ?? 'Invalid Meta backfill request.')
  }

  const { tenantId, tenantSlug, accountId } = parsed.data

  const normalizeDate = (value: string, label: string) => {
    const trimmed = value.trim()
    const parsedDate = new Date(`${trimmed}T00:00:00Z`)
    if (Number.isNaN(parsedDate.getTime())) {
      throw new Error(`${label} är inte ett giltigt datum.`)
    }
    return parsedDate.toISOString().slice(0, 10)
  }

  const since = normalizeDate(parsed.data.since, 'Startdatum')
  const until = normalizeDate(parsed.data.until, 'Slutdatum')

  if (since > until) {
    throw new Error('Slutdatum måste vara samma som eller senare än startdatum.')
  }

  const payload: Record<string, unknown> = {
    mode: 'backfill',
    since,
    until,
  }

  if (accountId) {
    payload.accountId = accountId
  }

  logger.debug(
    {
      route: 'admin.meta',
      action: 'manual_backfill',
      tenantId,
      since,
      until,
      accountId,
    },
    'Manual Meta backfill requested',
  )

  try {
    await triggerSyncJobForTenant('meta', tenantId, payload)
  } catch (error) {
    logger.error(
      {
        route: 'admin.meta',
        action: 'manual_backfill',
        tenantId,
        error_message: error instanceof Error ? error.message : String(error),
      },
      'Failed to trigger Meta backfill manually',
    )

    redirect(
      `/admin/tenants/${tenantSlug}/integrations?error=${encodeURIComponent(
        'Kunde inte starta Meta-backfill. Kontrollera loggarna för mer information.',
      )}`,
    )
  }

  logger.info(
    {
      route: 'admin.meta',
      action: 'manual_backfill',
      tenantId,
      since,
      until,
      accountId,
    },
    'Manual Meta backfill triggered',
  )

  await revalidateTenantViews(tenantId, tenantSlug)

  redirect(`/admin/tenants/${tenantSlug}/integrations?status=meta-backfill-triggered`)
}

export async function queueMetaBackfillJobs(formData: FormData) {
  await requirePlatformAdmin()

  const parsed = queueMetaBackfillSchema.safeParse({
    tenantId: formData.get('tenantId'),
    tenantSlug: formData.get('tenantSlug'),
    accountId: formData.get('accountId'),
    since: formData.get('since'),
    until: formData.get('until'),
  })

  if (!parsed.success) {
    throw new Error(parsed.error.errors[0]?.message ?? 'Invalid Meta backfill queue payload.')
  }

  const { tenantId, tenantSlug, accountId, since, until } = parsed.data

  const normalizeDate = (value: string, label: string) => {
    const trimmed = value.trim()
    const parsedDate = new Date(`${trimmed}T00:00:00Z`)
    if (Number.isNaN(parsedDate.getTime())) {
      throw new Error(`${label} är inte ett giltigt datum.`)
    }
    return parsedDate.toISOString().slice(0, 10)
  }

  const normalizedSince = normalizeDate(since, 'Startdatum')
  const normalizedUntil = normalizeDate(until, 'Slutdatum')

  if (normalizedSince > normalizedUntil) {
    throw new Error('Slutdatum måste vara samma som eller senare än startdatum.')
  }

  const client = getSupabaseServiceClient()
  const now = new Date().toISOString()

  const baseJob = {
    tenant_id: tenantId,
    account_id: accountId,
    since: normalizedSince,
    until: normalizedUntil,
    created_at: now,
    updated_at: now,
  }

  const jobs = [
    {
      ...baseJob,
      mode: 'country-lite',
      config_json: {
        preset: 'account-country-lite',
        chunkSize: 1,
        concurrency: 4,
        skipKpi: true,
      },
    },
  ]

  const { error } = await client.from('meta_backfill_jobs').insert(jobs)

  if (error) {
    logger.error(
      {
        route: 'admin.meta',
        action: 'queue_backfill',
        tenantId,
        accountId,
        error_message: error.message,
      },
      'Failed to queue Meta backfill jobs',
    )

    redirect(
      `/admin/tenants/${tenantSlug}/integrations?error=${encodeURIComponent(
        'Kunde inte skapa backfill-jobb. Kontrollera loggar för mer information.',
      )}`,
    )
  }

  logger.info(
    {
      route: 'admin.meta',
      action: 'queue_backfill',
      tenantId,
      accountId,
      since: normalizedSince,
      until: normalizedUntil,
    },
    'Queued Meta backfill jobs',
  )

  await revalidateTenantViews(tenantId, tenantSlug)

  redirect(`/admin/tenants/${tenantSlug}/integrations?status=meta-backfill-queued`)
}

export async function triggerShopifyBackfill(formData: FormData) {
  await requirePlatformAdmin()

  const parsed = triggerShopifyBackfillSchema.safeParse({
    tenantId: formData.get('tenantId'),
    tenantSlug: formData.get('tenantSlug'),
    since: formData.get('since'),
  })

  if (!parsed.success) {
    throw new Error(parsed.error.errors[0]?.message ?? 'Invalid Shopify backfill request.')
  }

  const { tenantId, tenantSlug, since } = parsed.data

  const client = getSupabaseServiceClient()

  const { data: connection, error: fetchError } = await client
    .from('connections')
    .select('id, status, meta')
    .eq('tenant_id', tenantId)
    .eq('source', 'shopify')
    .maybeSingle()

  if (fetchError) {
    throw new Error(`Failed to load Shopify connection: ${fetchError.message}`)
  }

  if (!connection) {
    throw new Error('Shopify connection not initialized for this tenant.')
  }

  if ((connection.status as string | null) !== 'connected') {
    throw new Error('Connect Shopify before running a backfill.')
  }

  const nextMeta = {
    ...(connection.meta ?? {}),
    backfill_since: since,
  }

  const { error: updateError } = await client
    .from('connections')
    .update({
      meta: nextMeta,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connection.id)

  if (updateError) {
    throw new Error(`Failed to schedule Shopify backfill: ${updateError.message}`)
  }

  try {
    await triggerSyncJobForTenant('shopify', tenantId)
  } catch (error) {
    logger.error(
      {
        route: 'admin.shopify',
        action: 'manual_backfill',
        tenantId,
        since,
        error_message: error instanceof Error ? error.message : String(error),
      },
      'Failed to trigger Shopify backfill manually',
    )
    throw new Error('Failed to trigger Shopify sync. Check logs for details.')
  }

  await revalidateTenantViews(tenantId, tenantSlug)

  redirect(`/admin/tenants/${tenantSlug}/integrations?status=shopify-backfill-triggered`)
}

const addPlatformAdminSchema = z.object({
  email: z.string().email({ message: 'Invalid email address.' }).transform((value) => value.toLowerCase()),
  tenantId: z.string().uuid({ message: 'Invalid tenant identifier.' }),
})

const removePlatformAdminSchema = z.object({
  memberId: z.string().uuid({ message: 'Invalid member identifier.' }),
})

const updatePlatformAdminRoleSchema = z.object({
  memberId: z.string().uuid({ message: 'Invalid member identifier.' }),
  role: roleEnum,
})

export async function addPlatformAdmin(formData: FormData) {
  await requirePlatformAdmin()

  const result = addPlatformAdminSchema.safeParse({
    email: formData.get('email'),
    tenantId: formData.get('tenantId'),
  })

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid platform admin payload.')
  }

  const client = getSupabaseServiceClient()

  // Find user by email
  const { data: usersData, error: userLookupError } = await client.auth.admin.listUsers({
    page: 1,
    perPage: 1,
    filter: { email: result.data.email },
  })

  if (userLookupError) {
    throw new Error(`Unable to search Supabase Auth: ${userLookupError.message}`)
  }

  const user = usersData?.users?.[0]

  if (!user) {
    redirect(
      `/settings?error=${encodeURIComponent(
        'No Supabase Auth user found for that email. Invite the user first, then grant platform admin access.',
      )}`,
    )
  }

  // Check if user is already a member of this tenant
  const { data: existingMember } = await client
    .from('members')
    .select('id')
    .eq('tenant_id', result.data.tenantId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (existingMember) {
    // Update existing member to platform_admin
    const { error: updateError } = await client
      .from('members')
      .update({
        role: Roles.platformAdmin,
        email: result.data.email,
      })
      .eq('id', existingMember.id)

    if (updateError) {
      throw new Error(`Failed to update member to platform admin: ${updateError.message}`)
    }
  } else {
    // Insert new member with platform_admin role
    const { error: insertError } = await client.from('members').insert({
      tenant_id: result.data.tenantId,
      user_id: user.id,
      email: result.data.email,
      role: Roles.platformAdmin,
    })

    if (insertError) {
      if (insertError.code === '23505') {
        throw new Error('User already has access to this tenant.')
      }

      throw new Error(`Failed to add platform admin: ${insertError.message}`)
    }
  }

  revalidatePath('/settings')
  redirect('/settings?status=platform-admin-added')
}

export async function removePlatformAdmin(formData: FormData) {
  await requirePlatformAdmin()

  const result = removePlatformAdminSchema.safeParse({
    memberId: formData.get('memberId'),
  })

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid member identifier.')
  }

  const client = getSupabaseServiceClient()

  // Get member to check current role
  const { data: member, error: lookupError } = await client
    .from('members')
    .select('user_id, tenant_id, role')
    .eq('id', result.data.memberId)
    .maybeSingle()

  if (lookupError) {
    throw new Error(`Failed to load member details: ${lookupError.message}`)
  }

  if (!member) {
    throw new Error('Member not found.')
  }

  if (member.role !== Roles.platformAdmin) {
    throw new Error('Member is not a platform admin.')
  }

  // Remove member entirely (platform admin is only role, so removing access makes sense)
  const { error } = await client.from('members').delete().eq('id', result.data.memberId)

  if (error) {
    throw new Error(`Failed to remove platform admin: ${error.message}`)
  }

  revalidatePath('/settings')
  redirect('/settings?status=platform-admin-removed')
}

export async function updatePlatformAdminRole(formData: FormData) {
  await requirePlatformAdmin()

  const result = updatePlatformAdminRoleSchema.safeParse({
    memberId: formData.get('memberId'),
    role: formData.get('role'),
  })

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid role update payload.')
  }

  const client = getSupabaseServiceClient()

  // Get member to check current role
  const { data: member, error: lookupError } = await client
    .from('members')
    .select('role')
    .eq('id', result.data.memberId)
    .maybeSingle()

  if (lookupError) {
    throw new Error(`Failed to load member details: ${lookupError.message}`)
  }

  if (!member) {
    throw new Error('Member not found.')
  }

  // Update role
  const { error: updateError } = await client
    .from('members')
    .update({
      role: result.data.role,
    })
    .eq('id', result.data.memberId)

  if (updateError) {
    throw new Error(`Failed to update member role: ${updateError.message}`)
  }

  revalidatePath('/settings')
  redirect(`/settings?status=role-updated`)
}

export async function startShopifyConnect(tenantId: string, shopDomain: string) {
  const user = await getCurrentUser();
  
  // Verifiera att användaren har access till tenant
  const client = getSupabaseServiceClient();
  
  const { data: userMemberships } = await client
    .from('members')
    .select('role, tenant_id')
    .eq('user_id', user.id)
    .eq('role', 'platform_admin')
    .limit(1);
  
  const isUserPlatformAdmin = isPlatformAdmin(user.role) || (userMemberships && userMemberships.length > 0);
  
  if (!isUserPlatformAdmin) {
    const { data: membership } = await client
      .from('members')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('user_id', user.id)
      .maybeSingle();
    
    if (!membership) {
      throw new Error(`User does not have access to tenant ${tenantId}`);
    }
  }
  
  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
  if (!ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY environment variable is required');
  }
  
  const normalizedShop = shopDomain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
  
  // Skapa signed state
  const stateData = {
    tenantId,
    shopDomain: normalizedShop,
    userId: user.id,
    timestamp: Date.now(),
    nonce: crypto.randomUUID(),
  };
  
  const statePayload = JSON.stringify(stateData);
  const signature = createHmac('sha256', ENCRYPTION_KEY)
    .update(statePayload)
    .digest('hex');
  
  const state = Buffer.from(JSON.stringify({
    data: stateData,
    sig: signature
  })).toString('base64');
  
  // Hämta OAuth URL
  const { url } = await getShopifyAuthorizeUrl({
    tenantId,
    shopDomain: normalizedShop,
    state,
  });
  
  redirect(url);
}

export async function startShopifyConnectAction(payload: { tenantId: string; tenantSlug: string; shopDomain?: string }) {
  const user = await getCurrentUser();
  
  const result = connectShopifySchema.safeParse({
    tenantId: payload.tenantId,
    tenantSlug: payload.tenantSlug,
  });

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid Shopify connection payload.');
  }

  const { tenantId, tenantSlug } = result.data;
  
  // Om shopDomain inte är skickat, redirecta till connect-sidan
  if (!payload.shopDomain) {
    const connectUrl = `/connect/shopify?shop=`;
    return { redirectUrl: connectUrl };
  }

  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
  if (!ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY environment variable is required');
  }

  const normalizedShop = payload.shopDomain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();

  // Skapa signed state
  const stateData = {
    tenantId,
    shopDomain: normalizedShop,
    userId: user.id,
    timestamp: Date.now(),
    nonce: crypto.randomUUID(),
  };

  const statePayload = JSON.stringify(stateData);
  const signature = createHmac('sha256', ENCRYPTION_KEY)
    .update(statePayload)
    .digest('hex');

  const state = Buffer.from(JSON.stringify({
    data: stateData,
    sig: signature
  })).toString('base64');

  // Hämta OAuth URL
  const { url } = await getShopifyAuthorizeUrl({
    tenantId,
    shopDomain: normalizedShop,
    state,
  });

  // Spara state i connection meta
  const client = getSupabaseServiceClient();
  const { data: existing, error: existingError } = await client
    .from('connections')
    .select('id, meta')
    .eq('tenant_id', tenantId)
    .eq('source', 'shopify')
    .maybeSingle();

  if (existingError) {
    throw new Error(`Failed to prepare Shopify connection: ${existingError.message}`);
  }

  const now = new Date().toISOString();
  const baseMeta =
    existing && typeof existing.meta === 'object' && existing.meta !== null ? (existing.meta as Record<string, unknown>) : {};
  const nextMeta = {
    ...baseMeta,
    oauth_state: state,
    oauth_state_created_at: now,
    oauth_redirect_path: `/admin/tenants/${tenantSlug}/integrations`,
  };

  if (existing) {
    const { error } = await client
      .from('connections')
      .update({
        status: 'disconnected',
        access_token_enc: null,
        refresh_token_enc: null,
        expires_at: null,
        updated_at: now,
        meta: nextMeta,
      })
      .eq('id', existing.id);

    if (error) {
      throw new Error(`Failed to update Shopify connection: ${error.message}`);
    }
  } else {
    const { error } = await client.from('connections').insert({
      tenant_id: tenantId,
      source: 'shopify',
      status: 'disconnected',
      updated_at: now,
      access_token_enc: null,
      refresh_token_enc: null,
      expires_at: null,
      meta: nextMeta,
    });

    if (error) {
      throw new Error(`Failed to create Shopify connection: ${error.message}`);
    }
  }

  await revalidateTenantViews(tenantId, tenantSlug);

  logger.info(
    {
      route: 'admin.shopify',
      action: 'connect_initiated',
      endpoint: '/api/oauth/shopify/callback',
      tenantId,
      tenantSlug,
      userId: user.id,
      shopDomain: normalizedShop,
      state_prefix: state.slice(0, 8),
      redirect_url: url,
    },
    'Shopify connect initiated',
  );

  return {
    redirectUrl: url,
    state,
  };
}

export async function testShopifyCustomAppToken(payload: {
  shopDomain: string;
  accessToken: string;
}) {
  await requirePlatformAdmin();

  const validation = await validateCustomAppToken(payload.shopDomain, payload.accessToken);
  
  if (!validation.valid) {
    return {
      valid: false,
      error: validation.error || 'Invalid token',
    };
  }

  return {
    valid: true,
  };
}

export async function verifyShopifyConnection(tenantId: string) {
  const client = getSupabaseServiceClient();
  
  // Get connection
  const { data: connection, error: connError } = await client
    .from('connections')
    .select('id, status, meta')
    .eq('tenant_id', tenantId)
    .eq('source', 'shopify')
    .maybeSingle();

  if (connError) {
    return {
      connected: false,
      errors: [`Failed to fetch connection: ${connError.message}`],
    };
  }

  if (!connection || connection.status !== 'connected') {
    return {
      connected: false,
      errors: ['Connection not found or not connected'],
    };
  }

  const meta = connection.meta as Record<string, unknown> | null;
  const shopDomain = (meta?.store_domain || meta?.shop) as string | undefined;

  if (!shopDomain) {
    return {
      connected: false,
      errors: ['Shop domain not found in connection metadata'],
    };
  }

  const errors: string[] = [];

  // Get access token
  const accessToken = await getShopifyAccessToken(tenantId);
  if (!accessToken) {
    return {
      connected: false,
      errors: ['Access token not found or cannot be decrypted'],
    };
  }

  // Validate token
  const validation = await validateCustomAppToken(shopDomain, accessToken);
  if (!validation.valid) {
    errors.push(`Token validation failed: ${validation.error || 'Invalid token'}`);
  }

  // Test orders API
  try {
    const ordersUrl = `https://${shopDomain}/admin/api/2023-10/orders.json?limit=1&status=any`;
    const ordersRes = await fetch(ordersUrl, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
      },
    });

    if (!ordersRes.ok) {
      errors.push(`Orders API returned ${ordersRes.status}`);
    }
  } catch (error) {
    errors.push(`Failed to access orders API: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Check webhooks (optional, don't fail if this fails)
  let webhooksOk = false;
  try {
    const webhooksUrl = `https://${shopDomain}/admin/api/2023-10/webhooks.json`;
    const webhooksRes = await fetch(webhooksUrl, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
      },
    });

    if (webhooksRes.ok) {
      const webhooksData = await webhooksRes.json();
      const webhooks = webhooksData.webhooks || [];
      const ourWebhooks = webhooks.filter((wh: any) => 
        wh.topic === 'orders/create' || wh.topic === 'orders/updated'
      );
      webhooksOk = ourWebhooks.length > 0;
      
      if (!webhooksOk) {
        errors.push('No order webhooks registered (orders/create or orders/updated)');
      }
    }
  } catch (error) {
    // Don't fail connection if webhook check fails
    errors.push(`Could not verify webhooks: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    connected: errors.length === 0,
    errors,
    shopDomain,
    webhooksOk,
  };
}

export async function connectShopifyCustomAppAction(formData: FormData) {
  await requirePlatformAdmin();

  const result = connectShopifyCustomAppSchema.safeParse({
    tenantId: formData.get('tenantId'),
    tenantSlug: formData.get('tenantSlug'),
    shopDomain: formData.get('shopDomain'),
    accessToken: formData.get('accessToken'),
  });

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid Custom App connection payload.');
  }

  const { tenantId, tenantSlug, shopDomain, accessToken } = result.data;

  try {
    await connectShopifyCustomApp({
      tenantId,
      shopDomain,
      accessToken,
    });

    // Trigger initial sync
    try {
      await triggerSyncJobForTenant('shopify', tenantId);
    } catch (syncError) {
      console.error('Failed to trigger initial Shopify sync:', syncError);
      // Don't fail connection if sync trigger fails
    }

    const user = await getCurrentUser();
    await withRequestContext(
      {
        action: 'shopify_custom_app_connected',
        tenantId,
        tenantSlug,
        userId: user.id,
        shopDomain,
      },
      'Shopify Custom App connected',
    );

    revalidatePath(`/admin/tenants/${tenantSlug}/integrations`);
    redirect(`/admin/tenants/${tenantSlug}/integrations?status=shopify-connected`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to connect Shopify Custom App:', errorMessage);
    
    revalidatePath(`/admin/tenants/${tenantSlug}/integrations`);
    redirect(`/admin/tenants/${tenantSlug}/integrations?status=shopify-error&error=${encodeURIComponent(errorMessage)}`);
  }
}

export async function disconnectShopify(payload: { tenantId: string; tenantSlug: string }) {
  await requirePlatformAdmin()

  const result = disconnectShopifySchema.safeParse(payload)

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid disconnect payload.')
  }

  const { tenantId, tenantSlug } = result.data
  const client = getSupabaseServiceClient()

  const { data: existing, error: existingError } = await client
    .from('connections')
    .select('id, meta')
    .eq('tenant_id', tenantId)
    .eq('source', 'shopify')
    .maybeSingle()

  if (existingError) {
    throw new Error(`Failed to load Shopify connection: ${existingError.message}`)
  }

  const now = new Date().toISOString()
  const baseMeta =
    existing && typeof existing.meta === 'object' && existing.meta !== null ? (existing.meta as Record<string, unknown>) : {}
  const nextMeta = {
    ...baseMeta,
    oauth_state: null,
    oauth_state_created_at: null,
    oauth_redirect_path: `/admin/tenants/${tenantSlug}/integrations`,
    disconnected_at: now,
  }

  if (existing) {
    const { error } = await client
      .from('connections')
      .update({
        status: 'disconnected',
        updated_at: now,
        access_token_enc: null,
        refresh_token_enc: null,
        expires_at: null,
        meta: nextMeta,
      })
      .eq('id', existing.id)

    if (error) {
      throw new Error(`Failed to disconnect Shopify: ${error.message}`)
    }
  } else {
    const { error } = await client.from('connections').insert({
      tenant_id: tenantId,
      source: 'shopify',
      status: 'disconnected',
      updated_at: now,
      access_token_enc: null,
      refresh_token_enc: null,
      expires_at: null,
      meta: nextMeta,
    })

    if (error) {
      throw new Error(`Failed to create Shopify connection placeholder: ${error.message}`)
    }
  }

  await revalidateTenantViews(tenantId, tenantSlug)
}

export async function startGoogleAdsConnect(payload: { tenantId: string; tenantSlug: string; loginCustomerId?: string }) {
  return withRequestContext(async () => {
    const user = await requirePlatformAdmin()

    const result = connectGoogleAdsSchema.safeParse(payload)

    if (!result.success) {
      throw new Error(result.error.errors[0]?.message ?? 'Invalid Google Ads connection payload.')
    }

    const { tenantId, tenantSlug } = result.data
    const { url, state } = await getGoogleAdsAuthorizeUrl({
      tenantId,
      loginCustomerId: payload.loginCustomerId,
      redirectPath: `/admin/tenants/${tenantSlug}/integrations`,
    })

    await revalidateTenantViews(tenantId, tenantSlug)

    logger.info(
      {
        route: 'admin.googleads',
        action: 'connect_initiated',
        endpoint: '/api/oauth/googleads/callback',
        tenantId,
        tenantSlug,
        userId: user.id,
        state,
        state_prefix: state.slice(0, 8),
        redirect_url: url,
      },
      'Google Ads connect initiated',
    )

    return {
      redirectUrl: url,
      state,
    }
  })
}

export async function disconnectGoogleAds(payload: { tenantId: string; tenantSlug: string }) {
  await requirePlatformAdmin()

  const result = disconnectGoogleAdsSchema.safeParse(payload)

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid disconnect payload.')
  }

  const { tenantId, tenantSlug } = result.data
  const client = getSupabaseServiceClient()

  const { data: existing, error: existingError } = await client
    .from('connections')
    .select('id, meta')
    .eq('tenant_id', tenantId)
    .eq('source', 'google_ads')
    .maybeSingle()

  if (existingError) {
    throw new Error(`Failed to load Google Ads connection: ${existingError.message}`)
  }

  const now = new Date().toISOString()
  const baseMeta =
    existing && typeof existing.meta === 'object' && existing.meta !== null
      ? (existing.meta as Record<string, unknown>)
      : {}
  const nextMeta = {
    ...baseMeta,
    oauth_state: null,
    oauth_state_created_at: null,
    oauth_redirect_path: `/admin/tenants/${tenantSlug}/integrations`,
    disconnected_at: now,
  }

  if (existing) {
    const { error } = await client
      .from('connections')
      .update({
        status: 'disconnected',
        updated_at: now,
        access_token_enc: null,
        refresh_token_enc: null,
        expires_at: null,
        meta: nextMeta,
      })
      .eq('id', existing.id)

    if (error) {
      throw new Error(`Failed to disconnect Google Ads: ${error.message}`)
    }
  } else {
    const { error } = await client.from('connections').insert({
      tenant_id: tenantId,
      source: 'google_ads',
      status: 'disconnected',
      updated_at: now,
      access_token_enc: null,
      refresh_token_enc: null,
      expires_at: null,
      meta: nextMeta,
    })

    if (error) {
      throw new Error(`Failed to create Google Ads connection placeholder: ${error.message}`)
    }
  }

  await revalidateTenantViews(tenantId, tenantSlug)
}

export async function updateGoogleAdsSelectedCustomer(formData: FormData) {
  await requirePlatformAdmin()

  const result = updateGoogleAdsCustomerSchema.safeParse({
    tenantId: formData.get('tenantId'),
    tenantSlug: formData.get('tenantSlug'),
    customerId: formData.get('customerId'),
  })

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid Google Ads customer selection.')
  }

  const client = getSupabaseServiceClient()

  const { data: connection, error } = await client
    .from('connections')
    .select('id, meta')
    .eq('tenant_id', result.data.tenantId)
    .eq('source', 'google_ads')
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load Google Ads connection: ${error.message}`)
  }

  if (!connection) {
    throw new Error('No Google Ads connection found for this tenant.')
  }

  // Allow manual customer ID entry - validate format but don't require it to be in accessible_customers list
  // Customer ID format: XXX-XXX-XXXX (with or without dashes)
  const customerIdNormalized = result.data.customerId.replace(/-/g, '');
  if (customerIdNormalized.length < 10 || customerIdNormalized.length > 10 || !/^\d+$/.test(customerIdNormalized)) {
    throw new Error('Invalid customer ID format. Should be 10 digits (e.g., 123-456-7890 or 1234567890).');
  }

  // Format customer ID with dashes: XXX-XXX-XXXX
  const formattedCustomerId = `${customerIdNormalized.slice(0, 3)}-${customerIdNormalized.slice(3, 6)}-${customerIdNormalized.slice(6)}`;
  
  // Try to get customer name if we have accessible_customers list, otherwise use ID as name
  const customers = Array.isArray((connection.meta as any)?.accessible_customers)
    ? ((connection.meta as any).accessible_customers as Array<{ id: string; name: string }>)
    : []

  const selectedCustomer = customers.find((c) => {
    const cIdNormalized = c.id.replace(/-/g, '');
    return cIdNormalized === customerIdNormalized;
  });

  const customerName = selectedCustomer?.name ?? formattedCustomerId;

  const baseMeta =
    connection.meta && typeof connection.meta === 'object' && connection.meta !== null
      ? (connection.meta as Record<string, unknown>)
      : {}

  const { error: updateError } = await client
    .from('connections')
    .update({
      meta: {
        ...baseMeta,
        selected_customer_id: formattedCustomerId,
        customer_id: formattedCustomerId, // Also update customer_id for backwards compatibility
        customer_name: customerName,
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', connection.id)

  if (updateError) {
    throw new Error(`Failed to update Google Ads customer selection: ${updateError.message}`)
  }

  await revalidateTenantViews(result.data.tenantId, result.data.tenantSlug)

  redirect(`/admin/tenants/${result.data.tenantSlug}/integrations?status=google-ads-customer-updated&source=google_ads`)
}

export async function refreshGoogleAdsCustomers(formData: FormData) {
  await requirePlatformAdmin()

  const result = connectGoogleAdsSchema.safeParse({
    tenantId: formData.get('tenantId'),
    tenantSlug: formData.get('tenantSlug'),
  })

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid payload.')
  }

  const { tenantId, tenantSlug } = result.data

  const client = getSupabaseServiceClient()

  const { data: connection, error: connectionError } = await client
    .from('connections')
    .select('id, meta')
    .eq('tenant_id', tenantId)
    .eq('source', 'google_ads')
    .maybeSingle()

  if (connectionError) {
    throw new Error(`Failed to load Google Ads connection: ${connectionError.message}`)
  }

  if (!connection) {
    throw new Error('No Google Ads connection found for this tenant.')
  }

  // Refresh token if needed before making API call
  try {
    await refreshGoogleAdsTokenIfNeeded(tenantId)
  } catch (tokenError) {
    console.error('[refreshGoogleAdsCustomers] Token refresh failed:', tokenError)
    // Continue anyway - might still work with current token
  }

  // Fetch accessible customers using v21 API
  const { fetchAccessibleGoogleAdsCustomers } = await import('@/lib/integrations/googleads')
  const fetchResult = await fetchAccessibleGoogleAdsCustomers(tenantId)

  const baseMeta =
    connection.meta && typeof connection.meta === 'object' && connection.meta !== null
      ? (connection.meta as Record<string, unknown>)
      : {}

  let updatedMeta: Record<string, unknown> = { ...baseMeta }
  let statusMessage = 'google-ads-customers-refreshed'
  let customersError: string | null = null

  if (fetchResult.error) {
    // API call failed - set error message
    customersError = fetchResult.error
    updatedMeta.customers_error = customersError
    updatedMeta.accessible_customers = []
    statusMessage = 'google-ads-customers-refresh-error'
  } else if (fetchResult.customers.length === 0) {
    // No customers found
    customersError = 'No customer accounts found. The OAuth account may not have access to any Google Ads accounts.'
    updatedMeta.customers_error = customersError
    updatedMeta.accessible_customers = []
  } else if (fetchResult.customers.length === 1) {
    // Exactly one customer - auto-select it
    const singleCustomer = fetchResult.customers[0]
    updatedMeta.accessible_customers = fetchResult.customers
    updatedMeta.selected_customer_id = singleCustomer.id
    updatedMeta.customer_id = singleCustomer.id // Backwards compatibility
    updatedMeta.customer_name = singleCustomer.name
    updatedMeta.customers_error = null
  } else {
    // Multiple customers - save list, don't auto-select
    updatedMeta.accessible_customers = fetchResult.customers
    customersError = 'Multiple Google Ads accounts found. Please select one in the integration settings.'
    updatedMeta.customers_error = customersError
    // If we had a previously selected customer that's still in the list, keep it
    const previousSelected = typeof baseMeta.selected_customer_id === 'string' ? baseMeta.selected_customer_id : null
    if (previousSelected && fetchResult.customers.find((c) => c.id === previousSelected)) {
      updatedMeta.selected_customer_id = previousSelected
    } else {
      updatedMeta.selected_customer_id = null
    }
  }

  const { error: updateError } = await client
    .from('connections')
    .update({
      meta: updatedMeta,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connection.id)

  if (updateError) {
    throw new Error(`Failed to update connection: ${updateError.message}`)
  }

  await revalidateTenantViews(tenantId, tenantSlug)

  // Redirect must be outside try-catch block to work properly in Next.js server actions
  redirect(
    `/admin/tenants/${tenantSlug}/integrations?status=${statusMessage}&source=google_ads${customersError ? `&error=${encodeURIComponent(customersError)}` : ''}`,
  )
}

