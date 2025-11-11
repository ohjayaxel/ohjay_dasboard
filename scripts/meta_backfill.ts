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
import { createMetaInsightsStorageAdapter } from '@/lib/storage/metaInsightsStorage'
import { runMonthlyChunk, LEVELS, ACTION_REPORT_TIMES, ATTR_WINDOWS, BREAKDOWN_SETS } from '@/lib/integrations/metaInsightsRunner'
import type { InsightLevel, ActionReportTime, AttributionWindow } from '@/lib/integrations/metaInsightsRunner'
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
}

type ParsedArgs = {
  tenant: string
  account: string
  since: string
  until: string
  chunkSize: number
  concurrency: number
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

  const args = parser.parse_args() as Partial<ParsedArgs>

  return {
    tenant: args.tenant!,
    account: args.account!,
    since: args.since!,
    until: args.until!,
    chunkSize: Math.max(1, args.chunkSize ?? 1),
    concurrency: Math.max(1, args.concurrency ?? 2),
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
  const storage = createMetaInsightsStorageAdapter()

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

  const rows = await runMonthlyChunk({
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    accessToken: ctx.accessToken,
    storage,
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
      rows: rows.length,
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
    },
    'Starting Meta backfill',
  )

  const accessToken = await resolveAccessToken(args.tenant)

  const chunks = enumerateChunks(args.since, args.until, args.chunkSize)
  const storageClient = getSupabaseServiceClient()

  const tasks: Array<() => Promise<void>> = []

  for (const level of LEVELS) {
    for (const [breakdownKey, breakdowns] of Object.entries(BREAKDOWN_SETS)) {
      for (const actionReportTime of ACTION_REPORT_TIMES) {
        for (const attributionWindow of ATTR_WINDOWS) {
          for (const chunk of chunks) {
            tasks.push(async () =>
              runChunk(
                {
                  tenantId: args.tenant,
                  accountId: args.account,
                  accessToken,
                  supabase: storageClient,
                },
                chunk,
                level,
                breakdownKey,
                breakdowns,
                actionReportTime,
                attributionWindow,
              ),
            )
          }
        }
      }
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
  logger.error({ error }, 'Meta backfill failed')
  process.exit(1)
})

