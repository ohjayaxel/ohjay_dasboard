#!/usr/bin/env -S tsx

/**
 * Check Meta sync status for a tenant
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Load environment variables
function loadEnvFile() {
  // First try to source from shell script if it exists (preferred for local.prod.sh)
  const shellScripts = [
    'env/local.prod.sh',
    'env/local.dev.sh',
  ];

  for (const script of shellScripts) {
    try {
      const content = readFileSync(script, 'utf-8');
      // Parse export statements from shell script
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        // Only process lines starting with 'export '
        if (!trimmed.startsWith('export ')) continue;
        // Match: export KEY="value" or export KEY=value
        const match = trimmed.match(/^export\s+([^=]+)=["']?([^"']+)["']?/);
        if (match) {
          const key = match[1].trim();
          let value = match[2].trim();
          // Remove surrounding quotes if still present
          if ((value.startsWith('"') && value.endsWith('"')) || 
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          process.env[key] = value;
        }
      }
      console.log(`[check_meta_sync] Loaded env from ${script}`);
      return;
    } catch (error) {
      // File doesn't exist, continue
    }
  }

  // Fallback to .env.local
  try {
    const content = readFileSync('.env.local', 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([^=]+)=["']?([^"']+)["']?/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || 
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
    }
    console.log(`[check_meta_sync] Loaded env from .env.local`);
  } catch (error) {
    // File doesn't exist
  }
}

loadEnvFile()

// Ensure required vars are set
if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
}

import { getSupabaseServiceClient } from '@/lib/supabase/server'

async function main() {
  const tenantSlug = process.argv[2] || 'skinome'

  const supabase = getSupabaseServiceClient()

  // Get tenant ID
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, name, slug')
    .eq('slug', tenantSlug)
    .single()

  if (tenantError || !tenant) {
    console.error(`❌ Tenant not found: ${tenantSlug}`)
    process.exit(1)
  }

  console.log(`\n📊 Meta Sync Status for: ${tenant.name} (${tenant.slug})`)
  console.log(`   Tenant ID: ${tenant.id}\n`)

  // Get Meta connection
  const { data: connection, error: connectionError } = await supabase
    .from('connections')
    .select('status, meta, updated_at')
    .eq('tenant_id', tenant.id)
    .eq('source', 'meta')
    .single()

  if (connectionError || !connection) {
    console.error(`❌ Meta connection not found for tenant`)
    process.exit(1)
  }

  console.log(`🔗 Connection Status: ${connection.status}`)
  console.log(`   Last Updated: ${connection.updated_at}`)

  const meta = connection.meta as Record<string, unknown> | null
  if (meta) {
    if (meta.last_synced_at) {
      console.log(`   Last Synced: ${meta.last_synced_at}`)
    }
    if (meta.last_synced_range) {
      const range = meta.last_synced_range as { since?: string; until?: string }
      console.log(`   Last Synced Range: ${range.since} to ${range.until}`)
    }
    if (meta.last_backfill_at) {
      console.log(`   Last Backfill: ${meta.last_backfill_at}`)
    }
  }

  // Get recent job logs
  const { data: jobs, error: jobsError } = await supabase
    .from('jobs_log')
    .select('id, status, started_at, finished_at, error')
    .eq('tenant_id', tenant.id)
    .eq('source', 'meta')
    .order('started_at', { ascending: false })
    .limit(10)

  if (jobsError) {
    console.error(`❌ Failed to fetch job logs: ${jobsError.message}`)
    process.exit(1)
  }

  console.log(`\n📝 Recent Job Logs (last 10):`)
  if (!jobs || jobs.length === 0) {
    console.log(`   No job logs found`)
  } else {
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
  }

  // Check latest data in kpi_daily
  const { data: latestKpi, error: kpiError } = await supabase
    .from('kpi_daily')
    .select('date, spend')
    .eq('tenant_id', tenant.id)
    .eq('source', 'meta')
    .order('date', { ascending: false })
    .limit(1)
    .single()

  if (kpiError) {
    console.log(`\n⚠️  Could not fetch latest KPI data: ${kpiError.message}`)
  } else if (latestKpi) {
    console.log(`\n💰 Latest Marketing Spend Data:`)
    console.log(`   Date: ${latestKpi.date}`)
    console.log(`   Spend: ${latestKpi.spend ? latestKpi.spend.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' }) : 'N/A'}`)
  } else {
    console.log(`\n⚠️  No marketing spend data found`)
  }

  // Check data from 2025-12-04 onwards
  const { data: recentKpi, error: recentKpiError } = await supabase
    .from('kpi_daily')
    .select('date, spend')
    .eq('tenant_id', tenant.id)
    .eq('source', 'meta')
    .gte('date', '2025-12-04')
    .order('date', { ascending: true })

  if (recentKpiError) {
    console.log(`\n⚠️  Could not fetch recent KPI data: ${recentKpiError.message}`)
  } else if (recentKpi && recentKpi.length > 0) {
    console.log(`\n📅 Marketing Spend from 2025-12-04 onwards:`)
    for (const row of recentKpi) {
      console.log(`   ${row.date}: ${row.spend ? row.spend.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' }) : '0 kr'}`)
    }
  } else {
    console.log(`\n❌ No marketing spend data found from 2025-12-04 onwards`)
  }

  console.log(`\n`)
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
