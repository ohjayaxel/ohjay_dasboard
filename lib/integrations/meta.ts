import { randomBytes } from 'crypto'

import { logger } from '@/lib/logger'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

import { decryptSecret, encryptSecret } from './crypto'
import { triggerSyncJobForTenant } from '@/lib/jobs/scheduler'

const META_API_VERSION = process.env.META_API_VERSION ?? 'v18.0'
const META_GRAPH_BASE = `https://graph.facebook.com/${META_API_VERSION}`
const META_OAUTH_BASE = `https://www.facebook.com/${META_API_VERSION}/dialog/oauth`
const META_TOKEN_ENDPOINT = `${META_GRAPH_BASE}/oauth/access_token`
const META_DEBUG_TOKEN_ENDPOINT = 'https://graph.facebook.com/debug_token'

const META_APP_ID = process.env.META_APP_ID
const META_APP_SECRET = process.env.META_APP_SECRET
const META_SYSTEM_USER_TOKEN = process.env.META_SYSTEM_USER_TOKEN ?? null

const RAW_BASE_URL =
  process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'
const META_REDIRECT_PATH = '/api/oauth/meta/callback'

export const META_REQUESTED_SCOPES = Object.freeze([
  'ads_read',
  'ads_management',
  'business_management',
])
const META_SCOPES = META_REQUESTED_SCOPES
const CONNECTION_SOURCE = 'meta'
const STATE_TTL_MS = 15 * 60 * 1000
export const META_STATE_TTL_MS = STATE_TTL_MS

type ConnectionRow = {
  id: string
  access_token_enc: Buffer | null
  refresh_token_enc: Buffer | null
  expires_at: string | null
  meta: Record<string, unknown> | null
}

type TokenResponse = {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
  granted_scopes?: string[]
}

type MetaApiError = {
  message?: string
  type?: string
  code?: number
  error_subcode?: number
}

type MetaAdAccountPayload = {
  id?: string
  account_id?: string
  name?: string
  currency?: string
  account_status?: number
}

type MetaCampaignPayload = {
  id?: string
  name?: string
  status?: string
  effective_status?: string
  objective?: string
  updated_time?: string
}

type MetaInsightPayload = Record<string, unknown>

export type NormalizedMetaAdAccount = {
  id: string
  account_id: string
  name?: string
  currency?: string
  account_status?: number
}

type MetaRequestContext = {
  route: string
  action: string
  endpoint?: string
  tenantId: string
  userId?: string
  state?: string
}

type MetaRequestResult<T> = {
  body: T
  fbTraceId?: string
  status: number
}

export type MetaRequestErrorDetail = {
  status: number
  fbTraceId?: string
  endpoint: string
  error_code?: number
  error_subcode?: number
  tenantId?: string
  message?: string
}

type MetaRequestError = Error & {
  meta?: MetaRequestErrorDetail
}

function normalizeBaseUrl(raw: string | undefined): string {
  const fallback = 'http://localhost:3000'
  if (!raw || raw.trim().length === 0) {
    return fallback
  }

  const trimmed = raw.trim()
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed.replace(/^\/+/, '')}`

  try {
    const url = new URL(withProtocol)
    const base = `${url.protocol}//${url.host}`
    const pathname = url.pathname.replace(/\/$/, '')
    return pathname ? `${base}${pathname}` : base
  } catch (error) {
    throw new Error(`Invalid APP_BASE_URL/NEXT_PUBLIC_BASE_URL value: ${raw}`)
  }
}

const APP_BASE_URL = normalizeBaseUrl(RAW_BASE_URL)

export function getMetaBaseUrl(): string {
  return APP_BASE_URL
}

export function getMetaCallbackPath(): string {
  return META_REDIRECT_PATH
}

function buildRedirectUri(): string {
  return `${APP_BASE_URL}${META_REDIRECT_PATH}`
}

export function getMetaRedirectUri(): string {
  return buildRedirectUri()
}

function requireAppCredentials() {
  if (!META_APP_ID || !META_APP_SECRET) {
    throw new Error('Missing Meta app credentials. Set META_APP_ID and META_APP_SECRET.')
  }
}

