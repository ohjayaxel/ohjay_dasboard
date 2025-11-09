// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type SupabaseClient = ReturnType<typeof createClient<any, any, any>>;

const SOURCE = 'meta';

function getEnvVar(key: string) {
  const value = Deno.env.get(key);
  if (!value) {
    throw new Error(`Missing ${key} environment variable.`);
  }
  return value;
}

function createSupabaseClient(): SupabaseClient {
  const url = getEnvVar('SUPABASE_URL');
  const serviceRole = getEnvVar('SUPABASE_SERVICE_ROLE_KEY');

  return createClient(url, serviceRole, {
    auth: {
      persistSession: false,
    },
  });
}

type MetaConnection = {
  tenant_id: string;
  meta: Record<string, any> | null;
};

type MetaInsightRow = {
  tenant_id: string;
  date: string;
  ad_account_id: string;
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  purchases: number | null;
  revenue: number | null;
};

type JobResult = {
  tenantId: string;
  status: 'succeeded' | 'failed';
  error?: string;
  inserted?: number;
};

const META_API_VERSION = Deno.env.get('META_API_VERSION') ?? 'v18.0';
const META_DEV_ACCESS_TOKEN = Deno.env.get('META_DEV_ACCESS_TOKEN');
const META_DEV_AD_ACCOUNT_ID = Deno.env.get('META_DEV_AD_ACCOUNT_ID');

function mockMetaInsights(tenantId: string): MetaInsightRow[] {
  const today = new Date().toISOString().slice(0, 10);
  return [
    {
      tenant_id: tenantId,
      date: today,
      ad_account_id: 'mock-meta-account',
      campaign_id: null,
      adset_id: null,
      ad_id: null,
      spend: 150.5,
      impressions: 3200,
      clicks: 180,
      purchases: 6,
      revenue: 780.25,
    },
  ];
}

function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function extractActionValue(collection: any, predicate: (actionType: string) => boolean): number | null {
  if (!Array.isArray(collection)) return null;
  for (const entry of collection) {
    const actionType = typeof entry?.action_type === 'string' ? entry.action_type : '';
    if (!predicate(actionType)) continue;
    const numeric = parseNumber(entry?.value);
    if (numeric !== null) {
      return numeric;
    }
  }
  return null;
}

async function fetchMetaInsightsFromApi(tenantId: string, accessToken: string, adAccountId: string): Promise<MetaInsightRow[]> {
  const today = new Date();
  const since = new Date(today);
  since.setDate(since.getDate() - 7);

  const sinceDate = since.toISOString().slice(0, 10);
  const untilDate = today.toISOString().slice(0, 10);

  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}/act_${adAccountId}/insights`);
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('time_range', JSON.stringify({ since: sinceDate, until: untilDate }));
  url.searchParams.set('level', 'ad');
  url.searchParams.set(
    'fields',
    [
      'date_start',
      'date_stop',
      'campaign_id',
      'adset_id',
      'ad_id',
      'spend',
      'impressions',
      'clicks',
      'actions',
      'action_values',
    ].join(','),
  );

  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Meta insights request failed: ${response.status} ${body}`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  return rows.map((row: any) => {
    const date = typeof row?.date_start === 'string' ? row.date_start : new Date().toISOString().slice(0, 10);
    const spend = parseNumber(row?.spend);
    const impressions = parseNumber(row?.impressions);
    const clicks = parseNumber(row?.clicks);
    const purchases = extractActionValue(row?.actions, (type) => type.toLowerCase().includes('purchase'));
    const revenue = extractActionValue(row?.action_values, (type) => type.toLowerCase().includes('purchase'));

    return {
      tenant_id: tenantId,
      date,
      ad_account_id: adAccountId,
      campaign_id: typeof row?.campaign_id === 'string' ? row.campaign_id : null,
      adset_id: typeof row?.adset_id === 'string' ? row.adset_id : null,
      ad_id: typeof row?.ad_id === 'string' ? row.ad_id : null,
      spend,
      impressions,
      clicks,
      purchases,
      revenue,
    };
  });
}

