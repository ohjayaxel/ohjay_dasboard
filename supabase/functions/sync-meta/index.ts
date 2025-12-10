// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type SupabaseClient = ReturnType<typeof createClient<any, any, any>>

type JsonRecord = Record<string, any>

type MetaConnection = {
  tenant_id: string
  access_token_enc: unknown
  refresh_token_enc: unknown
  expires_at: string | null
  meta: JsonRecord | null
}

type SyncWindow = {
  since: string
  until: string
}

type MetaInsightRow = {
  tenant_id: string
  date: string
  ad_account_id: string
  campaign_id: string | null
  adset_id: string | null
  ad_id: string | null
  spend: number | null
  impressions: number | null
  clicks: number | null
  purchases: number | null
  revenue: number | null
  currency: string | null
  link_clicks: number | null
}

type MetaCampaignRecord = {
  tenant_id: string
  id: string
  account_id: string
  name: string | null
  status: string | null
  effective_status: string | null
  configured_status: string | null
  objective: string | null
  buying_type: string | null
  start_time: string | null
  stop_time: string | null
  created_time: string | null
  updated_time: string | null
  daily_budget: number | null
  lifetime_budget: number | null
  budget_remaining: number | null
  special_ad_categories: unknown
  issues_info: unknown
}

type FactRow = {
  tenant_id: string
  ad_account_id: string
  date: string
  level: InsightLevel
  campaign_id: string | null
  campaign_name: string | null
  adset_id: string | null
  adset_name: string | null
  ad_id: string | null
  ad_name: string | null
  currency: string | null
  spend: number | null
  impressions: number | null
  clicks: number | null
  purchases: number | null
  add_to_cart: number | null
  leads: number | null
  revenue: number | null
  reach: number | null
  frequency: number | null
  cpm: number | null
  cpc: number | null
  ctr: number | null
  objective: string | null
  effective_status: string | null
  configured_status: string | null
  buying_type: string | null
  daily_budget: number | null
  lifetime_budget: number | null
  roas: number | null
  cos: number | null
}

type NormalizedInsightRow = {
  dateStart: string
  dateStop: string
  accountId: string | null
  campaignId: string | null
  campaignName: string | null
  adsetId: string | null
  adsetName: string | null
  adId: string | null
  adName: string | null
  entityId: string | null
  currency: string | null
  spend: number | null
  impressions: number | null
  reach: number | null
  clicks: number | null
  uniqueClicks: number | null
  inlineLinkClicks: number | null
  conversions: number | null
  purchases: number | null
  addToCart: number | null
  leads: number | null
  revenue: number | null
  purchaseRoas: any[] | null
  costPerActionType: any[] | null
  cpm: number | null
  cpc: number | null
  ctr: number | null
  frequency: number | null
  objective: string | null
  effectiveStatus: string | null
  configuredStatus: string | null
  buyingType: string | null
  dailyBudget: number | null
  lifetimeBudget: number | null
  actions: any[] | null
  actionValues: any[] | null
  breakdowns: Record<string, string | null>
}

type MatrixRunResult = {
  factRows: FactRow[]
  accountRows: MetaInsightRow[]
  windowSince: string
  windowUntil: string
  dailyRowCount: number
}

type InsightLevel = (typeof LEVELS)[number]
type ActionReportTime = (typeof ACTION_REPORT_TIMES)[number]
type AttributionWindow = (typeof ATTR_WINDOWS)[number]

type MatrixTask = {
  tenantId: string
  accountId: string
  accessToken: string
  level: InsightLevel
  breakdownKey: string
  breakdownKeys: string[]
  breakdowns: string
  actionReportTime: ActionReportTime
  attributionWindow: AttributionWindow
  monthSince: string
  monthUntil: string
}

type FetchOptions = {
  method?: 'GET' | 'POST'
  accessToken: string
  body?: Record<string, unknown> | URLSearchParams
  logContext?: JsonRecord
}

type PollJobResult = {
  files: string[]
  jobId: string
  raw: JsonRecord
}

type FetchResultPageResult = {
  data: any[]
  next?: string
  raw: JsonRecord
}

type JobResult = {
  tenantId: string
  status: 'succeeded' | 'failed'
  inserted?: number
  error?: string
}

type SyncRequestPayload = {
  tenantId?: string
  accountId?: string
  mode?: 'incremental' | 'backfill'
  since?: string
  until?: string
}

type ProcessOptions = {
  mode: 'incremental' | 'backfill'
  windowOverride?: Partial<SyncWindow>
  accountId?: string | null
}

const SOURCE = 'meta'
const META_API_VERSION = Deno.env.get('META_API_VERSION') ?? 'v18.0'
const ENCRYPTION_KEY = Deno.env.get('ENCRYPTION_KEY')

const KEY_LENGTH = 32
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const UPSERT_BATCH_SIZE = 500
const MAX_PARALLEL_MATRIX_JOBS = 3
const INCREMENTAL_WINDOW_DAYS = 30
const REINGEST_OVERLAP_DAYS = 3
const MAX_BACKFILL_WINDOW_DAYS = 366

// Optimizations for specific tenants
const SKINOME_TENANT_ID = '642af254-0c2c-4274-86ca-507398ecf9a0'
const SKINOME_OPTIMIZED_ACTION_REPORT_TIMES = ['impression'] as const
const SKINOME_OPTIMIZED_ATTR_WINDOWS = ['1d_click'] as const

const LEVELS = ['account'] as const
const ACTION_REPORT_TIMES = ['impression', 'conversion'] as const
const ATTR_WINDOWS = ['1d_click', '7d_click', '1d_view'] as const
const BREAKDOWN_SETS: Record<string, string> = {
  none: '',
  country_priority: 'country',
}
const CANONICAL_BREAKDOWN_KEY = 'none'
const COUNTRY_PRIORITY_CODES = new Set(['DE', 'SE', 'NO', 'FI'])
const CANONICAL_ACTION_REPORT_TIME: ActionReportTime = 'impression'
const CANONICAL_ATTRIBUTION_WINDOW: AttributionWindow = '7d_click'

const RETRIABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const BASE_DELAY_MS = 500
const MAX_ATTEMPTS = 6

function getEnvVar(key: string) {
  const value = Deno.env.get(key)
  if (!value) {
    throw new Error(`Missing ${key} environment variable.`)
  }
  return value
}

function createSupabaseClient(): SupabaseClient {
  const url = getEnvVar('SUPABASE_URL')
  const serviceRole = getEnvVar('SUPABASE_SERVICE_ROLE_KEY')

  return createClient(url, serviceRole, {
    auth: {
      persistSession: false,
    },
  })
}

