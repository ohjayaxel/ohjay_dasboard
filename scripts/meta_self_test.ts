#!/usr/bin/env tsx
import { randomBytes } from 'crypto'

import {
  META_REQUESTED_SCOPES,
  fetchMetaAdAccountsForTenant,
  fetchMetaProfileForTenant,
  getActiveMetaAccessToken,
  getMetaCallbackPath,
  getMetaRedirectUri,
  getMetaBaseUrl,
  getExistingMetaConnection,
} from '@/lib/integrations/meta'
import { logger, withRequestContext } from '@/lib/logger'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

type StepResult = {
  step: string
  status: '✅' | '❌'
  detail?: string
}

type Args = {
  tenantId?: string
  live?: boolean
}

function parseArgs(): Args {
  const args: Args = {}
  for (const entry of process.argv.slice(2)) {
    if (entry === '--live') {
      args.live = true
    } else if (entry.startsWith('--tenant=')) {
      args.tenantId = entry.split('=')[1]
    } else if (entry === '--help') {
      console.log(
        'Usage: pnpm meta:selftest --tenant=<tenant-uuid> [--live]\n' +
          '  --tenant   Tenant ID to validate (required)\n' +
          '  --live     Perform live API calls using stored access token\n',
      )
      process.exit(0)
    }
  }
  return args
}

async function ensureState(tenantId: string, redirectPath: string) {
  const client = getSupabaseServiceClient()
  const state = randomBytes(16).toString('hex')
  const now = new Date().toISOString()

  const { data: existing } = await client
    .from('connections')
    .select('id, meta')
    .eq('tenant_id', tenantId)
    .eq('source', 'meta')
    .maybeSingle()

  const meta =
    existing && existing.meta && typeof existing.meta === 'object'
      ? (existing.meta as Record<string, unknown>)
      : {}

  const nextMeta = {
    ...meta,
    oauth_state: state,
    oauth_state_created_at: now,
    oauth_redirect_path: redirectPath,
  }

  if (existing) {
    await client
      .from('connections')
      .update({
        status: 'disconnected',
        access_token_enc: null,
        refresh_token_enc: null,
        expires_at: null,
        updated_at: now,
        meta: nextMeta,
      })
      .eq('id', existing.id)
  } else {
    await client.from('connections').insert({
      tenant_id: tenantId,
      source: 'meta',
      status: 'disconnected',
      created_at: now,
      updated_at: now,
      meta: nextMeta,
    })
  }

  return state
}

async function main() {
  const args = parseArgs()
  const steps: StepResult[] = []

  if (!args.tenantId) {
    console.error('❌  Missing required --tenant=<tenant-id> argument.')
    process.exit(1)
  }

  const tenantId = args.tenantId

  await withRequestContext(async () => {
    const envMissing = ['META_APP_ID', 'META_APP_SECRET', 'NEXT_PUBLIC_BASE_URL'].filter(
      (key) => !process.env[key],
    )
    steps.push({
      step: 'Environment variables',
      status: envMissing.length === 0 ? '✅' : '❌',
      detail:
        envMissing.length === 0
          ? 'All required Meta env vars present.'
          : `Missing: ${envMissing.join(', ')}`,
    })

    let redirectUri: string | undefined
    try {
      redirectUri = getMetaRedirectUri()
      const callbackPath = getMetaCallbackPath()
      const redirectUrl = new URL(redirectUri)
      const matches = redirectUrl.pathname.endsWith(callbackPath)
      steps.push({
        step: 'Redirect URI consistency',
        status: matches ? '✅' : '❌',
        detail: matches
          ? redirectUri
          : `Redirect mismatch. Got ${redirectUrl.pathname}, expected suffix ${callbackPath}`,
      })
    } catch (error) {
      steps.push({
        step: 'Redirect URI consistency',
        status: '❌',
        detail: error instanceof Error ? error.message : String(error),
      })
    }

    steps.push({
      step: 'Requested scopes',
      status: '✅',
      detail: META_REQUESTED_SCOPES.join(', '),
    })

    const redirectPath = `/admin/tenants/${tenantId}`
    try {
      const state = await ensureState(tenantId, redirectPath)
      steps.push({
        step: 'State persisted',
        status: '✅',
        detail: `State ${state.slice(0, 8)}… saved for tenant ${tenantId}`,
      })
    } catch (error) {
      steps.push({
        step: 'State persisted',
        status: '❌',
        detail: error instanceof Error ? error.message : String(error),
      })
    }

    if (args.live) {
      try {
        const token = await getActiveMetaAccessToken(tenantId)
        if (!token) {
          steps.push({
            step: 'Access token present',
            status: '❌',
            detail: 'No Meta access token stored for tenant.',
          })
        } else {
          steps.push({
            step: 'Access token present',
            status: '✅',
            detail: `Token detected (mask: ${token.slice(0, 4)}…${token.slice(-4)})`,
          })

          const profile = await fetchMetaProfileForTenant({
            tenantId,
            route: 'scripts.meta_self_test',
          })
          steps.push({
            step: 'Live /me',
            status: profile.status === 200 ? '✅' : '❌',
            detail:
              profile.status === 200
                ? `id=${profile.body?.id} name=${profile.body?.name}`
                : `Status ${profile.status}`,
          })

          const adAccounts = await fetchMetaAdAccountsForTenant({
            tenantId,
            route: 'scripts.meta_self_test',
          })
          steps.push({
            step: 'Live /me/adaccounts',
            status: adAccounts.status === 200 ? '✅' : '❌',
            detail: `Status ${adAccounts.status}, accounts=${adAccounts.accounts?.length ?? 0}`,
          })
        }
      } catch (error) {
        steps.push({
          step: 'Live token validation',
          status: '❌',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    } else {
      steps.push({
        step: 'Live token validation',
        status: '✅',
        detail: 'Skipped (run with --live to perform live API checks).',
      })
    }

    const connection = await getExistingMetaConnection(tenantId)
    steps.push({
      step: 'Connection record exists',
      status: connection ? '✅' : '❌',
      detail: connection ? `Connection status: ${connection.status}` : 'No connection row found.',
    })

    const appMode = process.env.APP_ENV ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV
    steps.push({
      step: 'App mode',
      status: '✅',
      detail: `APP_ENV=${appMode ?? 'unknown'}, Base=${getMetaBaseUrl()}`,
    })
  })

  console.table(steps)
  if (steps.some((step) => step.status === '❌')) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  logger.error(
    {
      route: 'scripts.meta_self_test',
      action: 'fatal',
      error_message: error instanceof Error ? error.message : String(error),
    },
    'Meta self test terminated with error',
  )
  console.error(error)
  process.exitCode = 1
})


