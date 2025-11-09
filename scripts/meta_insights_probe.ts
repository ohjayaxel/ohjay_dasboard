#!/usr/bin/env -S tsx

import { fetchMetaInsightsDaily } from '@/lib/integrations/meta'

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
      },
      null,
      2,
    ),
  )

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