export async function getExistingMetaConnection(
  tenantId: string,
): Promise<ConnectionRow | null> {
  const client = getSupabaseServiceClient()
  const { data, error } = await client
    .from('connections')
    .select('id, access_token_enc, refresh_token_enc, expires_at, meta')
    .eq('tenant_id', tenantId)
    .eq('source', CONNECTION_SOURCE)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to read Meta connection: ${error.message}`)
  }

  return (data as ConnectionRow) ?? null
}

function mergeMeta(
  existing: Record<string, unknown> | null | undefined,
  updates?: Record<string, unknown>,
): Record<string, unknown> {
  if (!updates) {
    return (existing as Record<string, unknown>) ?? {}
  }

  return {
    ...(existing ?? {}),
    ...updates,
  }
}

function hasOwn<T extends object>(obj: T, key: keyof any): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

async function upsertConnection(
  tenantId: string,
  payload: {
    status: string
    accessToken?: string | null
    refreshToken?: string | null
    expiresAt?: string | null
    meta?: Record<string, unknown>
  },
) {
  const client = getSupabaseServiceClient()
  const existing = await getExistingMetaConnection(tenantId)
  const mergedMeta = mergeMeta(existing?.meta as Record<string, unknown> | null, payload.meta)
  const now = new Date().toISOString()

  if (existing) {
    const updates: Record<string, unknown> = {
      status: payload.status,
      updated_at: now,
      meta: mergedMeta,
    }

    if (hasOwn(payload, 'accessToken')) {
      updates.access_token_enc = payload.accessToken
        ? encryptSecret(payload.accessToken)
        : null
    }

    if (hasOwn(payload, 'refreshToken')) {
      updates.refresh_token_enc = payload.refreshToken
        ? encryptSecret(payload.refreshToken)
        : null
    }

    if (hasOwn(payload, 'expiresAt')) {
      updates.expires_at = payload.expiresAt ?? null
    }

    const { error } = await client.from('connections').update(updates).eq('id', existing.id)

    if (error) {
      throw new Error(`Failed to update Meta connection: ${error.message}`)
    }
    return
  }

  const insertRow: Record<string, unknown> = {
    tenant_id: tenantId,
    source: CONNECTION_SOURCE,
    status: payload.status,
    updated_at: now,
    meta: mergedMeta,
    access_token_enc: payload.accessToken ? encryptSecret(payload.accessToken) : null,
    refresh_token_enc: payload.refreshToken ? encryptSecret(payload.refreshToken) : null,
    expires_at: payload.expiresAt ?? null,
  }

  const { error } = await client.from('connections').insert(insertRow)
  if (error) {
    throw new Error(`Failed to insert Meta connection: ${error.message}`)
  }
}

function ensureActPrefix(accountId: string): string {
  return accountId.startsWith('act_') ? accountId : `act_${accountId}`
}

function normalizeAdAccounts(list: MetaAdAccountPayload[] | undefined | null): NormalizedMetaAdAccount[] {
  if (!Array.isArray(list)) {
    return []
  }

  const normalized: NormalizedMetaAdAccount[] = []

  for (const item of list) {
    const rawId =
      typeof item.account_id === 'string'
        ? item.account_id
        : typeof item.id === 'string'
          ? item.id.replace(/^act_/, '')
          : null

    if (!rawId) {
      continue
    }

    normalized.push({
      id: ensureActPrefix(item.id ?? rawId),
      account_id: rawId,
      name: typeof item.name === 'string' ? item.name : undefined,
      currency: typeof item.currency === 'string' ? item.currency : undefined,
      account_status:
        typeof item.account_status === 'number' ? item.account_status : undefined,
    })
  }

  return normalized
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function statePrefix(state?: string): string | undefined {
  return state ? state.slice(0, 8) : undefined
}

async function performMetaRequest<T>(
  path: string,
  options: {
    accessToken: string
    params?: Record<string, string>
    context: MetaRequestContext
  },
): Promise<MetaRequestResult<T>> {
  const url = path.startsWith('http')
    ? new URL(path)
    : new URL(`${META_GRAPH_BASE}/${path.replace(/^\/+/, '')}`)

  for (const [key, value] of Object.entries(options.params ?? {})) {
    url.searchParams.set(key, value)
  }

  const endpoint =
    options.context.endpoint ??
    (url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`)
  const statePrefixValue = statePrefix(options.context.state)

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
    },
  })

  const fbTraceId = response.headers.get('x-fb-trace-id') ?? undefined
  const status = response.status
  const text = await response.text()

  let parsed: any
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = text
  }

  if (!response.ok) {
    const errorPayload: MetaApiError | undefined =
      parsed && typeof parsed === 'object' && 'error' in parsed ? (parsed.error as MetaApiError) : undefined

    const errorMessage =
      errorPayload?.message ?? (typeof parsed === 'string' ? (parsed as string) : undefined)

    logger.error(
      {
        route: options.context.route,
        action: options.context.action,
        endpoint,
        tenantId: options.context.tenantId,
        userId: options.context.userId,
        state: options.context.state,
        state_prefix: statePrefixValue,
        fb_trace_id: fbTraceId,
        status,
        error_code: errorPayload?.code,
        error_subcode: errorPayload?.error_subcode,
        error_message: errorMessage,
      },
      'Meta API request failed',
    )

    const error = new Error(
      errorMessage ?? `Meta API request failed with status ${status}`,
    ) as MetaRequestError
    error.meta = {
      status,
      fbTraceId,
      endpoint,
      error_code: errorPayload?.code,
      error_subcode: errorPayload?.error_subcode,
      tenantId: options.context.tenantId,
      message: errorMessage,
    }

    throw error
  }

  const count =
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { data?: unknown[] }).data)
      ? ((parsed as { data?: unknown[] }).data?.length ?? 0)
      : undefined

  logger.info(
    {
      route: options.context.route,
      action: options.context.action,
      endpoint,
      tenantId: options.context.tenantId,
      userId: options.context.userId,
      state: options.context.state,
      state_prefix: statePrefixValue,
      fb_trace_id: fbTraceId,
      status,
      count,
    },
    'Meta API request succeeded',
  )

  return {
    body: parsed as T,
    fbTraceId,
    status,
  }
}

