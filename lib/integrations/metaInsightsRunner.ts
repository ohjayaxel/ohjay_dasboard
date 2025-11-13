import { createHash } from 'crypto'
import { setTimeout as sleep } from 'timers/promises'

import { logger } from '@/lib/logger'
import { fetchResultPage, pollJob, startInsightsJob } from '@/lib/integrations/metaClient'

export const LEVELS = ['account', 'campaign', 'adset', 'ad'] as const
export type InsightLevel = (typeof LEVELS)[number]

export const ACTION_REPORT_TIMES = ['impression', 'conversion'] as const
export type ActionReportTime = (typeof ACTION_REPORT_TIMES)[number]

export const ATTR_WINDOWS = ['1d_click', '7d_click', '1d_view'] as const
export type AttributionWindow = (typeof ATTR_WINDOWS)[number]

export const BREAKDOWN_SETS: Record<string, string> = {
  none: '',
  A: 'publisher_platform,platform_position',
  B: 'age,gender',
  C: 'country',
  D: 'device_platform',
  country_priority: 'country',
}

const COUNTRY_PRIORITY_CODES = new Set(['DE', 'SE', 'NO', 'FI'])

export type RunnerConfigurationInput = Partial<{
  levels: InsightLevel[]
  breakdownKeys: string[]
  actionReportTimes: ActionReportTime[]
  attributionWindows: AttributionWindow[]
}>

export type RunnerConfiguration = {
  levels: InsightLevel[]
  breakdownKeys: string[]
  actionReportTimes: ActionReportTime[]
  attributionWindows: AttributionWindow[]
}

const DEFAULT_RUNNER_CONFIGURATION: RunnerConfiguration = {
  levels: [...LEVELS],
  breakdownKeys: Object.keys(BREAKDOWN_SETS),
  actionReportTimes: [...ACTION_REPORT_TIMES],
  attributionWindows: [...ATTR_WINDOWS],
}

const VALID_LEVELS = new Set<InsightLevel>(LEVELS)
const VALID_BREAKDOWN_KEYS = new Set(Object.keys(BREAKDOWN_SETS))
const VALID_ACTION_TIMES = new Set<ActionReportTime>(ACTION_REPORT_TIMES)
const VALID_ATTR_WINDOWS = new Set<AttributionWindow>(ATTR_WINDOWS)

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}

function filterWithFallback<T>(
  requested: readonly T[] | undefined,
  validator: (value: T) => boolean,
  fallback: readonly T[],
): T[] {
  if (!requested || requested.length === 0) {
    return [...fallback]
  }
  const filtered = requested.filter(validator)
  return filtered.length > 0 ? unique(filtered) : [...fallback]
}

export function resolveRunnerConfiguration(overrides?: RunnerConfigurationInput): RunnerConfiguration {
  if (!overrides) {
    return { ...DEFAULT_RUNNER_CONFIGURATION }
  }

  const levels = filterWithFallback(overrides.levels, (value): value is InsightLevel => VALID_LEVELS.has(value), LEVELS)
  const breakdownKeys = filterWithFallback(
    overrides.breakdownKeys,
    (value): value is string => VALID_BREAKDOWN_KEYS.has(value),
    Object.keys(BREAKDOWN_SETS),
  )
  const actionReportTimes = filterWithFallback(
    overrides.actionReportTimes,
    (value): value is ActionReportTime => VALID_ACTION_TIMES.has(value),
    ACTION_REPORT_TIMES,
  )
  const attributionWindows = filterWithFallback(
    overrides.attributionWindows,
    (value): value is AttributionWindow => VALID_ATTR_WINDOWS.has(value),
    ATTR_WINDOWS,
  )

  return {
    levels,
    breakdownKeys,
    actionReportTimes,
    attributionWindows,
  }
}

export type MatrixCombination = {
  level: InsightLevel
  breakdownKey: string
  breakdowns: string
  actionReportTime: ActionReportTime
  attributionWindow: AttributionWindow
}

