#!/usr/bin/env -S tsx

/**
 * Check Meta marketing spend data
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_EDGE_FUNCTION_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY')
    console.error('   Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables')
    process.exit(1)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0' // skinome

  // Check recent job logs
  const { data: jobs } = await supabase
    .from('jobs_log')
    .select('*')
    .eq('source', 'meta')
    .eq('tenant_id', tenantId)
    .order('started_at', { ascending: false })
    .limit(5)

  console.log('\n📝 Recent Meta Jobs:')
  if (jobs && jobs.length > 0) {
    for (const job of jobs) {
      const duration = job.finished_at
        ? `${Math.round((new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()) / 1000)}s`
        : 'running...'
      const status = job.status === 'succeeded' ? '✅' : job.status === 'failed' ? '❌' : '⏳'
      console.log(`   ${status} ${job.status.toUpperCase()} - ${job.started_at} (${duration})`)
      if (job.error) {
        console.log(`      Error: ${job.error}`)
      }
    }
  } else {
    console.log('   No jobs found')
  }

  // Check KPI data from 2025-12-04 onwards
  const { data: kpi } = await supabase
    .from('kpi_daily')
    .select('date, spend')
    .eq('source', 'meta')
    .eq('tenant_id', tenantId)
    .gte('date', '2025-12-04')
    .order('date', { ascending: true })

  console.log('\n💰 Marketing Spend from 2025-12-04:')
  if (kpi && kpi.length > 0) {
    for (const row of kpi) {
      console.log(`   ${row.date}: ${row.spend ? row.spend.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' }) : '0 kr'}`)
    }
  } else {
    console.log('   ❌ No data found')
  }

  // Check latest data
  const { data: latest } = await supabase
    .from('kpi_daily')
    .select('date, spend')
    .eq('source', 'meta')
    .eq('tenant_id', tenantId)
    .order('date', { ascending: false })
    .limit(1)
    .single()

  if (latest) {
    console.log(`\n📊 Latest Marketing Spend Data:`)
    console.log(`   Date: ${latest.date}`)
    console.log(`   Spend: ${latest.spend ? latest.spend.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' }) : 'N/A'}`)
  }

  console.log('')
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})