function logSyncEvent(event: string, payload: JsonRecord) {
  try {
    console.log(
      JSON.stringify({
        event: `sync-meta:${event}`,
        ...payload,
      }),
    )
  } catch (error) {
    console.log(`[sync-meta:${event}]`, payload, error)
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function ensureActPrefix(accountId: string): string {
  return accountId.startsWith('act_') ? accountId : `act_${accountId}`
}

function clampDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return clampDate(parsed)
}

function resolveSyncWindow(
  meta: JsonRecord | null,
  override?: { mode?: 'incremental' | 'backfill'; since?: string; until?: string },
): SyncWindow {
  const today = clampDate(new Date())
  const syncStartDate =
    meta && typeof (meta as JsonRecord).sync_start_date === 'string'
      ? parseIsoDate((meta as JsonRecord).sync_start_date)
      : null

  const mode: 'incremental' | 'backfill' =
    override?.mode ?? (override?.since || override?.until ? 'backfill' : 'incremental')

  if (mode === 'backfill') {
    let sinceDate = parseIsoDate(override?.since) ?? syncStartDate ?? clampDate(new Date(today))
    let untilDate = parseIsoDate(override?.until) ?? today

    if (untilDate > today) {
      untilDate = new Date(today)
    }

    if (sinceDate > untilDate) {
      const tmp = sinceDate
      sinceDate = untilDate
      untilDate = tmp
    }

    if (syncStartDate && sinceDate < syncStartDate) {
      sinceDate = new Date(syncStartDate)
    }

    const spanDays = Math.floor((untilDate.getTime() - sinceDate.getTime()) / (24 * 60 * 60 * 1000)) + 1
    if (spanDays > MAX_BACKFILL_WINDOW_DAYS) {
      const adjusted = new Date(untilDate)
      adjusted.setDate(adjusted.getDate() - (MAX_BACKFILL_WINDOW_DAYS - 1))
      if (syncStartDate && adjusted < syncStartDate) {
        sinceDate = new Date(syncStartDate)
      } else {
        sinceDate = adjusted
      }
    }

    return {
      since: isoDate(sinceDate),
      until: isoDate(untilDate),
    }
  }

  let sinceDate = new Date(today)
  sinceDate.setDate(sinceDate.getDate() - (INCREMENTAL_WINDOW_DAYS - 1))

  if (syncStartDate) {
    if (syncStartDate < sinceDate) {
      sinceDate = new Date(syncStartDate)
    } else {
      sinceDate = new Date(syncStartDate)
    }
  }

  const lastRange =
    meta && typeof meta.last_synced_range === 'object'
      ? (meta.last_synced_range as JsonRecord)
      : null

  let reingestCandidate: Date | null = null
  if (lastRange && typeof lastRange.until === 'string') {
    const parsed = parseIsoDate(lastRange.until)
    if (parsed) {
      parsed.setDate(parsed.getDate() - (REINGEST_OVERLAP_DAYS - 1))
      reingestCandidate = clampDate(parsed)
    }
  } else if (meta && typeof (meta as JsonRecord).last_synced_at === 'string') {
    const parsed = parseIsoDate((meta as JsonRecord).last_synced_at)
    if (parsed) {
      parsed.setDate(parsed.getDate() - (REINGEST_OVERLAP_DAYS - 1))
      reingestCandidate = clampDate(parsed)
    }
  }

  if (reingestCandidate) {
    if (syncStartDate && reingestCandidate < syncStartDate) {
      reingestCandidate = new Date(syncStartDate)
    }
    if (reingestCandidate < sinceDate) {
      sinceDate = reingestCandidate
    }
  }

  if (sinceDate > today) {
    sinceDate = new Date(today)
  }

  return {
    since: isoDate(sinceDate),
    until: isoDate(today),
  }
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function decodeEncryptedPayload(payload: unknown): Uint8Array | null {
  if (payload === null || payload === undefined) {
    return null
  }

  const normalize = (bytes: Uint8Array | null): Uint8Array | null => {
    if (!bytes || bytes.length === 0) {
      return bytes
    }
    if (bytes[0] === 0x7b) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes))
        if (parsed && typeof parsed === 'object' && parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
          return Uint8Array.from(parsed.data)
        }
      } catch {
        // ignore
      }
    }
    return bytes
  }

  if (payload instanceof Uint8Array) {
    return normalize(payload)
  }

  if (payload instanceof ArrayBuffer) {
    return normalize(new Uint8Array(payload))
  }

  if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView
    return normalize(new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)))
  }

  if (typeof payload === 'object' && payload !== null && 'data' in (payload as JsonRecord)) {
    const data = (payload as { data: number[] }).data
    if (Array.isArray(data)) {
      return Uint8Array.from(data)
    }
  }

  if (typeof payload === 'string') {
    const value = payload.trim()

    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
        return Uint8Array.from(parsed.data)
      }
    } catch {
      // not JSON
    }

    if (value.startsWith('\\x') || value.startsWith('0x')) {
      const hexValue = value.replace(/^(\\x|0x)/, '')
      return normalize(hexToBytes(hexValue))
    }
    if (/^[0-9a-fA-F]+$/.test(value)) {
      return normalize(hexToBytes(value))
    }
    try {
      return normalize(base64ToBytes(value))
    } catch {
      return null
    }
  }

  return null
}

let cachedCryptoKey: CryptoKey | null = null
const textDecoder = new TextDecoder()

function parseEncryptionKey(): Uint8Array {
  if (!ENCRYPTION_KEY) {
    throw new Error('Missing ENCRYPTION_KEY environment variable.')
  }

  const rawKey = ENCRYPTION_KEY.trim()

  if (/^[0-9a-fA-F]+$/.test(rawKey) && rawKey.length === KEY_LENGTH * 2) {
    return hexToBytes(rawKey)
  }

  if (rawKey.length === KEY_LENGTH) {
    return new TextEncoder().encode(rawKey)
  }

  return base64ToBytes(rawKey)
}

async function getAesKey(): Promise<CryptoKey> {
  if (cachedCryptoKey) {
    return cachedCryptoKey
  }

  const keyBytes = parseEncryptionKey()
  if (keyBytes.length !== KEY_LENGTH) {
    throw new Error(`ENCRYPTION_KEY must resolve to ${KEY_LENGTH} bytes.`)
  }

  cachedCryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'])
  return cachedCryptoKey
}

async function decryptAccessToken(payload: unknown): Promise<string | null> {
  const encrypted = decodeEncryptedPayload(payload)
  if (!encrypted) {
    return null
  }

  if (encrypted.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('Encrypted payload too short to contain IV, auth tag, and ciphertext.')
  }

  const iv = encrypted.subarray(0, IV_LENGTH)
  const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = encrypted.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

  const combined = new Uint8Array(ciphertext.length + authTag.length)
  combined.set(ciphertext)
  combined.set(authTag, ciphertext.length)

  try {
    const key = await getAesKey()
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: AUTH_TAG_LENGTH * 8 },
      key,
      combined,
    )
    return textDecoder.decode(decrypted)
  } catch (error) {
    console.error('Failed to decrypt Meta access token:', error)
    throw new Error('Unable to decrypt Meta access token for tenant.')
  }
}

function getPreferredAccountId(meta: JsonRecord): string | null {
  if (typeof meta.selected_account_id === 'string' && meta.selected_account_id.length > 0) {
    return ensureActPrefix(meta.selected_account_id)
  }

  if (Array.isArray(meta.ad_accounts)) {
    for (const candidate of meta.ad_accounts) {
      if (!candidate) continue
      const identifier =
        typeof candidate.id === 'string'
          ? candidate.id
          : typeof candidate.account_id === 'string'
            ? candidate.account_id
            : null
      if (identifier) {
        return ensureActPrefix(identifier)
      }
    }
  }

  return null
}

function ensureJsonParams(params: Record<string, unknown>): URLSearchParams {
  const output = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      output.set(key, String(value))
      continue
    }
    output.set(key, JSON.stringify(value))
  }
  return output
}