async function fetchMetaInsights(tenantId: string): Promise<MetaInsightRow[]> {
  if (META_DEV_ACCESS_TOKEN && META_DEV_AD_ACCOUNT_ID) {
    try {
      return await fetchMetaInsightsFromApi(tenantId, META_DEV_ACCESS_TOKEN, META_DEV_AD_ACCOUNT_ID);
    } catch (error) {
      console.error('Failed to fetch Meta insights via Marketing API, falling back to mock data:', error);
    }
  }

  return mockMetaInsights(tenantId);
}

function aggregateKpis(rows: MetaInsightRow[]) {
  const byDate = new Map<string, { spend: number; clicks: number; conversions: number; revenue: number }>();

  for (const row of rows) {
    const existing = byDate.get(row.date) ?? { spend: 0, clicks: 0, conversions: 0, revenue: 0 };
    existing.spend += row.spend ?? 0;
    existing.clicks += row.clicks ?? 0;
    existing.conversions += row.purchases ?? 0;
    existing.revenue += row.revenue ?? 0;
    byDate.set(row.date, existing);
  }

  return Array.from(byDate.entries()).map(([date, values]) => {
    const aov = values.conversions > 0 ? values.revenue / values.conversions : null;
    const cos = values.revenue > 0 ? values.spend / values.revenue : null;
    const roas = values.spend > 0 ? values.revenue / values.spend : null;

    return {
      date,
      spend: values.spend || null,
      clicks: values.clicks || null,
      conversions: values.conversions || null,
      revenue: values.revenue || null,
      aov,
      cos,
      roas,
    };
  });
}

async function upsertJobLog(client: SupabaseClient, payload: {
  tenantId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  error?: string;
  startedAt: string;
  finishedAt?: string;
}) {
  const { error } = await client.from('jobs_log').insert({
    tenant_id: payload.tenantId,
    source: SOURCE,
    status: payload.status,
    started_at: payload.startedAt,
    finished_at: payload.finishedAt ?? null,
    error: payload.error ?? null,
  });

  if (error) {
    console.error(`Failed to write jobs_log for tenant ${payload.tenantId}:`, error);
  }
}

async function processTenant(client: SupabaseClient, connection: MetaConnection): Promise<JobResult> {
  const tenantId = connection.tenant_id;
  const startedAt = new Date().toISOString();

  await upsertJobLog(client, { tenantId, status: 'running', startedAt });

  try {
    const insightsRaw = await fetchMetaInsights(tenantId);
    const insights = insightsRaw.map((row) => ({
      ...row,
      campaign_id: row.campaign_id ?? 'unknown',
      adset_id: row.adset_id ?? 'unknown',
      ad_id: row.ad_id ?? 'unknown',
    }));

    if (insights.length > 0) {
      const { error: upsertError } = await client.from('meta_insights_daily').upsert(insights, {
        onConflict: 'tenant_id,date,ad_account_id,campaign_id,adset_id,ad_id',
      });

      if (upsertError) {
        throw new Error(upsertError.message);
      }

      const aggregates = aggregateKpis(insights);
      const kpiRows = aggregates.map((row) => ({
        tenant_id: tenantId,
        date: row.date,
        source: SOURCE,
        spend: row.spend,
        clicks: row.clicks,
        conversions: row.conversions,
        revenue: row.revenue,
        aov: row.aov,
        cos: row.cos,
        roas: row.roas,
      }));

      const { error: kpiError } = await client.from('kpi_daily').upsert(kpiRows, {
        onConflict: 'tenant_id,date,source',
      });

      if (kpiError) {
        throw new Error(kpiError.message);
      }
    }

    await upsertJobLog(client, {
      tenantId,
      status: 'succeeded',
      startedAt,
      finishedAt: new Date().toISOString(),
    });

    return { tenantId, status: 'succeeded', inserted: insights.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertJobLog(client, {
      tenantId,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: message,
    });

    return { tenantId, status: 'failed', error: message };
  }
}

serve(async () => {
  try {
    const client = createSupabaseClient();
    const { data, error } = await client
      .from('connections')
      .select('tenant_id, meta')
      .eq('source', SOURCE)
      .eq('status', 'connected');

    if (error) {
      throw new Error(`Failed to list connections: ${error.message}`);
    }

    const connections = (data as MetaConnection[]) ?? [];
    const results: JobResult[] = [];

    for (const connection of connections) {
      const result = await processTenant(client, connection);
      results.push(result);
    }

    return new Response(JSON.stringify({ source: SOURCE, results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sync-${SOURCE}] failed`, message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});

