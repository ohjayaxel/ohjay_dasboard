#!/usr/bin/env -S tsx

/**
 * Manual cleanup script for stuck Meta sync jobs
 * 
 * Usage:
 *   pnpm tsx scripts/cleanup_stuck_meta_jobs.ts [--timeout-minutes 60]
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// Load environment variables
function loadEnvFile() {
  const shellScripts = ['env/local.prod.sh', 'env/local.dev.sh']
  
  for (const script of shellScripts) {
    try {
      const content = readFileSync(script, 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        if (!trimmed.startsWith('export ')) continue
        const match = trimmed.match(/^export\s+([^=]+)=["']?([^"']+)["']?/)
        if (match) {
          const key = match[1].trim()
          let value = match[2].trim()
          if ((value.startsWith('"') && value.endsWith('"')) || 
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
          }
          process.env[key] = value
        }
      }
      console.log(`[cleanup_stuck_jobs] Loaded env from ${script}`)
      return
    } catch {
      // try next
    }
  }

  // Fallback to .env.local
  try {
    const content = readFileSync('.env.local', 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const match = trimmed.match(/^([^=:#]+)=(.*)$/)
      if (match) {
        const key = match[1].trim()
        let value = match[2].trim()
        if ((value.startsWith('"') && value.endsWith('"')) || 
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        process.env[key] = value
      }
    }
    console.log(`[cleanup_stuck_jobs] Loaded env from .env.local`)
  } catch {
    // ignore
  }
}

loadEnvFile()

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_EDGE_FUNCTION_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

async function main() {
  const timeoutMinutes = parseInt(process.argv.find(arg => arg.startsWith('--timeout-minutes'))?.split('=')[1] || '60', 10)

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY')
    console.error('   Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables')
    process.exit(1)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  const timeoutThreshold = new Date()
  timeoutThreshold.setMinutes(timeoutThreshold.getMinutes() - timeoutMinutes)

  console.log(`\n🧹 Cleaning up stuck Meta sync jobs older than ${timeoutMinutes} minutes`)
  console.log(`   Threshold: ${timeoutThreshold.toISOString()}\n`)

  // Find stuck jobs
  const { data: stuckJobs, error: fetchError } = await supabase
    .from('jobs_log')
    .select('id, tenant_id, started_at, source')
    .eq('source', 'meta')
    .eq('status', 'running')
    .lt('started_at', timeoutThreshold.toISOString())

  if (fetchError) {
    console.error(`❌ Failed to fetch stuck jobs: ${fetchError.message}`)
    process.exit(1)
  }

  if (!stuckJobs || stuckJobs.length === 0) {
    console.log('✅ No stuck jobs found')
    return
  }

  console.log(`Found ${stuckJobs.length} stuck job(s):`)
  for (const job of stuckJobs) {
    const duration = Math.round((Date.now() - new Date(job.started_at).getTime()) / 1000 / 60)
    console.log(`   - Job ${job.id} (tenant: ${job.tenant_id}) - running for ${duration} minutes`)
  }

  // Update stuck jobs in batches
  const BATCH_SIZE = 100
  const stuckJobIds = stuckJobs.map((job) => job.id)
  let cleaned = 0
  let errors: string[] = []

  console.log(`\n🧹 Processing ${stuckJobs.length} stuck jobs in batches of ${BATCH_SIZE}...`)

  for (let i = 0; i < stuckJobIds.length; i += BATCH_SIZE) {
    const batch = stuckJobIds.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(stuckJobIds.length / BATCH_SIZE)

    const { error: updateError } = await supabase
      .from('jobs_log')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: `Job stuck in running status for more than ${timeoutMinutes} minutes. Marked as failed by cleanup script.`,
      })
      .in('id', batch)

    if (updateError) {
      const errorMsg = `Batch ${batchNum}/${totalBatches}: ${updateError.message}`
      errors.push(errorMsg)
      console.error(`   ❌ ${errorMsg}`)
    } else {
      cleaned += batch.length
      console.log(`   ✅ Batch ${batchNum}/${totalBatches}: Cleaned ${batch.length} jobs (${cleaned}/${stuckJobs.length} total)`)
    }
  }

  if (errors.length > 0 && cleaned === 0) {
    console.error(`\n❌ Failed to clean up any jobs. Errors:`)
    errors.forEach((err) => console.error(`   - ${err}`))
    process.exit(1)
  }

  console.log(`\n✅ Successfully cleaned up ${cleaned}/${stuckJobs.length} stuck job(s)`)
  if (errors.length > 0) {
    console.log(`⚠️  ${errors.length} batch(es) failed, but ${cleaned} jobs were cleaned`)
  }
  console.log('')
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})

