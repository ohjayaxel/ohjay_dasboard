#!/usr/bin/env -S tsx

/**
 * Meta backfill CLI
 *
 * Usage:
 *   pnpm tsx scripts/meta_backfill.ts \
 *     --tenant fa6a78a8-557b-4687-874d-261236d78ac1 \
 *     --account act_291334701 \
 *     --since 2025-10-01 \
 *     --until 2025-10-31
 *
 * Options:
 *   --tenant <uuid>          (obligatorisk)
 *   --account <act_...>      (obligatorisk)
 *   --since <YYYY-MM-DD>     (obligatorisk)
 *   --until <YYYY-MM-DD>     (obligatorisk)
 *   --chunk-size <months>    (standard 1) antal kalendermånader per chunk
 *   --concurrency <n>        (standard 2) antal chunk-jobb parallellt
 */

import { ArgumentParser } from 'argparse'

import { createClient } from '@supabase/supabase-js'

import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { decryptSecret, getEncryptionKeyFingerprint } from '@/lib/integrations/crypto'
import {
  runMonthlyChunk,
  LEVELS,
  ACTION_REPORT_TIMES,
  ATTR_WINDOWS,
  BREAKDOWN_SETS,
  hashBreakdowns,
  buildMatrixCombinations,
  resolveRunnerConfiguration,
} from '@/lib/integrations/metaInsightsRunner'
import type { RunnerConfigurationInput } from '@/lib/integrations/metaInsightsRunner'
import type {
  InsightLevel,
  ActionReportTime,
  AttributionWindow,
  MetaInsightsStorageAdapter,
  NormalizedInsightRow,
  UpsertDailyContext,
} from '@/lib/integrations/metaInsightsRunner'
import { logger } from '@/lib/logger'

type ChunkConfig = {
  monthSince: string
  monthUntil: string
}

type RunContext = {
  tenantId: string
  accountId: string
  accessToken: string
  supabase: ReturnType<typeof getSupabaseServiceClient>
  storage: MetaInsightsStorageAdapter
}

type ParsedArgs = {
  tenant: string
  account: string
  since: string
  until: string
  chunkSize: number
  concurrency: number
  preset: string
  levels?: string[]
  breakdowns?: string[]
  actionTimes?: string[]
  attributionWindows?: string[]
}

const UPSERT_BATCH_SIZE = 500
const CANONICAL_ACTION_REPORT_TIME: ActionReportTime = 'impression'
const CANONICAL_ATTR_WINDOW: AttributionWindow = '7d_click'
const AVG_SECONDS_PER_JOB = 45

const RUNNER_PRESETS: Record<string, RunnerConfigurationInput> = {
  full: {},
  'account-country-lite': {
    levels: ['account'],
    breakdownKeys: ['country_priority'],
    actionReportTimes: ['conversion'],
    attributionWindows: ['1d_click'],
  },
}

function filterInsightLevels(values?: string[]): InsightLevel[] | undefined {
  if (!values) return undefined
  const valid = values.filter((value): value is InsightLevel => (LEVELS as readonly string[]).includes(value))
  return valid.length > 0 ? Array.from(new Set(valid)) : undefined
}

function filterBreakdownKeys(values?: string[]): string[] | undefined {
  if (!values) return undefined
  const valid = values.filter((value) => Object.prototype.hasOwnProperty.call(BREAKDOWN_SETS, value))
  return valid.length > 0 ? Array.from(new Set(valid)) : undefined
}

function filterActionTimes(values?: string[]): ActionReportTime[] | undefined {
  if (!values) return undefined
  const valid = values.filter((value): value is ActionReportTime =>
    (ACTION_REPORT_TIMES as readonly string[]).includes(value),
  )
  return valid.length > 0 ? Array.from(new Set(valid)) : undefined
}