async function exchangeCodeForToken(options: {
  tenantId: string
  userId?: string
  state?: string
  code: string
  redirectUri: string
}) {
  requireAppCredentials()

  const params = new URLSearchParams({
    client_id: META_APP_ID!,
    client_secret: META_APP_SECRET!,
    redirect_uri: options.redirectUri,
    code: options.code,
  })

  const response = await fetch(`${META_TOKEN_ENDPOINT}?${params.toString()}`)
  const fbTraceId = response.headers.get('x-fb-trace-id') ?? undefined
  const status = response.status
  const text = await response.text()
  const endpoint = META_TOKEN_ENDPOINT
  const statePrefixValue = statePrefix(options.state)

  let parsed: any
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = text
  }

  if (!response.ok || !parsed?.access_token) {
    const errorPayload: MetaApiError | undefined =
      parsed && typeof parsed === 'object' && 'error' in parsed ? (parsed.error as MetaApiError) : undefined

    logger.error(
      {
        route: 'meta.oauth',
        action: 'token_exchange',
        endpoint,
        tenantId: options.tenantId,
        userId: options.userId,
        state: options.state,
        state_prefix: statePrefixValue,
        fb_trace_id: fbTraceId,
        status,
        error_code: errorPayload?.code,
        error_subcode: errorPayload?.error_subcode,
        error_message:
          errorPayload?.message ?? (typeof parsed === 'string' ? (parsed as string) : undefined),
      },
      'Meta token exchange failed',
    )

    throw new Error(errorPayload?.message ?? 'Meta token exchange failed')
  }

  logger.info(
    {
      route: 'meta.oauth',
      action: 'token_exchange',
      endpoint,
      tenantId: options.tenantId,
      userId: options.userId,
      state: options.state,
      state_prefix: statePrefixValue,
      fb_trace_id: fbTraceId,
      status,
    },
    'Meta token exchange succeeded',
  )

  return {
    token: parsed as TokenResponse,
    fbTraceId,
  }
}

