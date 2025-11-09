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
  access_token_enc: unknown;
  refresh_token_enc: unknown;
  expires_at: string | null;
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
const ENCRYPTION_KEY = Deno.env.get('ENCRYPTION_KEY');

const MAX_WINDOW_DAYS = 60;

function logSyncEvent(event: string, payload: Record<string, unknown>) {
  try {
    console.log(
      JSON.stringify({
        event: `sync-meta:${event}`,
        ...payload,
      }),
    );
  } catch (error) {
    console.log(`[sync-meta:${event}]`, payload, error);
  }
}

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

let cachedCryptoKey: CryptoKey | null = null;
const textDecoder = new TextDecoder();

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

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const length = clean.length / 2;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const byte = clean.slice(i * 2, i * 2 + 2);
    bytes[i] = parseInt(byte, 16);
  }
  return bytes;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeEncryptedPayload(payload: unknown): Uint8Array | null {
  if (payload === null || payload === undefined) {
    return null;
  }

  const normalize = (bytes: Uint8Array | null): Uint8Array | null => {
    if (!bytes || bytes.length === 0) {
      return bytes;
    }
    if (bytes[0] === 0x7b) {
      try {
        const parsed = JSON.parse(textDecoder.decode(bytes));
        if (parsed && typeof parsed === 'object' && parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
          return Uint8Array.from(parsed.data);
        }
      } catch {
        // not JSON, return raw bytes
      }
    }
    return bytes;
  };

  if (payload instanceof Uint8Array) {
    return normalize(payload);
  }

  if (payload instanceof ArrayBuffer) {
    return normalize(new Uint8Array(payload));
  }

  if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView;
    return normalize(new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)));
  }

  if (typeof payload === 'object' && payload !== null && 'data' in (payload as Record<string, unknown>)) {
    const data = (payload as { data: number[] }).data;
    if (Array.isArray(data)) {
      return Uint8Array.from(data);
    }
  }

  if (typeof payload === 'string') {
    const value = payload.trim();

    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
        return Uint8Array.from(parsed.data);
      }
    } catch {
      // not JSON literal, fall through
    }

    let candidate: Uint8Array | null = null;
    if (value.startsWith('\\\\x')) {
      candidate = hexToBytes(value.replace(/^\\+x/, ''));
    } else if (value.startsWith('\\x')) {
      candidate = hexToBytes(value.slice(2));
    } else if (/^[0-9a-fA-F]+$/.test(value)) {
      candidate = hexToBytes(value);
    } else {
      try {
        candidate = base64ToBytes(value);
      } catch {
        candidate = null;
      }
    }

    return normalize(candidate);
  }

  return null;
}

function parseEncryptionKey(): Uint8Array {
  if (!ENCRYPTION_KEY) {
    throw new Error('Missing ENCRYPTION_KEY environment variable.');
  }

  const rawKey = ENCRYPTION_KEY.trim();

  if (/^[0-9a-fA-F]+$/.test(rawKey) && rawKey.length === KEY_LENGTH * 2) {
    return hexToBytes(rawKey);
  }

  if (rawKey.length === KEY_LENGTH) {
    return new TextEncoder().encode(rawKey);
  }

  return base64ToBytes(rawKey);
}

async function getAesKey(): Promise<CryptoKey> {
  if (cachedCryptoKey) {
    return cachedCryptoKey;
  }

  const keyBytes = parseEncryptionKey();

  if (keyBytes.length !== KEY_LENGTH) {
    throw new Error(`ENCRYPTION_KEY must resolve to ${KEY_LENGTH} bytes.`);
  }

  cachedCryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  return cachedCryptoKey;
}

async function decryptAccessToken(payload: unknown): Promise<string | null> {
  const encrypted = decodeEncryptedPayload(payload);
  if (!encrypted) {
    return null;
  }

  if (encrypted.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('Encrypted payload too short to contain IV, auth tag, and ciphertext.');
  }

  const iv = encrypted.subarray(0, IV_LENGTH);
  const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encrypted.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  try {
    const key = await getAesKey();
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: AUTH_TAG_LENGTH * 8 },
      key,
      combined,
    );
    return textDecoder.decode(decrypted);
  } catch (error) {
    console.error('Failed to decrypt Meta access token:', error);
    throw new Error('Unable to decrypt Meta access token for tenant.');
  }
}

function getPreferredAccountId(meta: Record<string, any>): string | null {
  if (typeof meta.selected_account_id === 'string' && meta.selected_account_id.length > 0) {
    return ensureActPrefix(meta.selected_account_id);
  }

  if (Array.isArray(meta.ad_accounts)) {
    for (const candidate of meta.ad_accounts) {
      if (candidate && (typeof candidate.id === 'string' || typeof candidate.account_id === 'string')) {
        const id = typeof candidate.id === 'string' ? candidate.id : candidate.account_id;
        return ensureActPrefix(id as string);
      }
    }
  }

  return null;
}