async function fetchWithRetry(url: string, { method = 'GET', accessToken, body, logContext }: FetchOptions, attempt = 1): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  }

  let payload: BodyInit | undefined
  if (body instanceof URLSearchParams) {
    payload = body.toString()
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  } else if (body && typeof body === 'object') {
    payload = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: payload,
    })

    const usageAccount = response.headers.get('x-ad-account-usage') ?? undefined
    const usageBusiness = response.headers.get('x-business-use-case-usage') ?? undefined
    const usageApp = response.headers.get('x-app-usage') ?? undefined
    const fbTraceId = response.headers.get('x-fb-trace-id') ?? undefined
    const rateLimitType = response.headers.get('x-ratelimit-type') ?? undefined

    logSyncEvent('graph_request', {
      ...logContext,
      url,
      attempt,
      status: response.status,
      fb_trace_id: fbTraceId,
      ad_account_usage: usageAccount,
      business_use_case_usage: usageBusiness,
      app_usage: usageApp,
      rate_limit_type: rateLimitType,
    })

    if (response.ok) {
      return response
    }

    if (RETRIABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return fetchWithRetry(url, { method, accessToken, body, logContext }, attempt + 1)
    }

    return response
  } catch (error) {
    if (attempt >= MAX_ATTEMPTS) {
      throw error
    }
    const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return fetchWithRetry(url, { method, accessToken, body, logContext }, attempt + 1)
  }
}
async function readErrorPayload(response: Response): Promise<Error> {
  const text = await response.text()
  let message: string | undefined
  try {
    const parsed = text ? JSON.parse(text) : {}
    message =
      (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error.message === 'string'
        ? parsed.error.message
        : undefined) ?? (typeof parsed === 'string' ? parsed : undefined)
  } catch {
    message = text
  }

  const error = new Error(
    message ?? `Meta Graph request failed with status ${response.status}`,
  ) as Error & { status?: number; payload?: string }
  error.status = response.status
  error.payload = text
  return error
}

async function startInsightsJob(task: MatrixTask): Promise<{ jobId: string; resultUrl: string }> {
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}/${ensureActPrefix(task.accountId)}/insights`)
  url.searchParams.set('async', '1')
  url.searchParams.set('access_token', task.accessToken)

  const params = ensureJsonParams(
    buildParams({
      level: task.level,
      since: task.monthSince,
      until: task.monthUntil,
      breakdowns: task.breakdowns,
      actionReportTime: task.actionReportTime,
      attributionWindow: task.attributionWindow,
    }),
  )

  for (const [key, value] of params.entries()) {
    url.searchParams.set(key, value)
  }

  const response = await fetchWithRetry(url.toString(), {
    method: 'POST',
    accessToken: task.accessToken,
    logContext: {
      tenantId: task.tenantId,
      accountId: task.accountId,
      level: task.level,
      breakdownKey: task.breakdownKey,
      actionReportTime: task.actionReportTime,
      attributionWindow: task.attributionWindow,
      since: task.monthSince,
      until: task.monthUntil,
      action: 'start_insights_job',
    },
  })

  if (!response.ok) {
    throw await readErrorPayload(response)
  }

  const text = await response.text()
  let payload: JsonRecord
  try {
    payload = text ? (JSON.parse(text) as JsonRecord) : {}
  } catch {
    throw new Error(`Failed to parse Meta async job response: ${text}`)
  }

  const jobId =
    typeof payload.report_run_id === 'string'
      ? payload.report_run_id
      : typeof payload.id === 'string'
        ? payload.id
        : null

  if (!jobId) {
    throw new Error(`Meta async job response missing report_run_id/id: ${text}`)
  }

  const defaultResultUrl = `https://graph.facebook.com/${META_API_VERSION}/${jobId}/insights`
  const resultUrl = typeof payload.result_url === 'string' ? payload.result_url : defaultResultUrl

  logSyncEvent('async_job_started', {
    tenantId: task.tenantId,
    accountId: task.accountId,
    jobId,
    level: task.level,
    breakdownKey: task.breakdownKey,
    actionReportTime: task.actionReportTime,
    attributionWindow: task.attributionWindow,
    since: task.monthSince,
    until: task.monthUntil,
    resultUrl,
  })

  return { jobId, resultUrl }
}