async function fetchGrantedScopes(
  accessToken: string,
  context: { tenantId: string; userId?: string; state?: string },
): Promise<string[]> {
  requireAppCredentials()

  const url = new URL(META_DEBUG_TOKEN_ENDPOINT)
  url.searchParams.set('input_token', accessToken)
  url.searchParams.set('access_token', `${META_APP_ID}|${META_APP_SECRET}`)

  const response = await fetch(url.toString())
  const fbTraceId = response.headers.get('x-fb-trace-id') ?? undefined
  const status = response.status
  const text = await response.text()
  const endpoint = META_DEBUG_TOKEN_ENDPOINT
  const statePrefixValue = statePrefix(context.state)

  let parsed: any
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = text
  }

  if (!response.ok) {
    const errorPayload: MetaApiError | undefined =
      parsed && typeof parsed === 'object' && 'error' in parsed ? (parsed.error as MetaApiError) : undefined

    logger.warn(
      {
        route: 'meta.oauth',
        action: 'debug_token',
        endpoint,
        tenantId: context.tenantId,
        userId: context.userId,
        state: context.state,
        state_prefix: statePrefixValue,
        fb_trace_id: fbTraceId,
        status,
        error_code: errorPayload?.code,
        error_subcode: errorPayload?.error_subcode,
        error_message:
          errorPayload?.message ?? (typeof parsed === 'string' ? (parsed as string) : undefined),
      },
      'Meta debug_token request failed',
    )

    return []
  }

  const scopes: string[] = Array.isArray(parsed?.data?.scopes)
    ? parsed.data.scopes.filter((scope: unknown) => typeof scope === 'string')
    : []

  logger.info(
    {
      route: 'meta.oauth',
      action: 'debug_token',
      endpoint,
      tenantId: context.tenantId,
      userId: context.userId,
      state: context.state,
      state_prefix: statePrefixValue,
      fb_trace_id: fbTraceId,
      status,
      count: scopes.length,
    },
    'Meta granted scopes fetched',
  )

  return scopes
}

async function fetchMetaAdAccountsWithToken(options: {
  accessToken: string
  context: MetaRequestContext
}) {
  const result = await performMetaRequest<{ data?: MetaAdAccountPayload[] }>('me/adaccounts', {
    accessToken: options.accessToken,
    params: {
      fields: 'id,account_id,name,currency,account_status',
      limit: '100',
    },
    context: {
      ...options.context,
      endpoint: options.context.endpoint ?? '/me/adaccounts',
    },
  })

  return {
    accounts: normalizeAdAccounts(result.body?.data),
    raw: result.body,
    fbTraceId: result.fbTraceId,
  }
}

async function fetchMetaProfileWithToken(options: {
  accessToken: string
  context: MetaRequestContext
}) {
  return performMetaRequest<{ id?: string; name?: string }>('me', {
    accessToken: options.accessToken,
    params: {
      fields: 'id,name',
    },
    context: {
      ...options.context,
      endpoint: options.context.endpoint ?? '/me',
    },
  })
}

async function fetchMetaCampaignsWithToken(options: {
  accessToken: string
  adAccountId: string
  context: MetaRequestContext
}) {
  const result = await performMetaRequest<{ data?: MetaCampaignPayload[] }>(
    `${options.adAccountId}/campaigns`,
    {
      accessToken: options.accessToken,
      params: {
        fields: 'id,name,status,effective_status,objective,updated_time',
        limit: '50',
      },
      context: {
        ...options.context,
        endpoint: options.context.endpoint ?? `/${options.adAccountId}/campaigns`,
      },
    },
  )

  return {
    campaigns: Array.isArray(result.body?.data) ? result.body.data : [],
    fbTraceId: result.fbTraceId,
  }
}

async function fetchMetaInsightsWithToken(options: {
  accessToken: string
  adAccountId: string
  context: MetaRequestContext
  days?: number
}) {
  const days = options.days ?? 7
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const until = new Date()

  const result = await performMetaRequest<{ data?: MetaInsightPayload[] }>(
    `${options.adAccountId}/insights`,
    {
      accessToken: options.accessToken,
      params: {
        fields:
          'date_start,date_stop,campaign_id,campaign_name,spend,impressions,clicks,actions,action_values',
        time_range: JSON.stringify({ since: isoDate(since), until: isoDate(until) }),
        level: 'campaign',
        limit: '100',
      },
      context: {
        ...options.context,
        endpoint: options.context.endpoint ?? `/${options.adAccountId}/insights`,
      },
    },
  )

  return {
    insights: Array.isArray(result.body?.data) ? result.body.data : [],
    fbTraceId: result.fbTraceId,
    timeRange: { since: isoDate(since), until: isoDate(until) },
  }
}

async function resolveAccessToken(tenantId: string): Promise<string | null> {
  const directToken = await getMetaAccessToken(tenantId)
  if (directToken) {
    return directToken
  }

  if (META_SYSTEM_USER_TOKEN) {
    logger.warn(
      {
        route: 'meta.access_token',
        action: 'fallback_system_user_token',
        endpoint: '/system_user_token',
        tenantId,
      },
      'Falling back to META_SYSTEM_USER_TOKEN for Meta API request',
    )
    return META_SYSTEM_USER_TOKEN
  }

  return null
}

