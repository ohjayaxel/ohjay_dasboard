#!/usr/bin/env -S tsx

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'timers/promises'

import { logger } from '@/lib/logger'
import { getSupabaseServiceClient } from '@/lib/supabase/server'
import {
  buildMatrixCombinations,
  resolveRunnerConfiguration,
  type ActionReportTime,
  type AttributionWindow,
  type InsightLevel,
  type RunnerConfigurationInput,
} from '@/lib/integrations/metaInsightsRunner'

const POLL_INTERVAL_MS = 10_000

const RUNNER_PRESETS: Record<string, RunnerConfigurationInput> = {
  full: {},
  'account-country-lite': {
    levels: ['account'],
    breakdownKeys: ['country_priority'],
    actionReportTimes: ['conversion'],
    attributionWindows: ['1d_click'],
  },
}

type BackfillJobRow = {
  id: string
  tenant_id: string
  account_id: string
  since: string
  until: string
  mode: string
  config_json: Record<string, any> | null
  status: string
  progress_completed: number | null
  progress_total: number | null
  aggregate_currency: boolean
}

function enumerateMonths(since: string, until: string, chunkSize: number): Array<{ since: string; until: string }> {
  const start = new Date(`${since}T00:00:00Z`)
  const end = new Date(`${until}T00:00:00Z`)

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(`Invalid date range: ${since} → ${until}`)
  }

  const clampedStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const results: Array<{ since: string; until: string }> = []
  const cursor = new Date(clampedStart)

  while (cursor <= end) {
    const chunkStart = new Date(cursor)
    const chunkEnd = new Date(cursor)
    chunkEnd.setUTCMonth(chunkEnd.getUTCMonth() + chunkSize)
    chunkEnd.setUTCDate(0)

    const sinceIso = chunkStart.toISOString().slice(0, 10)
    const untilIso = (chunkEnd > end ? end : chunkEnd).toISOString().slice(0, 10)

    results.push({ since: sinceIso, until: untilIso })
    cursor.setUTCMonth(cursor.getUTCMonth() + chunkSize)
  }

  return results
}

async function claimJob() {
  const supabase = getSupabaseServiceClient()
  const { data, error } = await supabase.rpc('claim_meta_backfill_job')
  if (error) {
    throw new Error(`Failed to claim job: ${error.message}`)
  }
  return data as BackfillJobRow | null
}

async function updateJob(jobId: string, payload: Record<string, unknown>) {
  const supabase = getSupabaseServiceClient()
  const { error } = await supabase.from('meta_backfill_jobs').update(payload).eq('id', jobId)
  if (error) {
    throw new Error(`Failed to update job ${jobId}: ${error.message}`)
  }
}

function buildCliArgs(job: BackfillJobRow) {
  const config = (job.config_json ?? {}) as RunnerConfigurationInput & {
    chunkSize?: number
    concurrency?: number
    preset?: string
    skipKpi?: boolean
  }

  const args: string[] = [
    'tsx',
    'scripts/meta_backfill.ts',
    '--tenant',
    job.tenant_id,
    '--account',
    job.account_id,
    '--since',
    job.since,
    '--until',
    job.until,
    '--chunk-size',
    String(config.chunkSize ?? 1),
    '--concurrency',
    String(config.concurrency ?? 2),
  ]

  if (config.levels && config.levels.length > 0) {
    args.push('--levels', config.levels.join(','))
  }
  if (config.breakdownKeys && config.breakdownKeys.length > 0) {
    args.push('--breakdowns', config.breakdownKeys.join(','))
  }
  if (config.actionReportTimes && config.actionReportTimes.length > 0) {
    args.push('--action-times', config.actionReportTimes.join(','))
  }
  if (config.attributionWindows && config.attributionWindows.length > 0) {
    args.push('--attr-windows', config.attributionWindows.join(','))
  }
  if (config.preset) {
    args.push('--preset', config.preset)
  }
  if (config.skipKpi) {
    args.push('--skip-kpi')
  }

  return args
}

async function spawnCli(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', args, {
      stdio: 'inherit',
      env: process.env,
    })

    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Command ${args.join(' ')} exited with code ${code ?? 'null'}`))
      }
    })

    child.on('error', reject)
  })
}

async function runJob(job: BackfillJobRow) {
  const config = (job.config_json ?? {}) as RunnerConfigurationInput & {
    chunkSize?: number
    concurrency?: number
    preset?: string
    skipKpi?: boolean
  }
  const chunkSize = Math.max(1, config.chunkSize ?? 1)

  const presetKey = typeof config.preset === 'string' ? config.preset : 'full'
  const preset = RUNNER_PRESETS[presetKey] ?? RUNNER_PRESETS.full

  const resolvedConfig = resolveRunnerConfiguration({
    levels: Array.isArray(config.levels)
      ? (config.levels as string[])
      : (preset.levels as InsightLevel[] | undefined),
    breakdownKeys: Array.isArray(config.breakdownKeys)
      ? (config.breakdownKeys as string[])
      : preset.breakdownKeys,
    actionReportTimes: Array.isArray(config.actionReportTimes)
      ? (config.actionReportTimes as ActionReportTime[])
      : (preset.actionReportTimes as ActionReportTime[] | undefined),
    attributionWindows: Array.isArray(config.attributionWindows)
      ? (config.attributionWindows as AttributionWindow[])
      : (preset.attributionWindows as AttributionWindow[] | undefined),
  })

  const combinations = buildMatrixCombinations(resolvedConfig)
  const months = enumerateMonths(job.since, job.until, chunkSize)
  const totalJobs = combinations.length * months.length

  await updateJob(job.id, {
    progress_total: totalJobs,
    progress_completed: 0,
    combination_count: combinations.length,
    chunk_count: months.length,
    updated_at: new Date().toISOString(),
  })

  const cliArgs = buildCliArgs(job)

  logger.info(
    {
      jobId: job.id,
      mode: job.mode,
      tenantId: job.tenant_id,
      accountId: job.account_id,
      since: job.since,
      until: job.until,
      totalJobs,
      combinations: combinations.length,
      months: months.length,
    },
    'Starting Meta backfill job',
  )

  await spawnCli(cliArgs)

  logger.info(
    {
      jobId: job.id,
      tenantId: job.tenant_id,
      accountId: job.account_id,
      since: job.since,
      until: job.until,
    },
    'Meta backfill finished, starting KPI aggregation',
  )

  await spawnCli([
    'tsx',
    'scripts/meta_kpi_upsert.ts',
    '--tenant',
    job.tenant_id,
    '--account',
    job.account_id,
    '--since',
    job.since,
    '--until',
    job.until,
  ])

  await updateJob(job.id, {
    status: 'completed',
    progress_completed: totalJobs,
    finished_at: new Date().toISOString(),
    aggregate_currency: true,
  })

  logger.info({ jobId: job.id }, 'Meta backfill job completed')
}

async function workerLoop() {
  while (true) {
    let job: BackfillJobRow | null = null

    try {
      job = await claimJob()
    } catch (error) {
      logger.error({ error }, 'Failed to claim job')
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    if (!job) {
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    try {
      await runJob(job)
    } catch (error) {
      logger.error({ error, jobId: job.id }, 'Meta backfill job failed')
      try {
        await updateJob(job.id, {
          status: 'failed',
          error_message: error instanceof Error ? error.message : String(error),
          finished_at: new Date().toISOString(),
        })
      } catch (updateError) {
        logger.error({ updateError, jobId: job.id }, 'Failed to mark job as failed')
      }
    }
  }
}

workerLoop().catch((error) => {
  logger.error({ error }, 'Worker crashed')
  process.exit(1)
})