type InsightFetchResult = {
  rows: MetaInsightRow[];
  accountId: string;
  tokenSource: 'tenant';
  windowSince: string;
  windowUntil: string;
};

async function fetchTenantInsights(
  tenantId: string,
  connection: MetaConnection,
  connectionMeta: Record<string, any>,
  window: SyncWindow,
): Promise<InsightFetchResult> {
  const accessToken = await decryptAccessToken(connection.access_token_enc);
  const accountId = getPreferredAccountId(connectionMeta);

  if (!accessToken) {
    throw new Error('No Meta access token stored for tenant. Connect Meta to enable syncing.');
  }

  if (!accountId) {
    throw new Error('Meta connection missing selected ad account. Choose an account in the admin panel.');
  }

  const startDate = new Date(window.since);
  const endDate = new Date(window.until);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new Error('Invalid sync window for Meta insights.');
  }

  const aggregatedRows: MetaInsightRow[] = [];
  let lastUntil = window.since;

  for (
    let cursor = new Date(startDate);
    cursor <= endDate;
    cursor.setDate(cursor.getDate() + MAX_WINDOW_DAYS)
  ) {
    const chunkSinceDate = new Date(cursor);
    const chunkUntilDate = new Date(cursor);
    chunkUntilDate.setDate(chunkUntilDate.getDate() + MAX_WINDOW_DAYS - 1);
    if (chunkUntilDate > endDate) {
      chunkUntilDate.setTime(endDate.getTime());
    }

    const chunkWindow = {
      since: chunkSinceDate.toISOString().slice(0, 10),
      until: chunkUntilDate.toISOString().slice(0, 10),
    };

    const chunkRows = await fetchMetaInsightsFromApi(tenantId, accessToken, accountId, chunkWindow);
    aggregatedRows.push(
      ...chunkRows.map((row) => ({
        ...row,
        tenant_id: tenantId,
      })),
    );
    logSyncEvent('chunk_fetch', {
      tenantId,
      accountId,
      since: chunkWindow.since,
      until: chunkWindow.until,
      rows: chunkRows.length,
    });
    lastUntil = chunkWindow.until;

    if (chunkUntilDate >= endDate) {
      break;
    }
  }

  return {
    rows: aggregatedRows,
    accountId,
    tokenSource: 'tenant',
    windowSince: window.since,
    windowUntil: lastUntil,
  };
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

function fillMissingAggregateDates(
  aggregates: ReturnType<typeof aggregateKpis>,
  windowSince: string,
  windowUntil: string,
) {
  const aggregateByDate = new Map(aggregates.map((entry) => [entry.date, entry]));
  const filled: ReturnType<typeof aggregateKpis> = [];

  const start = new Date(windowSince);
  const end = new Date(windowUntil);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return aggregates;
  }

  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const key = cursor.toISOString().slice(0, 10);
    const existing = aggregateByDate.get(key);

    if (existing) {
      filled.push(existing);
      continue;
    }

    filled.push({
      date: key,
      spend: 0,
      clicks: 0,
      conversions: 0,
      revenue: 0,
      aov: null,
      cos: null,
      roas: null,
    });
  }

  return filled;
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
    const insightsResult = await fetchTenantInsights(tenantId, connection, connectionMeta ?? {}, syncWindow);
    const insightsRaw = insightsResult.rows.map((row) => ({
      ...row,
      tenant_id: tenantId,
    }));
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
      const normalizedAggregates = fillMissingAggregateDates(
        aggregates,
        insightsResult.windowSince,
        insightsResult.windowUntil,
      );
      logSyncEvent('aggregates', {
        tenantId,
        accountId: insightsResult.accountId,
        windowSince: insightsResult.windowSince,
        windowUntil: insightsResult.windowUntil,
        aggregateDates: normalizedAggregates.length,
        nonZeroDays: normalizedAggregates.filter(
          (row) => (row.spend ?? 0) > 0 || (row.revenue ?? 0) > 0 || (row.conversions ?? 0) > 0,
        ).length,
      });
      const kpiRows = normalizedAggregates.map((row) => ({
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

    connectionMeta.last_synced_at = finishedAt;
    connectionMeta.last_synced_range = {
      since: insightsResult.windowSince,
      until: insightsResult.windowUntil,
    };
    connectionMeta.last_synced_account_id = insightsResult.accountId;
    connectionMeta.last_synced_token_source = insightsResult.tokenSource;

    const { error: connectionUpdateError } = await client
      .from('connections')
      .update({
        meta: connectionMeta,
        updated_at: finishedAt,
      })
      .eq('tenant_id', tenantId)
      .eq('source', SOURCE);

    logSyncEvent('sync_complete', {
      tenantId,
      accountId: insightsResult.accountId,
      rowsInserted: insights.length,
      windowSince: insightsResult.windowSince,
      windowUntil: insightsResult.windowUntil,
    });

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
      .select('tenant_id, access_token_enc, refresh_token_enc, expires_at, meta')
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