function filterAttrWindows(values?: string[]): AttributionWindow[] | undefined {
  if (!values) return undefined
  const valid = values.filter((value): value is AttributionWindow => (ATTR_WINDOWS as readonly string[]).includes(value))
  return valid.length > 0 ? Array.from(new Set(valid)) : undefined
}

async function detectSchemaMode(
  supabase: ReturnType<typeof getSupabaseServiceClient>,
): Promise<'extended' | 'legacy'> {
  const probe = await supabase.from('meta_insights_daily').select('action_report_time').limit(1)
  if (probe.error) {
    const message = probe.error.message ?? ''
    if (message.includes('action_report_time') || message.includes('schema cache') || probe.error.code === 'PGRST204') {
      return 'legacy'
    }
  }
  return 'extended'
}

class AdaptiveMetaInsightsStorage implements MetaInsightsStorageAdapter {
  private fallbackMode: 'unknown' | 'extended' | 'legacy'

  constructor(
    private readonly supabase = getSupabaseServiceClient(),
    initialMode: 'extended' | 'legacy' = 'extended',
  ) {
    this.fallbackMode = initialMode === 'legacy' ? 'legacy' : 'unknown'
  }

  private async upsertExtended(rows: ReturnType<typeof toExtendedRow>[]) {
    for (let cursor = 0; cursor < rows.length; cursor += UPSERT_BATCH_SIZE) {
      const batch = rows.slice(cursor, cursor + UPSERT_BATCH_SIZE)
      const { error } = await this.supabase
        .from('meta_insights_daily')
        .upsert(batch, {
          onConflict: 'tenant_id,date,level,entity_id,action_report_time,attribution_window,breakdowns_hash',
        })
      if (error) {
        throw error
      }
    }
  }

  private async upsertLegacy(rows: NormalizedInsightRow[], context: UpsertDailyContext) {
    const payload = rows.map((row) => ({
      tenant_id: context.tenantId,
      date: row.dateStart,
      ad_account_id: context.accountId,
      campaign_id:
        row.campaignId ??
        (context.level === 'account'
          ? '__account__'
          : context.level === 'adset' || context.level === 'ad'
            ? row.campaignId ?? '__adset_parent__'
            : '__campaign__'),
      adset_id:
        row.adsetId ??
        (context.level === 'account'
          ? '__account__'
          : context.level === 'campaign'
            ? '__campaign__'
            : context.level === 'ad'
              ? row.adsetId ?? '__ad_parent__'
              : '__adset__'),
      ad_id:
        row.adId ??
        (context.level === 'account'
          ? '__account__'
          : context.level === 'campaign'
            ? '__campaign__'
            : context.level === 'adset'
              ? '__adset__'
              : '__ad__'),
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      purchases: row.purchases,
      revenue: row.revenue,
    }))

    for (let cursor = 0; cursor < payload.length; cursor += UPSERT_BATCH_SIZE) {
      const batch = payload.slice(cursor, cursor + UPSERT_BATCH_SIZE)
      const { error } = await this.supabase.from('meta_insights_daily').upsert(batch, {
        onConflict: 'tenant_id,date,ad_account_id,campaign_id,adset_id,ad_id',
      })
      if (error) {
        throw error
      }
    }
  }

  async upsertDaily(rows: NormalizedInsightRow[], context: UpsertDailyContext): Promise<void> {
    if (rows.length === 0) {
      return
    }

    if (this.fallbackMode === 'legacy') {
      await this.upsertLegacy(rows, context)
      return
    }

    const extendedRows = rows.map((row) => toExtendedRow(row, context))

    try {
      await this.upsertExtended(extendedRows)
      this.fallbackMode = 'extended'
    } catch (error) {
      let message: string
      if (error instanceof Error) {
        message = error.message
      } else if (error && typeof error === 'object' && 'message' in error && typeof (error as any).message === 'string') {
        message = (error as any).message
      } else {
        message = String(error)
      }
      if (
        message.includes("column 'action_report_time'") ||
        message.includes("column \"action_report_time\"") ||
        message.includes("column 'account_id'") ||
        message.includes('schema cache')
      ) {
        logger.warn({ message }, 'Falling back to legacy meta_insights_daily schema')
        this.fallbackMode = 'legacy'
        await this.upsertLegacy(rows, context)
        return
      }
      throw error
    }
  }
}

