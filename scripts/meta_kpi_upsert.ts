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
    .select('tenant_id, date, spend, inline_link_clicks, purchases, conversions, revenue, currency')
    .eq('tenant_id', args.tenant)
    .eq('ad_account_id', args.account)
    .eq('level', 'account')
    .eq('action_report_time', 'conversion')
    .eq('attribution_window', '1d_click')
    .in('breakdowns_key', ['none', 'country_priority'])
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
      results: number
      revenue: number
      currency: string | null
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
      currency: (row as { currency?: string | null })?.currency ?? null,
    }

    existing.spend += Number(row.spend ?? 0)
    const linkClicks = Number((row as { inline_link_clicks?: number | null }).inline_link_clicks ?? 0)
    existing.clicks += linkClicks
    const totalResults =
      Number((row as { purchases?: number | null }).purchases ?? 0) + Number(row.conversions ?? 0)
    existing.conversions += totalResults
    existing.revenue += Number(row.revenue ?? 0)
    if (!existing.currency && (row as { currency?: string | null })?.currency) {
      existing.currency = (row as { currency?: string | null }).currency ?? null
    }

    byDate.set(date, existing)
  }

  const defaultCurrency = Array.from(byDate.values()).find((entry) => entry.currency)?.currency ?? null

  const rows: {
    tenant_id: string
    date: string
    source: 'meta'
    spend: number | null
    clicks: number | null
    conversions: number | null
    revenue: number | null
    aov: number | null
    cos: number | null
    roas: number | null
    currency: string | null
  }[] = []

  const startDate = new Date(since)
  const endDate = new Date(until)

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new Error('Invalid date range provided.')
  }

  for (const cursor = new Date(startDate); cursor <= endDate; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const key = cursor.toISOString().slice(0, 10)
    const aggregate = byDate.get(key)
    const tenantId = aggregate?.tenantId ?? args.tenant
    const spend = aggregate?.spend ?? 0
    const clicks = aggregate?.clicks ?? 0
    const conversions = aggregate?.conversions ?? 0
    const revenue = aggregate?.revenue ?? 0
    const rowCurrency = aggregate?.currency ?? defaultCurrency ?? null

    rows.push({
      tenant_id: tenantId,
      date: key,
      source: 'meta',
      spend: spend || null,
      clicks: clicks || null,
      conversions: conversions || null,
      revenue: revenue || null,
      aov: conversions > 0 ? revenue / conversions : null,
      cos: revenue > 0 ? spend / revenue : null,
      roas: spend > 0 ? revenue / spend : null,
      currency: rowCurrency,
    })
  }

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