async function pollInsightsJob(task: MatrixTask, jobId: string): Promise<PollJobResult> {
  const pollUrl = new URL(`https://graph.facebook.com/${META_API_VERSION}/${jobId}`)
  pollUrl.searchParams.set('access_token', task.accessToken)

  const start = Date.now()

  while (true) {
    const response = await fetchWithRetry(pollUrl.toString(), {
      method: 'GET',
      accessToken: task.accessToken,
      logContext: {
        tenantId: task.tenantId,
        accountId: task.accountId,
        jobId,
        action: 'poll_insights_job',
      },
    })

    if (!response.ok) {
      throw await readErrorPayload(response)
    }

    const text = await response.text()
    let payload: JsonRecord
    try {
      payload = text ? (JSON.parse(text) as JsonRecord) : {}
    } catch {
      throw new Error(`Failed to parse Meta async poll response: ${text}`)
    }

    const status = typeof payload.async_status === 'string' ? payload.async_status : undefined
    const percent =
      typeof payload.async_percent_completion === 'number'
        ? payload.async_percent_completion
        : undefined

    logSyncEvent('async_job_status', {
      tenantId: task.tenantId,
      accountId: task.accountId,
      jobId,
      status,
      percent,
    })

    if (status === 'Job Completed') {
      const resultUrls: string[] = []
      if (Array.isArray(payload.result_urls)) {
        for (const entry of payload.result_urls) {
          if (typeof entry === 'string') {
            resultUrls.push(entry)
          }
        }
      }
      if (typeof payload.result_url === 'string') {
        resultUrls.push(payload.result_url)
      }
      if (resultUrls.length === 0) {
        resultUrls.push(`https://graph.facebook.com/${META_API_VERSION}/${jobId}/insights`)
      }
      return {
        files: Array.from(new Set(resultUrls)),
        jobId,
        raw: payload,
      }
    }

    if (status && status.toLowerCase().includes('failed')) {
      throw new Error(`Meta async job ${jobId} failed with status ${status}`)
    }

    if (Date.now() - start > 15 * 60 * 1000) {
      throw new Error(`Meta async job ${jobId} timed out after 15 minutes`)
    }

    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

async function fetchResultPage(task: MatrixTask, url: string): Promise<FetchResultPageResult> {
  const target = new URL(url)
  if (!target.searchParams.has('access_token')) {
    target.searchParams.set('access_token', task.accessToken)
  }

  const response = await fetchWithRetry(target.toString(), {
    method: 'GET',
    accessToken: task.accessToken,
    logContext: {
      tenantId: task.tenantId,
      accountId: task.accountId,
      level: task.level,
      breakdownKey: task.breakdownKey,
      actionReportTime: task.actionReportTime,
      attributionWindow: task.attributionWindow,
      action: 'fetch_insights_page',
    },
  })

  if (!response.ok) {
    throw await readErrorPayload(response)
  }

  const text = await response.text()
  let payload: JsonRecord
  try {
    payload = text ? (JSON.parse(text) as JsonRecord) : {}
  } catch {
    throw new Error(`Failed to parse Meta insights page response: ${text}`)
  }

  const data = Array.isArray(payload.data) ? (payload.data as any[]) : []
  const next =
    payload.paging && typeof (payload.paging as JsonRecord).next === 'string'
      ? ((payload.paging as JsonRecord).next as string)
      : undefined

  return { data, next, raw: payload }
}
function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null
  }
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function parseArray<T>(value: unknown): T[] | null {
  return Array.isArray(value) ? (value as T[]) : null
}

function extractActionCount(collection: any[] | null, predicate: (actionType: string) => boolean): number | null {
  if (!Array.isArray(collection)) {
    return null
  }
  for (const entry of collection) {
    const actionType = typeof entry?.action_type === 'string' ? entry.action_type : ''
    if (!predicate(actionType)) {
      continue
    }
    const value = entry?.value ?? entry?.count
    const parsed = parseNumber(value)
    if (parsed !== null) {
      return parsed
    }
  }
  return null
}

function extractActionValue(collection: any[] | null, predicate: (actionType: string) => boolean): number | null {
  if (!Array.isArray(collection)) {
    return null
  }
  for (const entry of collection) {
    const actionType = typeof entry?.action_type === 'string' ? entry.action_type : ''
    if (!predicate(actionType)) {
      continue
    }
    const parsed = parseNumber(entry?.value)
    if (parsed !== null) {
      return parsed
    }
  }
  return null
}

function deriveEntityId(level: InsightLevel, row: JsonRecord): string | null {
  switch (level) {
    case 'account':
      return typeof row.account_id === 'string' ? row.account_id : null
    case 'campaign':
      return typeof row.campaign_id === 'string' ? row.campaign_id : null
    case 'adset':
      return typeof row.adset_id === 'string' ? row.adset_id : null
    case 'ad':
      return typeof row.ad_id === 'string' ? row.ad_id : null
    default:
      return null
  }
}

type BuildParamsInput = {
  level: InsightLevel
  since: string
  until: string
  breakdowns?: string
  actionReportTime: ActionReportTime
  attributionWindow: AttributionWindow
}

function buildParams({
  level,
  since,
  until,
  breakdowns,
  actionReportTime,
  attributionWindow,
}: BuildParamsInput): Record<string, unknown> {
  const params: Record<string, unknown> = {
    fields: (level === 'account' ? ACCOUNT_FIELDS : ENTITY_FIELDS).join(','),
    level,
    time_range: { since, until },
    time_increment: 1,
    limit: 500,
    action_report_time: actionReportTime,
    action_attribution_windows: [attributionWindow],
  }

  if (breakdowns && breakdowns.length > 0) {
    params.breakdowns = breakdowns
  }

  return params
}

const ACCOUNT_FIELDS: readonly string[] = [
  'account_id',
  'date_start',
  'date_stop',
  'impressions',
  'reach',
  'clicks',
  'unique_clicks',
  'inline_link_clicks',
  'spend',
  'cpm',
  'cpc',
  'ctr',
  'actions',
  'action_values',
  'purchase_roas',
  'cost_per_action_type',
  'frequency',
  'account_currency',
]

const ENTITY_FIELDS: readonly string[] = [
  'account_id',
  'campaign_id',
  'campaign_name',
  'campaign_effective_status',
  'campaign_status',
  'buying_type',
  'daily_budget',
  'lifetime_budget',
  'adset_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'date_start',
  'date_stop',
  'impressions',
  'reach',
  'clicks',
  'unique_clicks',
  'inline_link_clicks',
  'spend',
  'cpm',
  'cpc',
  'ctr',
  'actions',
  'action_values',
  'conversions',
  'purchase_roas',
  'cost_per_action_type',
  'frequency',
  'objective',
  'account_currency',
]

async function hashBreakdowns(breakdowns: Record<string, string | null>): Promise<string> {
  const normalizedEntries = Object.entries(breakdowns)
    .map(([key, value]) => [key, value ?? null] as const)
    .sort(([a], [b]) => a.localeCompare(b))

  const data = new TextEncoder().encode(JSON.stringify(normalizedEntries))
  const hashBuffer = await crypto.subtle.digest('SHA-1', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

function normalizeRow(
  row: JsonRecord,
  {
    level,
    breakdownKeys,
    breakdownKey,
  }: {
    level: InsightLevel
    breakdownKeys: string[]
    breakdownKey?: string
  },
): NormalizedInsightRow | null {
  const entityId = deriveEntityId(level, row)
  if (!entityId) {
    return null
  }

  const actions = parseArray<any>(row.actions)
  const actionValues = parseArray<any>(row.action_values)

  const breakdowns: Record<string, string | null> = {}
  // Check if this is country_priority breakdown for country mapping
  const isCountryPriority = breakdownKey === 'country_priority'
  
  for (const key of breakdownKeys) {
    if (!key) continue
    let value = row[key]
    if (value === null || value === undefined) {
      breakdowns[key] = null
      continue
    }
    
    // Map country to priority countries (DE, SE, NO, FI) or OTHER for country_priority breakdown
    if (isCountryPriority && key === 'country' && typeof value === 'string') {
      const upper = value.toUpperCase()
      value = COUNTRY_PRIORITY_CODES.has(upper) ? upper : 'OTHER'
    }
    
    breakdowns[key] = typeof value === 'string' ? value : String(value)
  }

  return {
    dateStart: typeof row.date_start === 'string' ? row.date_start : isoDate(new Date()),
    dateStop: typeof row.date_stop === 'string' ? row.date_stop : isoDate(new Date()),
    accountId: typeof row.account_id === 'string' ? row.account_id : null,
    campaignId: typeof row.campaign_id === 'string' ? row.campaign_id : null,
    campaignName: typeof row.campaign_name === 'string' ? row.campaign_name : null,
    adsetId: typeof row.adset_id === 'string' ? row.adset_id : null,
    adsetName: typeof row.adset_name === 'string' ? row.adset_name : null,
    adId: typeof row.ad_id === 'string' ? row.ad_id : null,
    adName: typeof row.ad_name === 'string' ? row.ad_name : null,
    entityId,
    currency: typeof row.account_currency === 'string' ? row.account_currency : null,
    spend: parseNumber(row.spend),
    impressions: parseNumber(row.impressions),
    reach: parseNumber(row.reach),
    clicks: parseNumber(row.clicks),
    uniqueClicks: parseNumber(row.unique_clicks),
    inlineLinkClicks: parseNumber(row.inline_link_clicks),
    conversions: parseNumber(row.conversions),
    purchases: extractActionCount(actions, (type) => type.toLowerCase().includes('purchase')),
    addToCart: extractActionCount(actions, (type) => type.toLowerCase().includes('add_to_cart')),
    leads: extractActionCount(actions, (type) => type.toLowerCase().includes('lead')),
    revenue: extractActionValue(actionValues, (type) => type.toLowerCase().includes('purchase')),
    purchaseRoas: parseArray<any>(row.purchase_roas),
    costPerActionType: parseArray<any>(row.cost_per_action_type),
    cpm: parseNumber(row.cpm),
    cpc: parseNumber(row.cpc),
    ctr: parseNumber(row.ctr),
    frequency: parseNumber(row.frequency),
    objective: typeof row.objective === 'string' ? row.objective : null,
    effectiveStatus:
      typeof row.campaign_effective_status === 'string' ? row.campaign_effective_status : null,
    configuredStatus: typeof row.campaign_status === 'string' ? row.campaign_status : null,
    buyingType: typeof row.buying_type === 'string' ? row.buying_type : null,
    dailyBudget: parseNumber(row.daily_budget),
    lifetimeBudget: parseNumber(row.lifetime_budget),
    actions,
    actionValues,
    breakdowns,
  }
}

async function toDailyRow(
  tenantId: string,
  accountId: string,
  context: Pick<MatrixTask, 'level' | 'breakdownKey' | 'actionReportTime' | 'attributionWindow'>,
  normalized: NormalizedInsightRow,
) {
  const breakdownsHash = await hashBreakdowns(normalized.breakdowns)
  return {
    tenant_id: tenantId,
    date: normalized.dateStart,
    date_stop: normalized.dateStop,
    level: context.level,
    entity_id: normalized.entityId,
    ad_account_id: accountId,
    campaign_id: normalized.campaignId,
    adset_id: normalized.adsetId,
    ad_id: normalized.adId,
    campaign_name: normalized.campaignName,
    adset_name: normalized.adsetName,
    ad_name: normalized.adName,
    action_report_time: context.actionReportTime,
    attribution_window: context.attributionWindow,
    breakdowns_key: context.breakdownKey || null,
    breakdowns_hash: breakdownsHash,
    breakdowns: normalized.breakdowns,
    actions: normalized.actions,
    action_values: normalized.actionValues,
    spend: normalized.spend,
    impressions: normalized.impressions,
    reach: normalized.reach,
    clicks: normalized.clicks,
    unique_clicks: normalized.uniqueClicks,
    inline_link_clicks: normalized.inlineLinkClicks,
    conversions: normalized.conversions,
    purchases: normalized.purchases,
    add_to_cart: normalized.addToCart,
    leads: normalized.leads,
    revenue: normalized.revenue,
    purchase_roas: normalized.purchaseRoas,
    cost_per_action_type: normalized.costPerActionType,
    cpm: normalized.cpm,
    cpc: normalized.cpc,
    ctr: normalized.ctr,
    frequency: normalized.frequency,
    objective: normalized.objective,
    effective_status: normalized.effectiveStatus,
    configured_status: normalized.configuredStatus,
    buying_type: normalized.buyingType,
    daily_budget: normalized.dailyBudget,
    lifetime_budget: normalized.lifetimeBudget,
    currency: normalized.currency,
  }
}

function toFactRow(
  tenantId: string,
  accountId: string,
  normalized: NormalizedInsightRow,
  level: InsightLevel,
): FactRow {
  const roas = normalized.spend && normalized.spend > 0 && normalized.revenue ? normalized.revenue / normalized.spend : null
  const cos = normalized.revenue && normalized.revenue > 0 && normalized.spend ? normalized.spend / normalized.revenue : null

  return {
    tenant_id: tenantId,
    ad_account_id: accountId,
    date: normalized.dateStart,
    level,
    campaign_id: normalized.campaignId,
    campaign_name: normalized.campaignName,
    adset_id: normalized.adsetId,
    adset_name: normalized.adsetName,
    ad_id: normalized.adId,
    ad_name: normalized.adName,
    currency: normalized.currency,
    spend: normalized.spend,
    impressions: normalized.impressions,
    clicks: normalized.clicks,
    purchases: normalized.purchases,
    add_to_cart: normalized.addToCart,
    leads: normalized.leads,
    revenue: normalized.revenue,
    reach: normalized.reach,
    frequency: normalized.frequency,
    cpm: normalized.cpm,
    cpc: normalized.cpc,
    ctr: normalized.ctr,
    objective: normalized.objective,
    effective_status: normalized.effectiveStatus,
    configured_status: normalized.configuredStatus,
    buying_type: normalized.buyingType,
    daily_budget: normalized.dailyBudget,
    lifetime_budget: normalized.lifetimeBudget,
    roas,
    cos,
  }
}

function toMetaRow(tenantId: string, accountId: string, normalized: NormalizedInsightRow): MetaInsightRow {
  return {
    tenant_id: tenantId,
    date: normalized.dateStart,
    ad_account_id: accountId,
    campaign_id: normalized.campaignId,
    adset_id: normalized.adsetId,
    ad_id: normalized.adId,
    spend: normalized.spend,
    impressions: normalized.impressions,
    clicks: normalized.clicks,
    purchases: normalized.purchases,
    revenue: normalized.revenue,
    currency: normalized.currency ?? null,
    link_clicks: normalized.inlineLinkClicks ?? null,
  }
}

async function upsertDailyRows(client: SupabaseClient, rows: ReturnType<typeof toDailyRow>[]) {
  if (rows.length === 0) {
    return
  }
  for (let cursor = 0; cursor < rows.length; cursor += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(cursor, cursor + UPSERT_BATCH_SIZE)
    const { error } = await client
      .from('meta_insights_daily')
      .upsert(batch, {
        onConflict: 'tenant_id,date,level,entity_id,action_report_time,attribution_window,breakdowns_hash',
      })
    if (error) {
      throw new Error(`Failed to upsert meta_insights_daily: ${error.message}`)
    }
  }
}

async function runWithConcurrency<T>(items: T[], limit: number, handler: (item: T) => Promise<void>): Promise<void> {
  const executing: Promise<void>[] = []
  for (const item of items) {
    const promise = handler(item).finally(() => {
      const index = executing.indexOf(promise)
      if (index >= 0) executing.splice(index, 1)
    })
    executing.push(promise)
    if (executing.length >= limit) {
      await Promise.race(executing)
    }
  }
  await Promise.all(executing)
}
function enumerateMonths(since: string, until: string): Array<{ monthSince: string; monthUntil: string }> {
  const results: Array<{ monthSince: string; monthUntil: string }> = []

  const cursor = new Date(`${since}T00:00:00Z`)
  const end = new Date(`${until}T00:00:00Z`)
  cursor.setUTCDate(1)

  while (cursor <= end) {
    const monthStart = new Date(cursor)
    const monthEnd = new Date(cursor)
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1)
    monthEnd.setUTCDate(0)

    const monthSince = isoDate(monthStart)
    const monthUntil = monthEnd > end ? isoDate(end) : isoDate(monthEnd)
    results.push({ monthSince, monthUntil })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }

  return results
}

async function runMonthlyChunk(task: MatrixTask): Promise<NormalizedInsightRow[]> {
  const { jobId, resultUrl } = await startInsightsJob(task)
  const pollResult = await pollInsightsJob(task, jobId)
  const files = pollResult.files.length > 0 ? pollResult.files : [resultUrl]

  const breakdownKeys = task.breakdownKey === 'none' ? [] : task.breakdowns.split(',').filter((item) => item.length > 0)
  const rows: NormalizedInsightRow[] = []

  for (const fileUrl of files) {
    let next: string | undefined = fileUrl
    while (next) {
      const page = await fetchResultPage(task, next)
      for (const raw of page.data) {
        if (!raw || typeof raw !== 'object') {
          continue
        }
        const normalized = normalizeRow(raw as JsonRecord, {
          level: task.level,
          breakdownKeys,
          breakdownKey: task.breakdownKey,
        })
        if (normalized) {
          rows.push(normalized)
        }
      }
      next = page.next
    }
  }

  logSyncEvent('chunk_complete', {
    tenantId: task.tenantId,
    accountId: task.accountId,
    jobId,
    level: task.level,
    breakdownKey: task.breakdownKey,
    actionReportTime: task.actionReportTime,
    attributionWindow: task.attributionWindow,
    since: task.monthSince,
    until: task.monthUntil,
    rows: rows.length,
  })

  return rows
}

async function runFullMatrix(
  client: SupabaseClient,
  tenantId: string,
  accountId: string,
  accessToken: string,
  since: string,
  until: string,
): Promise<MatrixRunResult> {
  const months = enumerateMonths(since, until)
  const tasks: MatrixTask[] = []

  // Optimize for Skinome: use only impression + 1d_click to reduce API calls and timeout risk
  const isSkinome = tenantId === SKINOME_TENANT_ID
  const actionReportTimes = isSkinome ? SKINOME_OPTIMIZED_ACTION_REPORT_TIMES : ACTION_REPORT_TIMES
  const attrWindows = isSkinome ? SKINOME_OPTIMIZED_ATTR_WINDOWS : ATTR_WINDOWS

  for (const level of LEVELS) {
    for (const [breakdownKey, breakdowns] of Object.entries(BREAKDOWN_SETS)) {
      for (const actionReportTime of actionReportTimes) {
        for (const attributionWindow of attrWindows) {
          for (const { monthSince, monthUntil } of months) {
            tasks.push({
              tenantId,
              accountId,
              accessToken,
              level,
              breakdownKey,
              breakdownKeys: breakdowns ? breakdowns.split(',').filter(Boolean) : [],
              breakdowns,
              actionReportTime,
              attributionWindow,
              monthSince,
              monthUntil,
            })
          }
        }
      }
    }
  }

  const factRows: FactRow[] = []
  const accountRows: MetaInsightRow[] = []
  let minDate: string | null = null
  let maxDate: string | null = null
  let dailyRowCount = 0

  await runWithConcurrency(tasks, MAX_PARALLEL_MATRIX_JOBS, async (task) => {
    const normalizedRows = await runMonthlyChunk(task)
    if (normalizedRows.length === 0) {
      return
    }

    const dailyRows = await Promise.all(
      normalizedRows.map((row) => toDailyRow(tenantId, accountId, task, row))
    )
    const validDailyRows = dailyRows.filter((row) => typeof row.entity_id === 'string' && row.entity_id.length > 0)

    await upsertDailyRows(client, validDailyRows)
    dailyRowCount += validDailyRows.length

    for (const row of normalizedRows) {
      const date = row.dateStart
      if (!minDate || date < minDate) {
        minDate = date
      }
      if (!maxDate || date > maxDate) {
        maxDate = date
      }
    }

    // For Skinome, canonical combo is impression + 1d_click + none breakdown
    // For others, canonical combo is impression + 7d_click + none breakdown
    const isSkinome = tenantId === SKINOME_TENANT_ID
    const canonicalAttrWindow = isSkinome ? '1d_click' : CANONICAL_ATTRIBUTION_WINDOW
    const isCanonicalCombo =
      task.breakdownKey === CANONICAL_BREAKDOWN_KEY &&
      task.actionReportTime === CANONICAL_ACTION_REPORT_TIME &&
      task.attributionWindow === canonicalAttrWindow

    if (isCanonicalCombo) {
      for (const row of normalizedRows) {
        if (!row.entityId) continue
        factRows.push(toFactRow(tenantId, accountId, row, task.level))
        if (task.level === 'account') {
          accountRows.push(toMetaRow(tenantId, accountId, row))
        }
      }
    }
  })

  return {
    factRows,
    accountRows,
    windowSince: minDate ?? since,
    windowUntil: maxDate ?? until,
    dailyRowCount,
  }
}
function aggregateKpis(rows: MetaInsightRow[]) {
  const byDate = new Map<
    string,
    {
      spend: number
      clicks: number
      linkClicks: number
      conversions: number
      revenue: number
      currency: string | null
    }
  >()

  for (const row of rows) {
    const bucket =
      byDate.get(row.date) ?? {
        spend: 0,
        clicks: 0,
        linkClicks: 0,
        conversions: 0,
        revenue: 0,
        currency: row.currency ?? null,
      }
    bucket.spend += row.spend ?? 0
    bucket.clicks += row.clicks ?? 0
    bucket.linkClicks += row.link_clicks ?? 0
    bucket.conversions += row.purchases ?? 0
    bucket.revenue += row.revenue ?? 0
    if (!bucket.currency && row.currency) {
      bucket.currency = row.currency
    }
    byDate.set(row.date, bucket)
  }

  return Array.from(byDate.entries()).map(([date, values]) => {
    const aov = values.conversions > 0 ? values.revenue / values.conversions : null
    const cos = values.revenue > 0 ? values.spend / values.revenue : null
    const roas = values.spend > 0 ? values.revenue / values.spend : null

    return {
      date,
      spend: values.spend || null,
      clicks: values.linkClicks || null,
      conversions: values.conversions || null,
      revenue: values.revenue || null,
      aov,
      cos,
      roas,
      currency: values.currency ?? null,
    }
  })
}

function fillMissingAggregateDates(
  aggregates: ReturnType<typeof aggregateKpis>,
  windowSince: string,
  windowUntil: string,
) {
  const aggregateByDate = new Map(aggregates.map((entry) => [entry.date, entry]))
  const filled: ReturnType<typeof aggregateKpis> = []

  const start = new Date(windowSince)
  const end = new Date(windowUntil)

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return aggregates
  }

  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const key = isoDate(cursor)
    const existing = aggregateByDate.get(key)
    if (existing) {
      filled.push(existing)
      continue
    }
    filled.push({
      date: key,
      spend: 0,
      clicks: 0,
      conversions: 0,
      revenue: 0,
      aov: null,
      cos: null,
      roas: null,
      currency: aggregates.find((entry) => entry.currency)?.currency ?? null,
    })
  }

  return filled
}

