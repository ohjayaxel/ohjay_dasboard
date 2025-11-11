import { setTimeout as sleep } from 'timers/promises'

import { logger } from '@/lib/logger'

const META_API_VERSION = process.env.META_API_VERSION ?? 'v18.0'
const META_GRAPH_BASE = `https://graph.facebook.com/${META_API_VERSION}`

const RETRIABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 6
const BASE_DELAY_MS = 500

type FetchOptions = {
  accessToken: string
  method?: 'GET' | 'POST'
  body?: Record<string, unknown>
  signal?: AbortSignal
  logContext?: Record<string, unknown>
}

type InsightsJobParams = Record<string, string | number | boolean | string[] | Record<string, unknown>>

type StartInsightsJobArgs = {
  accountId: string
  params: InsightsJobParams
  accessToken: string
  logContext?: Record<string, unknown>
}

type PollJobArgs = {
  jobId: string
  accessToken: string
  pollIntervalMs?: number
  timeoutMs?: number
  logContext?: Record<string, unknown>
}

type PollJobResult = {
  files: string[]
  jobId: string
  raw: Record<string, unknown>
}

type FetchResultPageArgs = {
  url: string
  accessToken: string
  logContext?: Record<string, unknown>
}

type FetchResultPageResult = {
  data: any[]
  next?: string
  raw: Record<string, unknown>
}

type HealthOptions = {
  accessToken: string
  accountId: string
}

async function fetchWithRetry(
  url: string,
  { method = 'GET', body, accessToken, signal, logContext }: FetchOptions,
  attempt = 1,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  }

  let payload: string | undefined
  if (body) {
    payload = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: payload,
      signal,
    })

    const usageAccount = response.headers.get('x-ad-account-usage') ?? undefined
    const usageBusiness = response.headers.get('x-business-use-case-usage') ?? undefined
    const usageApp = response.headers.get('x-app-usage') ?? undefined
    const fbTraceId = response.headers.get('x-fb-trace-id') ?? undefined
    const rateLimitType = response.headers.get('x-ratelimit-type') ?? undefined

    logger.debug(
      {
        ...logContext,
        url,
        attempt,
        status: response.status,
        fb_trace_id: fbTraceId,
        ad_account_usage: usageAccount,
        business_use_case_usage: usageBusiness,
        app_usage: usageApp,
        rate_limit_type: rateLimitType,
      },
      'Meta Graph request completed',
    )

    if (response.ok) {
      return response
    }

    if (RETRIABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1)
      await sleep(delayMs)
      return fetchWithRetry(url, { method, body, accessToken, signal, logContext }, attempt + 1)
    }

    return response
  } catch (error) {
    if (attempt >= MAX_ATTEMPTS) {
      throw error
    }
    const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1)
    await sleep(delayMs)
    return fetchWithRetry(url, { method, body, accessToken, signal, logContext }, attempt + 1)
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
        : undefined) ?? (typeof parsed === 'string' ? (parsed as string) : undefined)
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

function ensureActPrefix(accountId: string): string {
  return accountId.startsWith('act_') ? accountId : `act_${accountId}`
}

function ensureJsonParams(params: InsightsJobParams): Record<string, string> {
  const output: Record<string, string> = {}

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      output[key] = String(value)
      continue
    }

    output[key] = JSON.stringify(value)
  }

  return output
}

function buildInsightsUrl(accountId: string): string {
  const prefix = ensureActPrefix(accountId)
  return `${META_GRAPH_BASE}/${prefix}/insights`
}

export async function startInsightsJob({
  accountId,
  params,
  accessToken,
  logContext,
}: StartInsightsJobArgs): Promise<{ jobId: string; resultUrl: string }> {
  const url = new URL(buildInsightsUrl(accountId))
  url.searchParams.set('async', '1')

  const queryParams = ensureJsonParams(params)
  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value)
  }

  const response = await fetchWithRetry(url.toString(), {
    method: 'POST',
    accessToken,
    logContext: { ...logContext, action: 'start_insights_job', accountId: ensureActPrefix(accountId) },
  })

  if (!response.ok) {
    throw await readErrorPayload(response)
  }

  const text = await response.text()
  let payload: Record<string, unknown>
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {}
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

  const defaultResultUrl = `${META_GRAPH_BASE}/${jobId}/insights`
  const resultUrl = typeof payload.result_url === 'string' ? payload.result_url : defaultResultUrl

  logger.info(
    {
      ...logContext,
      accountId: ensureActPrefix(accountId),
      jobId,
      action: 'start_insights_job',
      resultUrl,
    },
    'Meta async insights job started',
  )

  return { jobId, resultUrl }
}

export async function pollJob({
  jobId,
  accessToken,
  pollIntervalMs = 2000,
  timeoutMs = 15 * 60 * 1000,
  logContext,
}: PollJobArgs): Promise<PollJobResult> {
  const start = Date.now()
  const pollUrl = `${META_GRAPH_BASE}/${jobId}`

  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Meta async job ${jobId} timed out after ${timeoutMs}ms`)
    }

    const response = await fetchWithRetry(pollUrl, {
      method: 'GET',
      accessToken,
      logContext: { ...logContext, action: 'poll_insights_job', jobId },
    })

    if (!response.ok) {
      throw await readErrorPayload(response)
    }

    const text = await response.text()
    let payload: Record<string, unknown>
    try {
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      throw new Error(`Failed to parse Meta async poll response: ${text}`)
    }

    const status = typeof payload.async_status === 'string' ? payload.async_status : undefined
    const percent =
      typeof payload.async_percent_completion === 'number'
        ? payload.async_percent_completion
        : undefined

    logger.info(
      { ...logContext, jobId, status, percent, action: 'poll_insights_job' },
      'Meta async job status',
    )

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
        resultUrls.push(`${META_GRAPH_BASE}/${jobId}/insights`)
      }

      return {
        jobId,
        files: Array.from(new Set(resultUrls)),
        raw: payload,
      }
    }

    if (status && status.toLowerCase().includes('failed')) {
      throw new Error(`Meta async job ${jobId} failed with status ${status}`)
    }

    await sleep(pollIntervalMs)
  }
}

export async function fetchResultPage({
  url,
  accessToken,
  logContext,
}: FetchResultPageArgs): Promise<FetchResultPageResult> {
  const response = await fetchWithRetry(url, {
    method: 'GET',
    accessToken,
    logContext: { ...logContext, action: 'fetch_insights_page' },
  })

  if (!response.ok) {
    throw await readErrorPayload(response)
  }

  const text = await response.text()
  let payload: Record<string, unknown>
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    throw new Error(`Failed to parse Meta insights page response: ${text}`)
  }

  const data = Array.isArray(payload.data) ? (payload.data as any[]) : []
  const next =
    payload.paging && typeof (payload.paging as Record<string, unknown>).next === 'string'
      ? ((payload.paging as Record<string, unknown>).next as string)
      : undefined

  return {
    data,
    next,
    raw: payload,
  }
}

export async function health({ accessToken, accountId }: HealthOptions): Promise<boolean> {
  try {
    const since = new Date()
    since.setDate(since.getDate() - 2)
    const until = new Date()
    const params = {
      fields: 'account_id,date_start,impressions,spend',
      level: 'account',
      time_range: { since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) },
      time_increment: 1,
      limit: 10,
    }

    await startInsightsJob({
      accountId,
      params,
      accessToken,
      logContext: { health_check: true },
    })
    return true
  } catch (error) {
    logger.error({ accountId: ensureActPrefix(accountId), error }, 'Meta insights health failed')
    return false
  }
}


