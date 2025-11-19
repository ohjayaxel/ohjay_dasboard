import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

function createSupabaseClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

type KpiRow = {
  tenant_id: string
  date: string
  source: string
  spend: number | null
  clicks: number | null
  conversions: number | null
  revenue: number | null
  aov: number | null
  cos: number | null
  roas: number | null
  currency: string | null
}

function aggregateKpis(insights: Array<{
  date: string
  spend: number | null
  inline_link_clicks: number | null
  purchases: number | null
  conversions: number | null
  revenue: number | null
  currency: string | null
}>) {
  const byDate = new Map<string, {
    spend: number
    clicks: number
    conversions: number
    revenue: number
    currency: string | null
  }>()

  for (const row of insights) {
    const date = row.date
    const existing = byDate.get(date) ?? {
      spend: 0,
      clicks: 0,
      conversions: 0,
      revenue: 0,
      currency: row.currency ?? null,
    }

    existing.spend += row.spend ?? 0
    existing.clicks += row.inline_link_clicks ?? 0
    existing.conversions += (row.purchases ?? 0) + (row.conversions ?? 0)
    existing.revenue += row.revenue ?? 0
    if (!existing.currency && row.currency) {
      existing.currency = row.currency
    }

    byDate.set(date, existing)
  }

  return Array.from(byDate.entries()).map(([date, values]) => {
    const aov = values.conversions > 0 ? values.revenue / values.conversions : null
    const cos = values.revenue > 0 ? values.spend / values.revenue : null
    const roas = values.spend > 0 ? values.revenue / values.spend : null

    return {
      date,
      spend: values.spend || null,
      clicks: values.clicks || null,
      conversions: values.conversions || null,
      revenue: values.revenue || null,
      aov,
      cos,
      roas,
      currency: values.currency ?? null,
    }
  })
}

async function aggregateTenantKpi(
  client: ReturnType<typeof createSupabaseClient>,
  tenantId: string,
  accountId: string,
  since: string,
  until: string,
): Promise<{ date: string; kpiRows: number }[]> {
  // Fetch insights from meta_insights_daily for the date range
  const { data: insightsData, error: insightsError } = await client
    .from('meta_insights_daily')
    .select('date, spend, inline_link_clicks, purchases, conversions, revenue, currency')
    .eq('tenant_id', tenantId)
    .eq('ad_account_id', accountId)
    .eq('level', 'account')
    .eq('action_report_time', 'impression')
    .eq('attribution_window', '1d_click')
    .eq('breakdowns_key', 'none')
    .gte('date', since)
    .lte('date', until)

  if (insightsError) {
    console.error(`Failed to fetch insights for tenant ${tenantId}: ${insightsError.message}`)
    return []
  }

  if (!insightsData || insightsData.length === 0) {
    return []
  }

  // Aggregate KPI data
  const aggregates = aggregateKpis(insightsData)

  // Map to kpi_daily format
  const kpiRows: KpiRow[] = aggregates.map((row) => ({
    tenant_id: tenantId,
    date: row.date,
    source: 'meta',
    spend: row.spend,
    clicks: row.clicks,
    conversions: row.conversions,
    revenue: row.revenue,
    aov: row.aov,
    cos: row.cos,
    roas: row.roas,
    currency: row.currency,
  }))

  // Upsert to kpi_daily
  const { error: kpiError } = await client.from('kpi_daily').upsert(kpiRows, {
    onConflict: 'tenant_id,date,source',
  })

  if (kpiError) {
    console.error(`Failed to upsert kpi_daily for tenant ${tenantId}: ${kpiError.message}`)
    return []
  }

  // Return summary of dates updated
  const dates = new Set(kpiRows.map((r) => r.date))
  return Array.from(dates).map((date) => ({
    date,
    kpiRows: kpiRows.filter((r) => r.date === date).length,
  }))
}

serve(async (req: Request) => {
  try {
    const payload = req.method === 'POST' ? await req.json() : {}
    const since = payload.since || new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) // Default: 3 days ago
    const until = payload.until || new Date().toISOString().slice(0, 10) // Default: today
    const tenantId = payload.tenantId || null // Optional: specific tenant, otherwise all

    const client = createSupabaseClient()

    // Fetch all Meta connections (or specific tenant)
    let query = client
      .from('connections')
      .select('tenant_id, meta')
      .eq('source', 'meta')
      .eq('status', 'connected')

    if (tenantId) {
      query = query.eq('tenant_id', tenantId)
    }

    const { data: connections, error: connectionsError } = await query

    if (connectionsError) {
      throw new Error(`Failed to list connections: ${connectionsError.message}`)
    }

    if (!connections || connections.length === 0) {
      return new Response(
        JSON.stringify({
          status: 'ok',
          message: 'No Meta connections found',
          processed: 0,
          results: [],
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    const results: Array<{
      tenantId: string
      accountId: string
      status: 'succeeded' | 'failed'
      datesUpdated: Array<{ date: string; kpiRows: number }>
      error?: string
    }> = []

    for (const connection of connections) {
      const tenantId = connection.tenant_id as string
      const meta = (connection.meta as Record<string, unknown>) || {}
      const adAccounts = (Array.isArray(meta.ad_accounts) ? meta.ad_accounts : []) as Array<Record<string, unknown>>

      // Get preferred account ID
      const preferredAccountId =
        typeof meta.preferred_account_id === 'string'
          ? meta.preferred_account_id
          : adAccounts.length > 0
            ? (adAccounts[0].id || adAccounts[0].account_id)?.toString().replace(/^act_/, 'act_')
            : null

      if (!preferredAccountId) {
        results.push({
          tenantId,
          accountId: 'unknown',
          status: 'failed',
          datesUpdated: [],
          error: 'No preferred account ID found',
        })
        continue
      }

      const normalizedAccountId = preferredAccountId.startsWith('act_')
        ? preferredAccountId
        : `act_${preferredAccountId}`

      try {
        const datesUpdated = await aggregateTenantKpi(client, tenantId, normalizedAccountId, since, until)
        results.push({
          tenantId,
          accountId: normalizedAccountId,
          status: 'succeeded',
          datesUpdated,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        results.push({
          tenantId,
          accountId: normalizedAccountId,
          status: 'failed',
          datesUpdated: [],
          error: message,
        })
      }
    }

    return new Response(
      JSON.stringify({
        status: 'ok',
        processed: results.length,
        since,
        until,
        results,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('aggregate-meta-kpi invocation failed:', message)
    return new Response(JSON.stringify({ status: 'error', message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})