async function fetchMetaCampaignCatalog(
  tenantId: string,
  accessToken: string,
  adAccountId: string,
): Promise<MetaCampaignRecord[]> {
  const normalizedAccountId = ensureActPrefix(adAccountId)
  const campaigns: MetaCampaignRecord[] = []
  let url: string | null = `https://graph.facebook.com/${META_API_VERSION}/${normalizedAccountId}/campaigns` +
    `?limit=500&fields=id,name,status,effective_status,configured_status,objective,buying_type,start_time,stop_time,created_time,updated_time,daily_budget,lifetime_budget,budget_remaining,special_ad_categories,issues_info`

  while (url) {
    const response = await fetchWithRetry(url, {
      method: 'GET',
      accessToken,
      logContext: {
        tenantId,
        accountId: normalizedAccountId,
        action: 'campaign_catalog_page',
      },
    })

    if (!response.ok) {
      throw await readErrorPayload(response)
    }

    const payload = await response.json()
    const rows = Array.isArray(payload?.data) ? payload.data : []

    for (const row of rows) {
      if (!row || typeof row.id !== 'string') continue
      campaigns.push({
        tenant_id: tenantId,
        id: row.id,
        account_id: normalizedAccountId,
        name: typeof row.name === 'string' ? row.name : null,
        status: typeof row.status === 'string' ? row.status : null,
        effective_status: typeof row.effective_status === 'string' ? row.effective_status : null,
        configured_status: typeof row.configured_status === 'string' ? row.configured_status : null,
        objective: typeof row.objective === 'string' ? row.objective : null,
        buying_type: typeof row.buying_type === 'string' ? row.buying_type : null,
        start_time: typeof row.start_time === 'string' ? row.start_time : null,
        stop_time: typeof row.stop_time === 'string' ? row.stop_time : null,
        created_time: typeof row.created_time === 'string' ? row.created_time : null,
        updated_time: typeof row.updated_time === 'string' ? row.updated_time : null,
        daily_budget: parseNumber(row.daily_budget),
        lifetime_budget: parseNumber(row.lifetime_budget),
        budget_remaining: parseNumber(row.budget_remaining),
        special_ad_categories: row.special_ad_categories ?? null,
        issues_info: row.issues_info ?? null,
      })
    }

    const next = payload?.paging?.next
    url = typeof next === 'string' && next.length > 0 ? next : null
  }

  return campaigns
}