export async function getActiveMetaAccessToken(tenantId: string): Promise<string | null> {
  return resolveAccessToken(tenantId)
}

export async function getMetaAuthorizeUrl(tenantId: string) {
  requireAppCredentials()

  const state = randomBytes(16).toString('hex')
  const redirectUri = buildRedirectUri()

  const params = new URLSearchParams({
    client_id: META_APP_ID!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: META_SCOPES.join(','),
    display: 'page',
    auth_type: 'rerequest',
    state,
  })

  logger.info(
    {
      route: 'meta.oauth',
      action: 'build_auth_url',
      tenantId,
      state_prefix: statePrefix(state),
      state,
      redirect_uri: redirectUri,
      scopes: META_SCOPES.join(','),
    },
    'Meta auth URL generated',
  )

  return {
    url: `${META_OAUTH_BASE}?${params.toString()}`,
    state,
  }
}

export async function handleMetaOAuthCallback(options: {
  tenantId: string
  code: string
  state: string
  userId?: string
}) {
  requireAppCredentials()

  logger.info(
    {
      route: 'meta.oauth',
      action: 'callback_received',
      tenantId: options.tenantId,
      userId: options.userId,
      state: options.state,
      state_prefix: statePrefix(options.state),
    },
    'Meta OAuth callback received',
  )

  const redirectUri = buildRedirectUri()
  const { token, fbTraceId: tokenTraceId } = await exchangeCodeForToken({
    tenantId: options.tenantId,
    userId: options.userId,
    state: options.state,
    code: options.code,
    redirectUri,
  })

  const grantedScopes =
    token.granted_scopes ??
    (await fetchGrantedScopes(token.access_token, {
      tenantId: options.tenantId,
      userId: options.userId,
      state: options.state,
    }))

  let accounts: NormalizedMetaAdAccount[] = []
  let adAccountsTraceId: string | undefined
  let accountsError: string | null = null

  try {
    const { accounts: normalized, fbTraceId } = await fetchMetaAdAccountsWithToken({
      accessToken: token.access_token,
      context: {
        route: 'meta.oauth',
        action: 'fetch_adaccounts',
        tenantId: options.tenantId,
        userId: options.userId,
        state: options.state,
        endpoint: '/me/adaccounts',
      },
    })
    accounts = normalized
    adAccountsTraceId = fbTraceId
  } catch (error) {
    accountsError = error instanceof Error ? error.message : String(error)
    logger.error(
      {
        route: 'meta.oauth',
        action: 'fetch_adaccounts',
        endpoint: '/me/adaccounts',
        tenantId: options.tenantId,
        userId: options.userId,
        state: options.state,
        state_prefix: statePrefix(options.state),
        error_message: accountsError,
      },
      'Meta ad accounts fetch failed during OAuth callback',
    )
  }

  const selectedAccountId = accounts[0]?.id ?? null
  logger.info(
    {
      route: 'meta.oauth',
      action: 'account_selection',
      tenantId: options.tenantId,
      userId: options.userId,
      state: options.state,
      state_prefix: statePrefix(options.state),
      selected_account_id: selectedAccountId,
      available_accounts: accounts.length,
    },
    'Resolved default Meta ad account after OAuth callback',
  )

  let campaigns: MetaCampaignPayload[] = []
  let campaignsTraceId: string | undefined
  let campaignsError: string | null = null

  let insights: MetaInsightPayload[] = []
  let insightsTraceId: string | undefined
  let insightsError: string | null = null
  let insightsRange: { since: string; until: string } | undefined

  if (selectedAccountId) {
    try {
      const campaignResult = await fetchMetaCampaignsWithToken({
        accessToken: token.access_token,
        adAccountId: selectedAccountId,
        context: {
          route: 'meta.oauth',
          action: 'fetch_campaigns',
          tenantId: options.tenantId,
          userId: options.userId,
          state: options.state,
          endpoint: `/${selectedAccountId}/campaigns`,
        },
      })
      campaigns = campaignResult.campaigns.slice(0, 50)
      campaignsTraceId = campaignResult.fbTraceId
    } catch (error) {
      campaignsError = error instanceof Error ? error.message : String(error)
      logger.error(
        {
          route: 'meta.oauth',
          action: 'fetch_campaigns',
        endpoint: `/${selectedAccountId}/campaigns`,
          tenantId: options.tenantId,
          userId: options.userId,
          state: options.state,
        state_prefix: statePrefix(options.state),
          error_message: campaignsError,
        },
        'Meta campaigns fetch failed during OAuth callback',
      )
    }

    try {
      const insightsResult = await fetchMetaInsightsWithToken({
        accessToken: token.access_token,
        adAccountId: selectedAccountId,
        context: {
          route: 'meta.oauth',
          action: 'fetch_insights',
          tenantId: options.tenantId,
          userId: options.userId,
          state: options.state,
        endpoint: `/${selectedAccountId}/insights`,
        },
      })
      insights = insightsResult.insights.slice(0, 50)
      insightsTraceId = insightsResult.fbTraceId
      insightsRange = insightsResult.timeRange
    } catch (error) {
      insightsError = error instanceof Error ? error.message : String(error)
      logger.error(
        {
          route: 'meta.oauth',
          action: 'fetch_insights',
        endpoint: `/${selectedAccountId}/insights`,
          tenantId: options.tenantId,
          userId: options.userId,
          state: options.state,
        state_prefix: statePrefix(options.state),
          error_message: insightsError,
        },
        'Meta insights fetch failed during OAuth callback',
      )
    }
  }

  const expiresAt = token.expires_in
    ? new Date(Date.now() + token.expires_in * 1000).toISOString()
    : null
  const now = new Date().toISOString()

  await upsertConnection(options.tenantId, {
    status: 'connected',
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresAt,
    meta: {
      token_type: token.token_type,
      granted_scopes: grantedScopes,
      oauth_state: null,
      oauth_state_created_at: null,
      connected_at: now,
      last_synced_at: now,
      ad_accounts: accounts,
      accounts_error: accountsError,
      selected_account_id: selectedAccountId,
      campaigns_snapshot: campaigns,
      campaigns_error: campaignsError,
      insights_snapshot: insights,
      insights_error: insightsError,
      insights_time_range: insightsRange,
      fb_trace_ids: {
        token: tokenTraceId,
        ad_accounts: adAccountsTraceId,
        campaigns: campaignsTraceId,
        insights: insightsTraceId,
      },
    },
  })

  logger.info(
    {
      route: 'meta.oauth',
      action: 'callback_complete',
      tenantId: options.tenantId,
      userId: options.userId,
      state: options.state,
      state_prefix: statePrefix(options.state),
      selected_account_id: selectedAccountId,
    },
    'Meta OAuth callback completed successfully',
  )

  try {
    await triggerSyncJobForTenant('meta', options.tenantId)
    logger.info(
      {
        route: 'meta.oauth',
        action: 'post_connect_sync',
        tenantId: options.tenantId,
      },
      'Triggered immediate Meta sync after OAuth connection',
    )
  } catch (error) {
    logger.error(
      {
        route: 'meta.oauth',
        action: 'post_connect_sync',
        tenantId: options.tenantId,
        error_message: error instanceof Error ? error.message : String(error),
      },
      'Failed to trigger immediate Meta sync after OAuth connection',
    )
  }
}