export function buildMatrixCombinations(config?: RunnerConfigurationInput): MatrixCombination[] {
  const resolved = resolveRunnerConfiguration(config)
  const combinations: MatrixCombination[] = []

  for (const level of resolved.levels) {
    for (const breakdownKey of resolved.breakdownKeys) {
      const breakdowns = BREAKDOWN_SETS[breakdownKey] ?? ''
      for (const actionReportTime of resolved.actionReportTimes) {
        for (const attributionWindow of resolved.attributionWindows) {
          combinations.push({
            level,
            breakdownKey,
            breakdowns,
            actionReportTime,
            attributionWindow,
          })
        }
      }
    }
  }

  return combinations
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
  'purchase_roas',
  'cost_per_action_type',
  'frequency',
  'account_currency',
]

const MAX_CHUNK_ATTEMPTS = 3
const CHUNK_RETRY_BASE_DELAY_MS = 2000

export type UpsertDailyContext = {
  tenantId: string
  accountId: string
  level: InsightLevel
  actionReportTime: ActionReportTime
  attributionWindow: AttributionWindow
  breakdownsKey: string
  breakdownKeys: string[]
}

export interface MetaInsightsStorageAdapter {
  upsertDaily(rows: NormalizedInsightRow[], context: UpsertDailyContext): Promise<void>
}

type BuildParamsInput = {
  level: InsightLevel
  since: string
  until: string
  breakdowns?: string
  actionReportTime: ActionReportTime
  attributionWindow: AttributionWindow
}

export function buildParams({
  level,
  since,
  until,
  breakdowns,
  actionReportTime,
  attributionWindow,
}: BuildParamsInput) {
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

export function hashBreakdowns(breakdowns: Record<string, string | null | undefined>): string {
  const normalizedEntries = Object.entries(breakdowns)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, value ?? null])
    .sort(([a], [b]) => a.localeCompare(b))

  const hash = createHash('sha1')
  hash.update(JSON.stringify(normalizedEntries))
  return hash.digest('hex')
}

function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null
  }
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function parseArray(item: unknown): any[] | null {
  if (Array.isArray(item)) {
    return item
  }
  return null
}

function extractActionCount(actions: any[] | null, predicate: (actionType: string) => boolean): number | null {
  if (!Array.isArray(actions)) {
    return null
  }
  for (const entry of actions) {
    const actionType = typeof entry?.action_type === 'string' ? entry.action_type : ''
    if (!predicate(actionType)) {
      continue
    }
    const value = entry?.value ?? entry?.count ?? entry?.['1']
    const parsed = parseNumber(value)
    if (parsed !== null) {
      return parsed
    }
  }
  return null
}

function extractActionValue(actions: any[] | null, predicate: (actionType: string) => boolean): number | null {
  if (!Array.isArray(actions)) {
    return null
  }
  for (const entry of actions) {
    const actionType = typeof entry?.action_type === 'string' ? entry.action_type : ''
    if (!predicate(actionType)) {
      continue
    }
    const value = parseNumber(entry?.value)
    if (value !== null) {
      return value
    }
  }
  return null
}