async function upsertJobLog(client: SupabaseClient, payload: {
  tenantId: string
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt?: string
  error?: string
}) {
  const { error } = await client.from('jobs_log').insert({
    tenant_id: payload.tenantId,
    source: SOURCE,
    status: payload.status,
    started_at: payload.startedAt,
    finished_at: payload.finishedAt ?? null,
    error: payload.error ?? null,
  })
  if (error) {
    console.error(`Failed to write jobs_log for tenant ${payload.tenantId}:`, error)
  }
}
async function processTenant(
  client: SupabaseClient,
  connection: MetaConnection,
  options?: ProcessOptions,
): Promise<JobResult> {
  const tenantId = connection.tenant_id
  const connectionMeta: JsonRecord = connection.meta && typeof connection.meta === 'object' ? { ...connection.meta } : {}
  const mode: 'incremental' | 'backfill' = options?.mode ?? 'incremental'
  const windowOverride = options?.windowOverride
  const startedAt = new Date().toISOString()
  const syncWindow = resolveSyncWindow(connectionMeta, {
    mode,
    since: windowOverride?.since,
    until: windowOverride?.until,
  })

  let jobLogInserted = false
  try {
    await upsertJobLog(client, { tenantId, status: 'running', startedAt })
    jobLogInserted = true
  } catch (logError) {
    console.error(`Failed to insert initial job log for tenant ${tenantId}:`, logError)
    // Continue anyway - we'll try to update it later
  }

  try {
    const accessToken = await decryptAccessToken(connection.access_token_enc)
    if (!accessToken) {
      throw new Error('No Meta access token stored for tenant. Connect Meta to enable syncing.')
    }

    const requestedAccountId = options?.accountId ? ensureActPrefix(options.accountId) : null
    const preferredAccountId = requestedAccountId ?? getPreferredAccountId(connectionMeta)
    if (!preferredAccountId) {
      throw new Error('Meta connection saknar valt ad-konto. Välj ett konto i adminpanelen.')
    }

    const accountMeta =
      Array.isArray(connectionMeta?.ad_accounts)
        ? (connectionMeta.ad_accounts as JsonRecord[]).find((item) => {
            const identifier = typeof item?.id === 'string' ? item.id : item?.account_id
            return identifier && ensureActPrefix(String(identifier)) === preferredAccountId
          }) ?? null
        : null

    if (accountMeta) {
      const accountRecord = {
        id: ensureActPrefix(
          typeof accountMeta.id === 'string' ? accountMeta.id : accountMeta.account_id ?? preferredAccountId,
        ),
        tenant_id: tenantId,
        name: typeof accountMeta.name === 'string' ? accountMeta.name : null,
        currency: typeof accountMeta.currency === 'string' ? accountMeta.currency : null,
        status:
          typeof accountMeta.account_status === 'number'
            ? String(accountMeta.account_status)
            : typeof accountMeta.account_status === 'string'
              ? accountMeta.account_status
              : null,
        metadata: accountMeta,
      }

      const { error: accountUpsertError } = await client.from('meta_accounts').upsert(accountRecord, {
        onConflict: 'id',
      })
      if (accountUpsertError) {
        console.error(`Failed to upsert meta_accounts for tenant ${tenantId}:`, accountUpsertError)
      }
    }

    // Skip campaign catalog fetch for Skinome to avoid timeout
    const isSkinome = tenantId === SKINOME_TENANT_ID
    let campaignCatalog: MetaCampaignRecord[] = []
    if (!isSkinome) {
      try {
        campaignCatalog = await fetchMetaCampaignCatalog(tenantId, accessToken, preferredAccountId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`Failed to fetch campaign catalog for tenant ${tenantId}, account ${preferredAccountId}:`, message)
        // Continue with insights sync even if campaign catalog fails
      }
    } else {
      console.log(`Skipping campaign catalog fetch for Skinome tenant ${tenantId} to avoid timeout`)
    }

    // Wrap runFullMatrix in try-catch to handle timeouts/permissions errors gracefully
    // If it fails, we can still aggregate KPI from existing meta_insights_daily data
    let matrixResult: MatrixRunResult
    let matrixRunFailed = false
    let matrixRunError: string | null = null
    
    try {
      matrixResult = await runFullMatrix(
        client,
        tenantId,
        preferredAccountId,
        accessToken,
        syncWindow.since,
        syncWindow.until,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      matrixRunError = message
      matrixRunFailed = true
      
      // Check if it's a permissions error - log but continue with fallback
      if (message.includes('does not exist') || message.includes('cannot be loaded due to missing permissions')) {
        console.warn(`Meta API permissions error for tenant ${tenantId}, account ${preferredAccountId}: ${message}`)
        console.warn('Continuing with KPI aggregation from existing meta_insights_daily data')
      } else {
        console.error(`runFullMatrix failed for tenant ${tenantId}: ${message}`)
      }
      
      // Create empty matrix result - we'll use fallback KPI aggregation
      matrixResult = {
        factRows: [],
        accountRows: [],
        windowSince: syncWindow.since,
        windowUntil: syncWindow.until,
        dailyRowCount: 0,
      }
    }

    if (campaignCatalog.length > 0) {
      const metaMap = new Map(
        campaignCatalog.map((entry) => [
          entry.id,
          {
            name: entry.name,
            objective: entry.objective,
            effective_status: entry.effective_status,
            configured_status: entry.configured_status,
            buying_type: entry.buying_type,
            daily_budget: entry.daily_budget,
            lifetime_budget: entry.lifetime_budget,
          },
        ]),
      )

      for (const row of matrixResult.factRows) {
        if (row.campaign_id && metaMap.has(row.campaign_id)) {
          const meta = metaMap.get(row.campaign_id)!
          row.campaign_name = row.campaign_name ?? meta.name ?? null
          row.objective = row.objective ?? meta.objective ?? null
          row.effective_status = row.effective_status ?? meta.effective_status ?? null
          row.configured_status = row.configured_status ?? meta.configured_status ?? null
          row.buying_type = row.buying_type ?? meta.buying_type ?? null
          row.daily_budget = row.daily_budget ?? meta.daily_budget ?? null
          row.lifetime_budget = row.lifetime_budget ?? meta.lifetime_budget ?? null
        }
      }
    }

    // Only upsert factRows if runFullMatrix succeeded and returned data
    if (matrixResult.factRows.length > 0 && !matrixRunFailed) {
      const { error: deleteError } = await client
        .from('meta_insights_levels')
        .delete()
        .eq('tenant_id', tenantId)
        .eq('ad_account_id', preferredAccountId)
        .gte('date', matrixResult.windowSince)
        .lte('date', matrixResult.windowUntil)

      if (deleteError) {
        throw new Error(deleteError.message)
      }

      for (let cursor = 0; cursor < matrixResult.factRows.length; cursor += UPSERT_BATCH_SIZE) {
        const batch = matrixResult.factRows.slice(cursor, cursor + UPSERT_BATCH_SIZE)
        const { error: insertError } = await client.from('meta_insights_levels').insert(batch)
        if (insertError) {
          throw new Error(insertError.message)
        }
      }

      logSyncEvent('fact_upsert', {
        tenantId,
        accountId: preferredAccountId,
        windowSince: matrixResult.windowSince,
        windowUntil: matrixResult.windowUntil,
        rows: matrixResult.factRows.length,
      })
    } else if (matrixRunFailed) {
      console.warn(`Skipping factRows upsert for tenant ${tenantId} because runFullMatrix failed`)
    }

    if (campaignCatalog.length > 0) {
      const rows = campaignCatalog.map((campaign) => ({
        ...campaign,
        updated_at: new Date().toISOString(),
      }))
      for (let cursor = 0; cursor < rows.length; cursor += UPSERT_BATCH_SIZE) {
        const batch = rows.slice(cursor, cursor + UPSERT_BATCH_SIZE)
        const { error: campaignError } = await client.from('meta_campaigns').upsert(batch, {
          onConflict: 'tenant_id,id',
        })
        if (campaignError) {
          console.error(`Failed to upsert meta_campaigns for tenant ${tenantId}:`, campaignError)
          break
        }
      }
    }

    // Aggregate kpi_daily from accountRows (canonical combo: impression + 7d_click + none breakdown)
    // If no accountRows, aggregate directly from meta_insights_daily with 1d_click for incremental sync
    let kpiRows: Array<{
      tenant_id: string
      date: string
      source: string
      spend: number | null
      clicks: number | null
      conversions: number | null
      revenue: number | null
      aov: number | null
      cos: number | null
      roas: number | null
      currency: string | null
    }> = []

    if (matrixResult.accountRows.length > 0) {
      const aggregates = aggregateKpis(matrixResult.accountRows)
      const normalizedAggregates = fillMissingAggregateDates(
        aggregates,
        matrixResult.windowSince,
        matrixResult.windowUntil,
      )

      kpiRows = normalizedAggregates.map((row) => ({
        tenant_id: tenantId,
        date: row.date,
        source: SOURCE,
        spend: row.spend,
        clicks: row.clicks,
        conversions: row.conversions,
        revenue: row.revenue,
        aov: row.aov,
        cos: row.cos,
        roas: row.roas,
        currency: row.currency ?? null,
      }))
    } else {
      // Fallback: always aggregate from meta_insights_daily if accountRows are missing
      // This ensures KPI data is updated even if runFullMatrix fails, returns no accountRows,
      // or if canonical combo (7d_click) is not available
      // (previously only done for incremental mode, now done for both modes)
      const { data: insightsData, error: insightsError } = await client
        .from('meta_insights_daily')
        .select('date, spend, inline_link_clicks, purchases, conversions, revenue, currency')
        .eq('tenant_id', tenantId)
        .eq('ad_account_id', preferredAccountId)
        .eq('level', 'account')
        .eq('action_report_time', 'impression')
        .eq('attribution_window', '1d_click')
        .eq('breakdowns_key', 'none')
        .gte('date', matrixResult.windowSince)
        .lte('date', matrixResult.windowUntil)

      if (insightsError) {
        console.warn(`Failed to fetch insights for kpi_daily fallback: ${insightsError.message}`)
      } else if (insightsData && insightsData.length > 0) {
        const byDate = new Map<string, {
          spend: number
          clicks: number
          conversions: number
          revenue: number
          currency: string | null
        }>()

        for (const row of insightsData) {
          const date = row.date
          const existing = byDate.get(date) ?? {
            spend: 0,
            clicks: 0,
            conversions: 0,
            revenue: 0,
            currency: row.currency ?? null,
          }

          existing.spend += row.spend ?? 0
          existing.clicks += row.inline_link_clicks ?? 0
          existing.conversions += (row.purchases ?? 0) + (row.conversions ?? 0)
          existing.revenue += row.revenue ?? 0
          if (!existing.currency && row.currency) {
            existing.currency = row.currency
          }

          byDate.set(date, existing)
        }

        const normalizedAggregates = fillMissingAggregateDates(
          Array.from(byDate.entries()).map(([date, values]) => ({
            date,
            spend: values.spend || null,
            clicks: values.clicks || null,
            conversions: values.conversions || null,
            revenue: values.revenue || null,
            aov: values.conversions > 0 ? values.revenue / values.conversions : null,
            cos: values.revenue > 0 ? values.spend / values.revenue : null,
            roas: values.spend > 0 ? values.revenue / values.spend : null,
            currency: values.currency ?? null,
          })),
          matrixResult.windowSince,
          matrixResult.windowUntil,
        )

        kpiRows = normalizedAggregates.map((row) => ({
          tenant_id: tenantId,
          date: row.date,
          source: SOURCE,
          spend: row.spend,
          clicks: row.clicks,
          conversions: row.conversions,
          revenue: row.revenue,
          aov: row.aov,
          cos: row.cos,
          roas: row.roas,
          currency: row.currency ?? null,
        }))
      }
    }

    if (kpiRows.length > 0) {
      const { error: kpiError } = await client.from('kpi_daily').upsert(kpiRows, {
        onConflict: 'tenant_id,date,source',
      })

      if (kpiError) {
        throw new Error(kpiError.message)
      }
    }

    const finishedAt = new Date().toISOString()

    if (mode === 'backfill') {
      connectionMeta.last_backfill_at = finishedAt
      connectionMeta.last_backfill_range = {
        since: matrixResult.windowSince,
        until: matrixResult.windowUntil,
      }
    } else {
      connectionMeta.last_synced_at = finishedAt
      connectionMeta.last_synced_range = {
        since: matrixResult.windowSince,
        until: matrixResult.windowUntil,
      }
      connectionMeta.last_synced_account_id = preferredAccountId
      connectionMeta.last_synced_token_source = 'tenant'
    }

    const { error: connectionUpdateError } = await client
      .from('connections')
      .update({
        meta: connectionMeta,
        updated_at: finishedAt,
      })
      .eq('tenant_id', tenantId)
      .eq('source', SOURCE)

    if (connectionUpdateError) {
      console.error(`Failed to update connection metadata for tenant ${tenantId}:`, connectionUpdateError)
    }

    // If runFullMatrix failed but we managed to aggregate KPI from existing data, 
    // mark as succeeded with a warning, otherwise mark as failed
    const finalStatus = matrixRunFailed && kpiRows.length === 0 ? 'failed' : 'succeeded'
    const finalError = finalStatus === 'failed' ? matrixRunError ?? 'Unknown error during sync' : undefined

    await upsertJobLog(client, {
      tenantId,
      status: finalStatus,
      startedAt,
      finishedAt,
      error: finalError,
    })

    if (finalStatus === 'succeeded') {
      logSyncEvent('sync_complete', {
        tenantId,
        accountId: preferredAccountId,
        rowsInserted: matrixResult.dailyRowCount,
        windowSince: matrixResult.windowSince,
        windowUntil: matrixResult.windowUntil,
        mode,
        matrixRunFailed,
        kpiRowsUpdated: kpiRows.length,
      })
    }

    return { 
      tenantId, 
      status: finalStatus, 
      inserted: matrixResult.dailyRowCount,
      error: finalError,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await upsertJobLog(client, {
      tenantId,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: message,
    })

    logSyncEvent('sync_failed', {
      tenantId,
      error: message,
      mode,
    })

    return { tenantId, status: 'failed', error: message }
  } finally {
    // Ensure job log is always updated, even if the try-catch above fails
    // This is a safety net in case the job log update in the catch block also fails
    if (jobLogInserted) {
      try {
        // Check if job log was already updated (has finished_at)
        const { data: existingJob } = await client
          .from('jobs_log')
          .select('finished_at')
          .eq('tenant_id', tenantId)
          .eq('source', SOURCE)
          .eq('status', 'running')
          .eq('started_at', startedAt)
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        // Only update if still in running status
        if (existingJob && !existingJob.finished_at) {
          await upsertJobLog(client, {
            tenantId,
            status: 'failed',
            startedAt,
            finishedAt: new Date().toISOString(),
            error: 'Job execution was interrupted or failed unexpectedly',
          })
        }
      } catch (finalError) {
        // Last resort - log but don't throw
        console.error(`Failed to update job log in finally block for tenant ${tenantId}:`, finalError)
      }
    }
  }
}

serve(async (req: Request) => {
  try {
    let payload: SyncRequestPayload = {}
    if (req.method === 'POST') {
      const rawBody = await req.text()
      if (rawBody.trim().length > 0) {
        try {
          payload = JSON.parse(rawBody) as SyncRequestPayload
        } catch (error) {
          console.warn('sync-meta: unable to parse request payload:', error)
          return new Response(JSON.stringify({ status: 'error', message: 'Invalid JSON payload.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }
      }
    }

    const explicitMode = payload.mode === 'backfill' || payload.mode === 'incremental' ? payload.mode : undefined
    const derivedMode =
      explicitMode ??
      (payload.since || payload.until ? 'backfill' : 'incremental')
    const mode: 'incremental' | 'backfill' = derivedMode
    const windowOverride =
      mode === 'backfill'
        ? {
            since: payload.since,
            until: payload.until,
          }
        : undefined

    const client = createSupabaseClient()
    let query = client
      .from('connections')
      .select('tenant_id, access_token_enc, refresh_token_enc, expires_at, meta')
      .eq('source', SOURCE)
      .eq('status', 'connected')

    if (payload.tenantId) {
      query = query.eq('tenant_id', payload.tenantId)
    }

    const { data, error } = await query

    if (error) {
      throw new Error(`Failed to list connections: ${error.message}`)
    }

    const connections = (data as MetaConnection[]) ?? []
    const results: JobResult[] = []

    for (const connection of connections) {
      results.push(
        await processTenant(client, connection, {
          mode,
          windowOverride,
          accountId: payload.accountId ?? null,
        }),
      )
    }

    return new Response(
      JSON.stringify({
        status: 'ok',
        processed: results.length,
        results,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('sync-meta invocation failed:', message)
    return new Response(JSON.stringify({ status: 'error', message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