export async function refreshMetaTokenIfNeeded(tenantId: string) {
  requireAppCredentials()

  const connection = await getExistingMetaConnection(tenantId)

  if (!connection) {
    throw new Error('Meta connection not found.')
  }

  if (!connection.expires_at || !connection.refresh_token_enc) {
    return
  }

  const expiresAt = new Date(connection.expires_at).getTime()
  if (Number.isNaN(expiresAt) || Date.now() < expiresAt - 5 * 60 * 1000) {
    return
  }

  const refreshToken = decryptSecret(connection.refresh_token_enc)
  if (!refreshToken) {
    logger.warn(
      {
        route: 'meta.oauth',
        action: 'token_refresh',
        tenantId,
        endpoint: META_TOKEN_ENDPOINT,
      },
      'Refresh token missing; skipping Meta token refresh',
    )
    return
  }

  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: META_APP_ID!,
    client_secret: META_APP_SECRET!,
    fb_exchange_token: refreshToken,
  })

  const response = await fetch(`${META_TOKEN_ENDPOINT}?${params.toString()}`)
  const status = response.status
  const text = await response.text()
  const fbTraceId = response.headers.get('x-fb-trace-id') ?? undefined
  const endpoint = META_TOKEN_ENDPOINT

  let parsed: any
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = text
  }

  if (!response.ok || !parsed?.access_token) {
    const errorPayload: MetaApiError | undefined =
      parsed && typeof parsed === 'object' && 'error' in parsed ? (parsed.error as MetaApiError) : undefined

    logger.error(
      {
        route: 'meta.oauth',
        action: 'token_refresh',
        tenantId,
        endpoint,
        fb_trace_id: fbTraceId,
        status,
        error_code: errorPayload?.code,
        error_subcode: errorPayload?.error_subcode,
        error_message:
          errorPayload?.message ?? (typeof parsed === 'string' ? (parsed as string) : undefined),
      },
      'Meta token refresh failed',
    )

    throw new Error(errorPayload?.message ?? 'Meta token refresh failed')
  }

  const expiresAtIso = parsed.expires_in
    ? new Date(Date.now() + parsed.expires_in * 1000).toISOString()
    : null

  await upsertConnection(tenantId, {
    status: 'connected',
    accessToken: parsed.access_token,
    refreshToken,
    expiresAt: expiresAtIso,
  })

  logger.info(
    {
      route: 'meta.oauth',
      action: 'token_refresh',
      tenantId,
      endpoint,
      fb_trace_id: fbTraceId,
      status,
    },
    'Meta token refresh succeeded',
  )
}

