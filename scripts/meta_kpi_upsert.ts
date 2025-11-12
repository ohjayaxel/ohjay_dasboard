#!/usr/bin/env -S tsx

import { ArgumentParser } from 'argparse'

import { getSupabaseServiceClient } from '@/lib/supabase/server'

type Args = {
  tenant: string
  account: string
  since: string
  until: string
}

function parseArgs(): Args {
  const parser = new ArgumentParser({
    description: 'Aggregate Meta insights into kpi_daily.',
  })

  parser.add_argument('--tenant', { required: true, help: 'Tenant UUID' })
  parser.add_argument('--account', { required: true, help: 'Meta ad account id (act_...)' })
  parser.add_argument('--since', { required: true, help: 'Start date YYYY-MM-DD' })
  parser.add_argument('--until', { required: true, help: 'End date YYYY-MM-DD' })

  const args = parser.parse_args()

  return {
    tenant: args.tenant as string,
    account: args.account as string,
    since: args.since as string,
    until: args.until as string,
  }
}

function parseIso(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${date}`)
  }
  return parsed.toISOString().slice(0, 10)
}

async function main() {
  const args = parseArgs()
  const since = parseIso(args.since)
  const until = parseIso(args.until)

  const client = getSupabaseServiceClient()

  const { data, error } = await client
    .from('meta_insights_daily')
    .select('tenant_id, date, spend, clicks, conversions, revenue')
    .eq('tenant_id', args.tenant)
    .eq('ad_account_id', args.account)
    .eq('level', 'account')
    .eq('action_report_time', 'impression')
    .eq('attribution_window', '1d_click')
    .gte('date', since)
    .lte('date', until)
    .order('date', { ascending: true })

  if (error) {
    throw new Error(`Failed to fetch aggregated meta insights: ${error.message}`)
  }

  const byDate = new Map<
    string,
    {
      tenantId: string
      spend: number
      clicks: number
      conversions: number
      revenue: number
    }
  >()

  for (const row of data ?? []) {
    const date = row.date as string
    const tenantId = row.tenant_id as string
    const existing = byDate.get(date) ?? {
      tenantId,
      spend: 0,
      clicks: 0,
      conversions: 0,
      revenue: 0,
    }

    existing.spend += Number(row.spend ?? 0)
    existing.clicks += Number(row.clicks ?? 0)
    existing.conversions += Number(row.conversions ?? 0)
    existing.revenue += Number(row.revenue ?? 0)

    byDate.set(date, existing)
  }

  const rows = Array.from(byDate.entries()).map(([date, aggregate]) => {
    const { spend, clicks, conversions, revenue } = aggregate
    const aov = conversions > 0 ? revenue / conversions : null
    const cos = revenue > 0 ? spend / revenue : null
    const roas = spend > 0 ? revenue / spend : null

    return {
      tenant_id: aggregate.tenantId,
      date,
      source: 'meta' as const,
      spend,
      clicks,
      conversions,
      revenue,
      aov,
      cos,
      roas,
    }
  })

  if (rows.length === 0) {
    console.log('No account-level rows found to aggregate.')
    return
  }

  const { error: upsertError } = await client.from('kpi_daily').upsert(rows, {
    onConflict: 'tenant_id,date,source',
  })

  if (upsertError) {
    throw new Error(`Failed to upsert kpi_daily rows: ${upsertError.message}`)
  }

  console.log(
    JSON.stringify(
      {
        tenantId: args.tenant,
        accountId: args.account,
        since,
        until,
        rows: rows.length,
        totalSpend: rows.reduce((sum, row) => sum + (row.spend ?? 0), 0),
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

