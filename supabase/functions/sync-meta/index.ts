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

type SyncWindow = {
  since: string;
  until: string;
};

function mockMetaInsights(tenantId: string, window: SyncWindow): MetaInsightRow[] {
  const start = new Date(window.since);
  const end = new Date(window.until);
  const rows: MetaInsightRow[] = [];

  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const isoDate = cursor.toISOString().slice(0, 10);
    const multiplier = 1 + (cursor.getDate() % 5) * 0.1;
    rows.push({
      tenant_id: tenantId,
      date: isoDate,
      ad_account_id: 'mock-meta-account',
      campaign_id: null,
      adset_id: null,
      ad_id: null,
      spend: Math.round(120 * multiplier * 100) / 100,
      impressions: Math.round(2500 * multiplier),
      clicks: Math.round(150 * multiplier),
      purchases: Math.round(4 * multiplier),
      revenue: Math.round(600 * multiplier * 100) / 100,
    });
  }

  if (rows.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    rows.push({
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
    });
  }

  return rows;
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

function ensureActPrefix(accountId: string): string {
  return accountId.startsWith('act_') ? accountId : `act_${accountId}`;
}

function clampDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function resolveSyncWindow(meta: Record<string, any> | null): SyncWindow {
  const today = clampDate(new Date());
  const defaultSince = new Date(today);
  defaultSince.setDate(defaultSince.getDate() - 7);

  let sinceDate = defaultSince;
  let syncStartDate: Date | null = null;

  if (meta && typeof meta.sync_start_date === 'string') {
    const parsed = new Date(meta.sync_start_date);
    if (!Number.isNaN(parsed.getTime())) {
      syncStartDate = clampDate(parsed);
      sinceDate = syncStartDate;
    }
  }

  const lastRange = meta && typeof meta.last_synced_range === 'object' ? meta.last_synced_range as Record<string, any> : null;                                 
  if (lastRange && typeof lastRange.until === 'string') {
    const parsed = new Date(lastRange.until);
    if (!Number.isNaN(parsed.getTime())) {
      parsed.setDate(parsed.getDate() + 1);
      const candidate = clampDate(parsed);
      if ((!syncStartDate || candidate >= syncStartDate) && candidate > sinceDate) {
        sinceDate = candidate;
      }
    }
  } else if (meta && typeof meta.last_synced_at === 'string') {
    const parsed = new Date(meta.last_synced_at);
    if (!Number.isNaN(parsed.getTime())) {
      const candidate = clampDate(parsed);
      if ((!syncStartDate || candidate >= syncStartDate) && candidate > sinceDate) {
        sinceDate = candidate;
      }
    }
  }

  if (sinceDate > today) {
    sinceDate = new Date(today);
  }

  const since = sinceDate.toISOString().slice(0, 10);
  const until = today.toISOString().slice(0, 10);

  return { since, until };
}

async function fetchMetaInsightsFromApi(
  tenantId: string,
  accessToken: string,
  adAccountId: string,
  window: SyncWindow,
): Promise<MetaInsightRow[]> {
  const normalizedAccountId = ensureActPrefix(adAccountId);
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}/${normalizedAccountId}/insights`);
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('time_range', JSON.stringify(window));
  url.searchParams.set('level', 'ad');
  url.searchParams.set('time_increment', '1');
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
      ad_account_id: normalizedAccountId,
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

async function fetchMetaInsights(
  tenantId: string,
  window: SyncWindow,
  connectionMeta: Record<string, any> | null,
): Promise<MetaInsightRow[]> {
  const selectedAccount =
    connectionMeta && typeof connectionMeta.selected_account_id === 'string'
      ? connectionMeta.selected_account_id as string
      : null;

  const fallbackAccount =
    connectionMeta && Array.isArray(connectionMeta.ad_accounts)
      ? connectionMeta.ad_accounts.find((account: any) => typeof account?.id === 'string' || typeof account?.account_id === 'string')
      : null;

  const resolvedAccount =
    selectedAccount ??
    (fallbackAccount?.id as string | undefined) ??
    (fallbackAccount?.account_id as string | undefined) ??
    META_DEV_AD_ACCOUNT_ID ??
    null;

  if (META_DEV_ACCESS_TOKEN && META_DEV_AD_ACCOUNT_ID) {
    try {
      const accountId = resolvedAccount ?? META_DEV_AD_ACCOUNT_ID;
      return await fetchMetaInsightsFromApi(tenantId, META_DEV_ACCESS_TOKEN, accountId, window);
    } catch (error) {
      console.error('Failed to fetch Meta insights via Marketing API, falling back to mock data:', error);
    }
  }

  return mockMetaInsights(tenantId, window);
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
  const connectionMeta: Record<string, any> =
    connection.meta && typeof connection.meta === 'object' ? { ...(connection.meta as Record<string, any>) } : {};
  const startedAt = new Date().toISOString();
  const syncWindow = resolveSyncWindow(connectionMeta ?? null);

  await upsertJobLog(client, { tenantId, status: 'running', startedAt });

  try {
    const insightsRaw = await fetchMetaInsights(tenantId, syncWindow, connectionMeta ?? null);
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

    const finishedAt = new Date().toISOString();

    const { error: connectionUpdateError } = await client
      .from('connections')
      .update({
        meta: {
          ...connectionMeta,
          last_synced_at: finishedAt,
          last_synced_range: syncWindow,
        },
        updated_at: finishedAt,
      })
      .eq('tenant_id', tenantId)
      .eq('source', SOURCE);

    if (connectionUpdateError) {
      console.error(`Failed to update connection metadata for tenant ${tenantId}:`, connectionUpdateError);
    }

    await upsertJobLog(client, {
      tenantId,
      status: 'succeeded',
      startedAt,
      finishedAt,
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

