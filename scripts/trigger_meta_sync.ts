#!/usr/bin/env -S tsx

/**
 * Trigger Meta sync for a tenant
 * 
 * Usage:
 *   pnpm tsx scripts/trigger_meta_sync.ts <tenant-slug> [--mode incremental|backfill] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_EDGE_FUNCTION_KEY = process.env.SUPABASE_EDGE_FUNCTION_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

async function main() {
  const tenantSlug = process.argv[2] || 'skinome'
  const mode = process.argv.includes('--mode') 
    ? (process.argv[process.argv.indexOf('--mode') + 1] as 'incremental' | 'backfill')
    : 'incremental'
  const since = process.argv.includes('--since')
    ? process.argv[process.argv.indexOf('--since') + 1]
    : undefined
  const until = process.argv.includes('--until')
    ? process.argv[process.argv.indexOf('--until') + 1]
    : undefined

  if (!SUPABASE_URL || !SUPABASE_EDGE_FUNCTION_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_EDGE_FUNCTION_KEY')
    process.exit(1)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_EDGE_FUNCTION_KEY)

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

  console.log(`\n🚀 Triggering Meta sync for: ${tenant.name} (${tenant.slug})`)
  console.log(`   Tenant ID: ${tenant.id}`)
  console.log(`   Mode: ${mode}`)
  if (since) console.log(`   Since: ${since}`)
  if (until) console.log(`   Until: ${until}\n`)

  // Invoke the sync-meta edge function
  const payload: Record<string, unknown> = {
    tenantId: tenant.id,
    mode,
  }
  if (since) payload.since = since
  if (until) payload.until = until

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/sync-meta`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_EDGE_FUNCTION_KEY,
        'Authorization': `Bearer ${SUPABASE_EDGE_FUNCTION_KEY}`,
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`❌ Sync failed: ${response.status} ${errorText}`)
      process.exit(1)
    }

    const result = await response.json()
    console.log(`✅ Sync triggered successfully!`)
    console.log(`   Response:`, JSON.stringify(result, null, 2))
    console.log(`\n💡 Check job logs with:`)
    console.log(`   pnpm tsx scripts/check_meta_sync_status.ts ${tenantSlug}\n`)
  } catch (error) {
    console.error(`❌ Failed to trigger sync:`, error)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})