function toExtendedRow(row: NormalizedInsightRow, context: UpsertDailyContext) {
  const breakdownsHash = hashBreakdowns(row.breakdowns)

  return {
    tenant_id: context.tenantId,
    ad_account_id: context.accountId,
    campaign_id: row.campaignId,
    campaign_name: row.campaignName,
    adset_id: row.adsetId,
    adset_name: row.adsetName,
    ad_id: row.adId,
    ad_name: row.adName,
    entity_id: row.entityId,
    date: row.dateStart,
    date_stop: row.dateStop,
    level: context.level,
    action_report_time: context.actionReportTime,
    attribution_window: context.attributionWindow,
    breakdowns_key: context.breakdownsKey || null,
    breakdowns_hash: breakdownsHash,
    breakdowns: row.breakdowns,
    actions: row.actions,
    action_values: row.actionValues,
    spend: row.spend,
    impressions: row.impressions,
    reach: row.reach,
    clicks: row.clicks,
    unique_clicks: row.uniqueClicks,
    inline_link_clicks: row.inlineLinkClicks,
    conversions: row.conversions,
    purchases: row.purchases,
    add_to_cart: row.addToCart,
    leads: row.leads,
    revenue: row.revenue,
    purchase_roas: row.purchaseRoas,
    cost_per_action_type: row.costPerActionType,
    cpm: row.cpm,
    cpc: row.cpc,
    ctr: row.ctr,
    frequency: row.frequency,
    objective: row.objective,
    effective_status: row.effectiveStatus,
    configured_status: row.configuredStatus,
    buying_type: row.buyingType,
    daily_budget: row.dailyBudget,
    lifetime_budget: row.lifetimeBudget,
    currency: row.currency,
  }
}

function parseArgs(): ParsedArgs {
  const parser = new ArgumentParser({
    description: 'Meta backfill CLI',
  })

  parser.add_argument('--tenant', { required: true, help: 'Tenant ID (UUID)' })
  parser.add_argument('--account', { required: true, help: 'Meta ad account id, e.g. act_123' })
  parser.add_argument('--since', { required: true, help: 'Start date (YYYY-MM-DD)' })
  parser.add_argument('--until', { required: true, help: 'End date (YYYY-MM-DD)' })
  parser.add_argument('--chunk-size', {
    dest: 'chunkSize',
    default: 1,
    type: 'int',
    help: 'Number of months per chunk (default 1)',
  })
  parser.add_argument('--concurrency', {
    default: 2,
    type: 'int',
    help: 'Number of concurrent chunk runners (default 2)',
  })
  parser.add_argument('--preset', {
    choices: Object.keys(RUNNER_PRESETS),
    default: 'full',
    help: 'Predefined parameter profile (default full)',
  })
  parser.add_argument('--levels', {
    help: 'Comma-separated levels (account,campaign,adset,ad)',
  })
  parser.add_argument('--breakdowns', {
    help: 'Comma-separated breakdown keys (none,A,B,C,D,country_priority)',
  })
  parser.add_argument('--action-times', {
    help: 'Comma-separated action report times (impression,conversion)',
  })
  parser.add_argument('--attr-windows', {
    help: 'Comma-separated attribution windows (1d_click,7d_click,1d_view)',
  })

  const args = parser.parse_args()

  const parseCsv = (value?: string | null): string[] | undefined =>
    typeof value === 'string' && value.trim().length > 0
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : undefined

  return {
    tenant: args.tenant as string,
    account: args.account as string,
    since: args.since as string,
    until: args.until as string,
    chunkSize: Math.max(1, (args.chunkSize as number | undefined) ?? 1),
    concurrency: Math.max(1, (args.concurrency as number | undefined) ?? 2),
    preset: (args.preset as string) ?? 'full',
    levels: parseCsv(args.levels as string | undefined),
    breakdowns: parseCsv(args.breakdowns as string | undefined),
    actionTimes: parseCsv(args.action_times as string | undefined),
    attributionWindows: parseCsv(args.attr_windows as string | undefined),
  }
}

function clampDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function parseIso(value: string): Date {
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`)
  }
  return clampDate(parsed)
}

function enumerateChunks(since: string, until: string, chunkSize: number): ChunkConfig[] {
  const start = parseIso(since)
  const end = parseIso(until)

  if (end < start) {
    throw new Error('until must be on or after since')
  }

  const chunks: ChunkConfig[] = []
  const cursor = new Date(start)

  while (cursor <= end) {
    const chunkStart = new Date(cursor)
    const chunkEnd = new Date(cursor)
    chunkEnd.setUTCMonth(chunkEnd.getUTCMonth() + chunkSize)
    chunkEnd.setUTCDate(0)

    const monthSince = chunkStart.toISOString().slice(0, 10)
    const monthUntil = (chunkEnd > end ? end : chunkEnd).toISOString().slice(0, 10)

    chunks.push({ monthSince, monthUntil })
    cursor.setUTCMonth(cursor.getUTCMonth() + chunkSize)
  }

  return chunks
}

async function runChunk(
  ctx: RunContext,
  chunk: ChunkConfig,
  level: InsightLevel,
  breakdownKey: string,
  breakdowns: string,
  actionReportTime: ActionReportTime,
  attributionWindow: AttributionWindow,
): Promise<void> {
  const breakdownKeys = breakdowns ? breakdowns.split(',').filter(Boolean) : []

  logger.info(
    {
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      level,
      breakdownKey,
      breakdowns,
      actionReportTime,
      attributionWindow,
      since: chunk.monthSince,
      until: chunk.monthUntil,
    },
    'Backfill chunk start',
  )

  await runMonthlyChunk({
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    accessToken: ctx.accessToken,
    storage: ctx.storage,
    level,
    breakdownKey,
    breakdowns,
    since: chunk.monthSince,
    until: chunk.monthUntil,
    actionReportTime,
    attributionWindow,
  })

  logger.info(
    {
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      level,
      breakdownKey,
      actionReportTime,
      attributionWindow,
      since: chunk.monthSince,
      until: chunk.monthUntil,
    },
    'Backfill chunk completed',
  )
}

async function runWithConcurrency<T>(items: T[], limit: number, handler: (item: T) => Promise<void>): Promise<void> {
  const executing: Promise<void>[] = []

  for (const item of items) {
    const promise = handler(item).finally(() => {
      const idx = executing.indexOf(promise)
      if (idx >= 0) {
        executing.splice(idx, 1)
      }
    })
    executing.push(promise)
    if (executing.length >= limit) {
      await Promise.race(executing)
    }
  }

  await Promise.all(executing)
}

async function resolveAccessToken(tenantId: string): Promise<string> {
  const supabaseAdmin = getSupabaseServiceClient()
  const { data, error } = await supabaseAdmin
    .from('connections')
    .select('access_token_enc')
    .eq('tenant_id', tenantId)
    .eq('source', 'meta')
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to fetch Meta connection: ${error.message}`)
  }

  const encrypted = data?.access_token_enc ?? null
  const decrypted = decryptSecret(encrypted as Buffer | string | null)
  if (!decrypted) {
    throw new Error('No access token stored for tenant')
  }

  return decrypted
}