export async function getMetaAccessToken(tenantId: string): Promise<string | null> {
  const connection = await getExistingMetaConnection(tenantId)
  if (!connection) {
    return null
  }

  return decryptSecret(connection.access_token_enc)
}

export async function fetchMetaAdAccountsForTenant(params: {
  tenantId: string
  userId?: string
  route?: string
  state?: string
}) {
  const accessToken = await resolveAccessToken(params.tenantId)
  if (!accessToken) {
    throw new Error('No Meta access token available for tenant.')
  }

  const result = await fetchMetaAdAccountsWithToken({
    accessToken,
    context: {
      route: params.route ?? 'api.meta',
      action: 'fetch_adaccounts',
      tenantId: params.tenantId,
      userId: params.userId,
      state: params.state,
      endpoint: '/me/adaccounts',
    },
  })

  return {
    status: result.status,
    fbTraceId: result.fbTraceId,
    data: result.body,
    accounts: normalizeAdAccounts(result.body?.data),
  }
}

export async function fetchMetaProfileForTenant(params: {
  tenantId: string
  userId?: string
  route?: string
  state?: string
}) {
  const accessToken = await resolveAccessToken(params.tenantId)
  if (!accessToken) {
    throw new Error('No Meta access token available for tenant.')
  }

  const result = await fetchMetaProfileWithToken({
    accessToken,
    context: {
      route: params.route ?? 'api.meta',
      action: 'fetch_me',
      tenantId: params.tenantId,
      userId: params.userId,
      state: params.state,
      endpoint: '/me',
    },
  })

  return result
}

export async function fetchMetaInsightsDaily(params: {
  tenantId: string
  adAccountId: string
  startDate: string
  endDate: string
}) {
  const accessToken = await resolveAccessToken(params.tenantId)
  if (!accessToken) {
    throw new Error('No Meta access token available for tenant.')
  }

  const result = await performMetaRequest<{ data?: MetaInsightPayload[] }>(
    `${params.adAccountId}/insights`,
    {
      accessToken,
      params: {
        fields: 'date_start,date_stop,spend,impressions,clicks,actions,action_values',
        time_range: JSON.stringify({
          since: params.startDate,
          until: params.endDate,
        }),
        level: 'ad',
        limit: '100',
      },
      context: {
        route: 'meta.insights',
        action: 'fetch_insights_daily',
        tenantId: params.tenantId,
        endpoint: `/${params.adAccountId}/insights`,
      },
    },
  )

  return Array.isArray(result.body?.data) ? result.body.data : []
}

export function isMetaStateExpired(meta: Record<string, unknown> | null | undefined): boolean {
  const raw =
    meta && typeof meta === 'object'
      ? (meta as Record<string, unknown>)['oauth_state_created_at']
      : null
  const createdAt = typeof raw === 'string' ? raw : null

  if (!createdAt) {
    return true
  }

  const createdMs = new Date(createdAt).getTime()
  if (Number.isNaN(createdMs)) {
    return true
  }

  return Date.now() - createdMs > STATE_TTL_MS
}
