'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { requirePlatformAdmin } from '@/lib/auth/current-user'
import { Roles } from '@/lib/auth/roles'
import { getMetaAuthorizeUrl } from '@/lib/integrations/meta'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { logger, withRequestContext } from '@/lib/logger'
import { triggerSyncJobForTenant } from '@/lib/jobs/scheduler'

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
      `/admin/tenants/${result.data.tenantSlug}?error=${encodeURIComponent(
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

  redirect(`/admin/tenants/${result.data.tenantSlug}?status=member-added`)
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

  redirect(`/admin/tenants/${result.data.tenantSlug}?status=member-removed`)
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
      oauth_redirect_path: `/admin/tenants/${tenantSlug}`,
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
    oauth_redirect_path: `/admin/tenants/${tenantSlug}`,
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

  redirect(`/admin/tenants/${tenantSlug}?status=settings-updated&source=${source}`)
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

  redirect(`/admin/tenants/${result.data.tenantSlug}?status=meta-account-updated`)
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
      `/admin/tenants/${result.data.tenantSlug}?error=${encodeURIComponent(
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

  redirect(`/admin/tenants/${result.data.tenantSlug}?status=meta-sync-triggered`)
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
      `/admin/tenants/${tenantSlug}?error=${encodeURIComponent(
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

  redirect(`/admin/tenants/${tenantSlug}?status=meta-backfill-triggered`)
}


