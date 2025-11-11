import { createHash } from 'crypto'

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
  }: {
    level: InsightLevel
    breakdownKeys: string[]
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
    breakdowns[key] =
      typeof row[key] === 'string'
        ? (row[key] as string)
        : row[key] === null || row[key] === undefined
          ? null
          : String(row[key])
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

  const { jobId, resultUrl } = await startInsightsJob({
    accountId,
    params,
    accessToken,
    logContext: {
      tenantId,
      level,
      breakdownKey,
      since,
      until,
      actionReportTime,
      attributionWindow,
    },
  })

  const { files } = await pollJob({
    jobId,
    accessToken,
    logContext: {
      tenantId,
      level,
      breakdownKey,
      since,
      until,
      actionReportTime,
      attributionWindow,
    },
  })

  const breakdownNames = breakdowns ? breakdowns.split(',').filter(Boolean) : []

  const rowsToPersist: NormalizedInsightRow[] = []

  for (const fileUrl of files.length > 0 ? files : [resultUrl]) {
    let nextUrl: string | undefined = fileUrl

    while (nextUrl) {
      const page = await fetchResultPage({
        url: nextUrl,
        accessToken,
        logContext: {
          tenantId,
          level,
          breakdownKey,
          since,
          until,
          actionReportTime,
          attributionWindow,
        },
      })

      for (const rawRow of page.data) {
        if (!rawRow || typeof rawRow !== 'object') {
          continue
        }
        const normalized = normalizeRow(rawRow as Record<string, unknown>, {
          level,
          breakdownKeys: breakdownNames,
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
    logger.info(
      {
        tenantId,
        accountId,
        level,
        breakdownKey,
        since,
        until,
        actionReportTime,
        attributionWindow,
        rows: 0,
      },
      'Meta monthly chunk produced no rows',
    )
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
}

type RunFullMatrixArgs = {
  tenantId: string
  accountId: string
  accessToken: string
  storage: MetaInsightsStorageAdapter
  since: string
  until: string
}

export async function runFullMatrix({
  tenantId,
  accountId,
  accessToken,
  storage,
  since,
  until,
}: RunFullMatrixArgs): Promise<void> {
  const months = enumerateMonths(since, until)

  for (const level of LEVELS) {
    for (const [breakdownKey, breakdowns] of Object.entries(BREAKDOWN_SETS)) {
      for (const actionReportTime of ACTION_REPORT_TIMES) {
        for (const attributionWindow of ATTR_WINDOWS) {
          for (const { monthSince, monthUntil } of months) {
            try {
              await runMonthlyChunk({
                tenantId,
                accountId,
                accessToken,
                storage,
                level,
                breakdownKey,
                breakdowns,
                since: monthSince,
                until: monthUntil,
                actionReportTime,
                attributionWindow,
              })
            } catch (error) {
              logger.error(
                {
                  tenantId,
                  accountId,
                  level,
                  breakdownKey,
                  breakdowns,
                  since: monthSince,
                  until: monthUntil,
                  actionReportTime,
                  attributionWindow,
                  error,
                },
                'Meta insights monthly chunk failed',
              )
              throw error
            }
          }
        }
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