export type NormalizedInsightRow = {
  dateStart: string
  dateStop: string
  accountId: string | null
  campaignId: string | null
  campaignName: string | null
  adsetId: string | null
  adsetName: string | null
  adId: string | null
  adName: string | null
  entityId: string
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

function deriveEntityId(level: InsightLevel, row: Record<string, unknown>): string | null {
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

export function normalizeRow(
  row: Record<string, unknown>,
  {
    level,
    breakdownKeys,
    breakdownsKey,
  }: {
    level: InsightLevel
    breakdownKeys: string[]
    breakdownsKey: string
  },
): NormalizedInsightRow | null {
  const dateStart =
    typeof row.date_start === 'string' ? row.date_start : new Date().toISOString().slice(0, 10)
  const dateStop =
    typeof row.date_stop === 'string' ? row.date_stop : new Date().toISOString().slice(0, 10)

  const accountId = typeof row.account_id === 'string' ? row.account_id : null
  const campaignId = typeof row.campaign_id === 'string' ? row.campaign_id : null
  const campaignName = typeof row.campaign_name === 'string' ? row.campaign_name : null
  const campaignEffectiveStatus =
    typeof row.campaign_effective_status === 'string' ? row.campaign_effective_status : null
  const campaignConfiguredStatus =
    typeof row.campaign_status === 'string' ? row.campaign_status : null
  const adsetId = typeof row.adset_id === 'string' ? row.adset_id : null
  const adsetName = typeof row.adset_name === 'string' ? row.adset_name : null
  const adId = typeof row.ad_id === 'string' ? row.ad_id : null
  const adName = typeof row.ad_name === 'string' ? row.ad_name : null
  const buyingType = typeof row.buying_type === 'string' ? row.buying_type : null
  const objective = typeof row.objective === 'string' ? row.objective : null
  const dailyBudget = parseNumber(row.daily_budget)
  const lifetimeBudget = parseNumber(row.lifetime_budget)

  const entityId = deriveEntityId(level, row)
  if (!entityId) {
    return null
  }

  const breakdowns: Record<string, string | null> = {}
  for (const key of breakdownKeys) {
    let value: string | null
    if (typeof row[key] === 'string') {
      value = row[key] as string
    } else if (row[key] === null || row[key] === undefined) {
      value = null
    } else {
      value = String(row[key])
    }

    if (breakdownsKey === 'country_priority' && key === 'country') {
      if (!value) {
        value = null
      } else {
        const upper = value.toUpperCase()
        value = COUNTRY_PRIORITY_CODES.has(upper) ? upper : 'OTHER'
      }
    }

    breakdowns[key] = value
  }

  return {
    dateStart,
    dateStop,
    accountId,
    campaignId,
    campaignName,
    adsetId,
    adsetName,
    adId,
    adName,
    entityId,
    currency: typeof row.account_currency === 'string' ? row.account_currency : null,
    spend: parseNumber(row.spend),
    impressions: parseNumber(row.impressions),
    reach: parseNumber(row.reach),
    clicks: parseNumber(row.clicks),
    uniqueClicks: parseNumber(row.unique_clicks),
    inlineLinkClicks: parseNumber(row.inline_link_clicks),
    conversions: parseNumber(row.conversions),
    purchases: extractActionCount(parseArray(row.actions), (type) =>
      type.toLowerCase().includes('purchase'),
    ),
    addToCart: extractActionCount(parseArray(row.actions), (type) =>
      type.toLowerCase().includes('add_to_cart'),
    ),
    leads: extractActionCount(parseArray(row.actions), (type) =>
      type.toLowerCase().includes('lead'),
    ),
    revenue: extractActionValue(parseArray(row.action_values), (type) =>
      type.toLowerCase().includes('purchase'),
    ),
    purchaseRoas: parseArray(row.purchase_roas),
    costPerActionType: parseArray(row.cost_per_action_type),
    cpm: parseNumber(row.cpm),
    cpc: parseNumber(row.cpc),
    ctr: parseNumber(row.ctr),
    frequency: parseNumber(row.frequency),
    objective,
    effectiveStatus: campaignEffectiveStatus,
    configuredStatus: campaignConfiguredStatus,
    buyingType,
    dailyBudget,
    lifetimeBudget,
    actions: parseArray(row.actions) ?? null,
    actionValues: parseArray(row.action_values) ?? null,
    breakdowns,
  }
}

type RunMonthlyChunkArgs = {
  tenantId: string
  accountId: string
  accessToken: string
  storage: MetaInsightsStorageAdapter
  level: InsightLevel
  breakdownKey: string
  breakdowns: string
  since: string
  until: string
  actionReportTime: ActionReportTime
  attributionWindow: AttributionWindow
}

function isTransientJobError(error: unknown): boolean {
  if (!error || !(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()

  return (
    message.includes('unsupported get request') ||
    message.includes('temporarily unavailable') ||
    message.includes('not completed yet') ||
    message.includes('job timed out') ||
    message.includes('internal error')
  )
}

export async function runMonthlyChunk({
  tenantId,
  accountId,
  accessToken,
  storage,
  level,
  breakdownKey,
  breakdowns,
  since,
  until,
  actionReportTime,
  attributionWindow,
}: RunMonthlyChunkArgs): Promise<void> {
  const params = buildParams({
    level,
    since,
    until,
    breakdowns,
    actionReportTime,
    attributionWindow,
  })

  const baseContext = {
    tenantId,
    accountId,
    level,
    breakdownKey,
    since,
    until,
    actionReportTime,
    attributionWindow,
  }

  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
    const attemptContext = attempt === 1 ? baseContext : { ...baseContext, attempt }

    try {
      const { jobId, resultUrl } = await startInsightsJob({
        accountId,
        params,
        accessToken,
        logContext: attemptContext,
      })

      const { files } = await pollJob({
        jobId,
        accessToken,
        logContext: attemptContext,
      })

      const breakdownNames = breakdowns ? breakdowns.split(',').filter(Boolean) : []

      const rowsToPersist: NormalizedInsightRow[] = []

      for (const fileUrl of files.length > 0 ? files : [resultUrl]) {
        let nextUrl: string | undefined = fileUrl

        while (nextUrl) {
          const page = await fetchResultPage({
            url: nextUrl,
            accessToken,
            logContext: attemptContext,
          })

          for (const rawRow of page.data) {
            if (!rawRow || typeof rawRow !== 'object') {
              continue
            }
            const normalized = normalizeRow(rawRow as Record<string, unknown>, {
              level,
              breakdownKeys: breakdownNames,
              breakdownsKey: breakdownKey,
            })
            if (!normalized) {
              continue
            }
            rowsToPersist.push(normalized)
          }

          nextUrl = page.next
        }
      }

      if (rowsToPersist.length === 0) {
        logger.info({ ...attemptContext, rows: 0 }, 'Meta monthly chunk produced no rows')
        return
      }

      await storage.upsertDaily(rowsToPersist, {
        tenantId,
        accountId,
        level,
        actionReportTime,
        attributionWindow,
        breakdownsKey: breakdownKey,
        breakdownKeys: breakdownNames,
      })

      return
    } catch (error) {
      if (isTransientJobError(error) && attempt < MAX_CHUNK_ATTEMPTS) {
        const delayMs = CHUNK_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
        logger.warn(
          {
            ...attemptContext,
            attempt,
            maxAttempts: MAX_CHUNK_ATTEMPTS,
            delay_ms: delayMs,
            error_message: error instanceof Error ? error.message : String(error),
          },
          'Meta monthly chunk transient error, retrying',
        )
        await sleep(delayMs)
        continue
      }

      logger.error(
        {
          ...attemptContext,
          attempt,
          maxAttempts: MAX_CHUNK_ATTEMPTS,
          error_message: error instanceof Error ? error.message : String(error),
        },
        'Meta monthly chunk failed',
      )

      throw error
    }
  }
}

type RunFullMatrixArgs = {
  tenantId: string
  accountId: string
  accessToken: string
  storage: MetaInsightsStorageAdapter
  since: string
  until: string
  config?: RunnerConfigurationInput
}

export async function runFullMatrix({
  tenantId,
  accountId,
  accessToken,
  storage,
  since,
  until,
  config,
}: RunFullMatrixArgs): Promise<void> {
  const months = enumerateMonths(since, until)
  const combinations = buildMatrixCombinations(config)

  for (const combo of combinations) {
    for (const { monthSince, monthUntil } of months) {
      try {
        await runMonthlyChunk({
          tenantId,
          accountId,
          accessToken,
          storage,
          level: combo.level,
          breakdownKey: combo.breakdownKey,
          breakdowns: combo.breakdowns,
          since: monthSince,
          until: monthUntil,
          actionReportTime: combo.actionReportTime,
          attributionWindow: combo.attributionWindow,
        })
      } catch (error) {
        logger.error(
          {
            tenantId,
            accountId,
            level: combo.level,
            breakdownKey: combo.breakdownKey,
            breakdowns: combo.breakdowns,
            since: monthSince,
            until: monthUntil,
            actionReportTime: combo.actionReportTime,
            attributionWindow: combo.attributionWindow,
            error,
          },
          'Meta insights monthly chunk failed',
        )
        throw error
      }
    }
  }
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

    const monthSince = monthStart.toISOString().slice(0, 10)
    const monthUntil = monthEnd > end ? end.toISOString().slice(0, 10) : monthEnd.toISOString().slice(0, 10)

    results.push({ monthSince, monthUntil })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }

  return results
}


