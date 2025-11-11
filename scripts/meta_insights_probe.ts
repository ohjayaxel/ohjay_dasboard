#!/usr/bin/env -S tsx

import { fetchMetaInsightsDaily } from '@/lib/integrations/meta'
import { getEncryptionKeyFingerprint } from '@/lib/integrations/crypto'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

function usage() {
  console.log('Usage: pnpm tsx scripts/meta_insights_probe.ts <tenantId> <adAccountId> [startDate] [endDate]')
  console.log('Dates must be in YYYY-MM-DD format. Defaults to last 30 days if omitted.')
}

function toIso(date?: string): string {
  if (date && !Number.isNaN(new Date(date).getTime())) {
    return new Date(date).toISOString().slice(0, 10)
  }

  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10)
}

type ConnectionDiagnostics = {
  id?: string
  status?: string
  updated_at?: string
  meta?: Record<string, unknown> | null
}

async function logEnvironmentDiagnostics(tenantId: string) {
  try {
    const supabase = getSupabaseServiceClient()
    const { data, error } = await supabase
      .from('connections')
      .select('id,status,updated_at,meta')
      .eq('tenant_id', tenantId)
      .eq('source', 'meta')
      .maybeSingle()

    if (error) {
      console.warn('[env] Failed to inspect remote connection metadata:', error.message)
      return
    }

    const diagnostics = (data ?? null) as ConnectionDiagnostics | null
    const meta = diagnostics?.meta ?? null
    const remoteFingerprint =
      meta && typeof (meta as Record<string, unknown>).encryption_key_fingerprint === 'string'
        ? ((meta as Record<string, unknown>).encryption_key_fingerprint as string)
        : null
    const remoteEnv =
      meta && typeof (meta as Record<string, unknown>).environment === 'string'
        ? ((meta as Record<string, unknown>).environment as string)
        : null

    console.log(
      JSON.stringify(
        {
          envDiagnostics: {
            activeProfile: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
            localSupabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
            localEncryptionKeyFingerprint: getEncryptionKeyFingerprint(),
            connectionId: diagnostics?.id,
            connectionStatus: diagnostics?.status,
            connectionUpdatedAt: diagnostics?.updated_at,
            remoteEnvironment: remoteEnv,
            remoteEncryptionKeyFingerprint: remoteFingerprint,
          },
        },
        null,
        2,
      ),
    )
  } catch (error) {
    console.warn('[env] Unable to run environment diagnostics:', (error as Error).message)
  }
}

async function main() {
  const [tenantId, adAccountId, startArg, endArg] = process.argv.slice(2)

  if (!tenantId || !adAccountId) {
    usage()
    process.exit(1)
  }

  const endDate = toIso(endArg)
  const startDate =
    startArg && !Number.isNaN(new Date(startArg).getTime())
      ? new Date(startArg).toISOString().slice(0, 10)
      : (() => {
          const end = new Date(endDate)
          end.setDate(end.getDate() - 29)
          return end.toISOString().slice(0, 10)
        })()

  console.log(
    JSON.stringify(
      {
        tenantId,
        adAccountId,
        startDate,
        endDate,
        appEnv: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        encryptionKeyFingerprint: getEncryptionKeyFingerprint(),
      },
      null,
      2,
    ),
  )

  await logEnvironmentDiagnostics(tenantId)

  try {
    const rows = await fetchMetaInsightsDaily({
      tenantId,
      adAccountId,
      startDate,
      endDate,
    })

    console.log(
      JSON.stringify(
        {
          totalRows: rows.length,
          sample: rows.slice(0, 10),
        },
        null,
        2,
      ),
    )
  } catch (error) {
    console.error('Meta insights probe failed:', error)
    process.exit(1)
  }
}

void main()