async function main() {
  const args = parseArgs()

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing Supabase credentials (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
  }

  const storageClient = getSupabaseServiceClient()
  const schemaMode = await detectSchemaMode(storageClient)

  const presetConfig = RUNNER_PRESETS[args.preset] ?? RUNNER_PRESETS.full
  const overrideLevels = filterInsightLevels(args.levels) ?? presetConfig.levels
  const overrideBreakdowns = filterBreakdownKeys(args.breakdowns) ?? presetConfig.breakdownKeys
  const overrideActionTimes = filterActionTimes(args.actionTimes) ?? presetConfig.actionReportTimes
  const overrideAttrWindows =
    filterAttrWindows(args.attributionWindows) ?? presetConfig.attributionWindows

  const overrides: RunnerConfigurationInput = {}
  if (overrideLevels) {
    overrides.levels = overrideLevels
  }
  if (overrideBreakdowns) {
    overrides.breakdownKeys = overrideBreakdowns
  }
  if (overrideActionTimes) {
    overrides.actionReportTimes = overrideActionTimes
  }
  if (overrideAttrWindows) {
    overrides.attributionWindows = overrideAttrWindows
  }

  let runnerConfig = resolveRunnerConfiguration(overrides)
  if (schemaMode === 'legacy') {
    runnerConfig = {
      ...runnerConfig,
      breakdownKeys: ['none'],
      actionReportTimes: [CANONICAL_ACTION_REPORT_TIME],
      attributionWindows: [CANONICAL_ATTR_WINDOW],
    }
  }

  const combinations = buildMatrixCombinations(runnerConfig)
  if (combinations.length === 0) {
    throw new Error('No valid parameter combinations resolved. Check provided filters.')
  }

  const chunks = enumerateChunks(args.since, args.until, args.chunkSize)
  const totalJobs = combinations.length * chunks.length
  const estSeconds = totalJobs * AVG_SECONDS_PER_JOB
  const estWallSeconds = Math.ceil(estSeconds / Math.max(1, args.concurrency))

  logger.info(
    {
      tenantId: args.tenant,
      accountId: args.account,
      since: args.since,
      until: args.until,
      chunkSize: args.chunkSize,
      concurrency: args.concurrency,
      env: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
      supabaseUrl: SUPABASE_URL,
      encryptionKeyFingerprint: getEncryptionKeyFingerprint(),
      schemaMode,
      preset: args.preset,
      levels: runnerConfig.levels,
      breakdownKeys: runnerConfig.breakdownKeys,
      actionReportTimes: runnerConfig.actionReportTimes,
      attributionWindows: runnerConfig.attributionWindows,
      totalMonths: chunks.length,
      totalCombinations: combinations.length,
      totalJobs,
      estimatedDurationMinutes: Math.ceil(estWallSeconds / 60),
      estimatedDurationSeconds: estWallSeconds,
    },
    'Starting Meta backfill',
  )

  const accessToken = await resolveAccessToken(args.tenant)

  const storageAdapter = new AdaptiveMetaInsightsStorage(storageClient, schemaMode)

  const tasks: Array<() => Promise<void>> = []

  for (const combo of combinations) {
    for (const chunk of chunks) {
      tasks.push(async () =>
        runChunk(
          {
            tenantId: args.tenant,
            accountId: args.account,
            accessToken,
            supabase: storageClient,
            storage: storageAdapter,
          },
          chunk,
          combo.level,
          combo.breakdownKey,
          combo.breakdowns,
          combo.actionReportTime,
          combo.attributionWindow,
        ),
      )
    }
  }

  let completed = 0
  await runWithConcurrency(tasks, args.concurrency, async (runner) => {
    await runner()
    completed += 1
    logger.info({ completed, total: tasks.length }, 'Backfill progress')
  })

  logger.info(
    {
      tenantId: args.tenant,
      accountId: args.account,
      since: args.since,
      until: args.until,
      completedChunks: completed,
      totalChunks: tasks.length,
    },
    'Backfill finished',
  )
}

main().catch((error) => {
  logger.error(
    {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    },
    'Meta backfill failed',
  )
  process.exit(1)
})

