// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type SupabaseClient = ReturnType<typeof createClient<any, any, any>>;

const SOURCE = 'google_ads';
const GOOGLE_ADS_API_VERSION = 'v21';
const GOOGLE_ADS_ENDPOINT = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const INCREMENTAL_WINDOW_DAYS = 30; // Sync last 30 days by default

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
    auth: { persistSession: false },
  });
}

type GoogleConnection = {
  tenant_id: string;
  access_token_enc: unknown;
  refresh_token_enc: unknown;
  expires_at: string | null;
  meta: Record<string, any> | null;
};

type GoogleInsightRow = {
  tenant_id: string;
  date: string;
  customer_id: string;
  campaign_id: string | null;
  adgroup_id: string | null;
  ad_id: string | null;
  cost_micros: number | null;
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  revenue: number | null;
};

type JobResult = {
  tenantId: string;
  status: 'succeeded' | 'failed';
  error?: string;
  inserted?: number;
};

type BufferJson = {
  type: 'Buffer';
  data: number[];
};

// Encryption/decryption utilities (similar to sync-meta)
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
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

  if (payload instanceof Uint8Array) {
    return payload;
  }

  if (payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }

  if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }

  if (typeof payload === 'object' && payload !== null && 'data' in payload) {
    const data = (payload as { data: number[] }).data;
    if (Array.isArray(data)) {
      return Uint8Array.from(data);
    }
  }

  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object' && parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
        return Uint8Array.from(parsed.data);
      }
    } catch {
      // not JSON
    }

    if (payload.startsWith('\\x') || payload.startsWith('0x')) {
      const hexValue = payload.replace(/^(\\x|0x)/, '');
      return hexToBytes(hexValue);
    }
    if (/^[0-9a-fA-F]+$/.test(payload)) {
      return hexToBytes(payload);
    }
    try {
      return base64ToBytes(payload);
    } catch {
      return null;
    }
  }

  return null;
}

let cachedCryptoKey: CryptoKey | null = null;
const textDecoder = new TextDecoder();

function parseEncryptionKey(): Uint8Array {
  const rawKey = getEnvVar('ENCRYPTION_KEY').trim();

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
    console.error('Failed to decrypt Google Ads access token:', error);
    throw new Error('Unable to decrypt Google Ads access token for tenant.');
  }
}

async function decryptRefreshToken(payload: unknown): Promise<string | null> {
  return decryptAccessToken(payload); // Same decryption logic
}

// Token refresh function
async function refreshGoogleAdsToken(
  client: SupabaseClient,
  connection: GoogleConnection,
): Promise<string | null> {
  const refreshTokenEnc = connection.refresh_token_enc;
  if (!refreshTokenEnc) {
    return null;
  }

  const refreshToken = await decryptRefreshToken(refreshTokenEnc);
  if (!refreshToken) {
    return null;
  }

  const googleClientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const googleClientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');

  if (!googleClientId || !googleClientSecret) {
    console.warn('[sync-googleads] Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET for token refresh');
    return null;
  }

  try {
    const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[sync-googleads] Token refresh failed: ${res.status} ${body}`);
      return null;
    }

    const tokenData = await res.json();
    // Note: We don't update the connection here - that should be done by refreshGoogleAdsTokenIfNeeded
    // in lib/integrations/googleads.ts. This is just for getting a fresh token for this sync.
    return tokenData.access_token || null;
  } catch (error) {
    console.error('[sync-googleads] Token refresh exception:', error);
    return null;
  }
}

// Get access token, refreshing if needed
async function getAccessToken(client: SupabaseClient, connection: GoogleConnection): Promise<string | null> {
  // Check if token is expired or about to expire
  const expiresAt = connection.expires_at ? new Date(connection.expires_at).getTime() : null;
  const now = Date.now();
  const fiveMinutesFromNow = now + 5 * 60 * 1000;

  let accessToken: string | null = null;

  if (expiresAt && expiresAt > fiveMinutesFromNow) {
    // Token is still valid, decrypt and use it
    accessToken = await decryptAccessToken(connection.access_token_enc);
  } else {
    // Token expired or about to expire, try to refresh
    console.log(`[sync-googleads] Token expired or expiring soon, attempting refresh for tenant ${connection.tenant_id}`);
    accessToken = await refreshGoogleAdsToken(client, connection);
  }

  return accessToken;
}

function microsToSpend(micros: number | null): number {
  if (!micros) return 0;
  return micros / 1_000_000;
}

function aggregateKpis(rows: GoogleInsightRow[]) {
  const byDate = new Map<string, { spend: number; clicks: number; conversions: number; revenue: number }>();

  for (const row of rows) {
    const existing = byDate.get(row.date) ?? { spend: 0, clicks: 0, conversions: 0, revenue: 0 };
    existing.spend += microsToSpend(row.cost_micros ?? 0);
    existing.clicks += row.clicks ?? 0;
    existing.conversions += row.conversions ?? 0;
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

function getCustomerId(meta: Record<string, any> | null): string | null {
  if (!meta) return null;

  // Try selected_customer_id first
  if (typeof meta.selected_customer_id === 'string' && meta.selected_customer_id.length > 0) {
    return meta.selected_customer_id.replace(/-/g, ''); // Remove dashes for API calls
  }

  // Fall back to customer_id
  if (typeof meta.customer_id === 'string' && meta.customer_id.length > 0) {
    return meta.customer_id.replace(/-/g, '');
  }

  // Fall back to login_customer_id
  if (typeof meta.login_customer_id === 'string' && meta.login_customer_id.length > 0) {
    return meta.login_customer_id.replace(/-/g, '');
  }

  return null;
}

function formatCustomerIdForDisplay(customerId: string): string {
  // Format as XXX-XXX-XXXX if it's 10 digits
  if (/^\d{10}$/.test(customerId)) {
    return `${customerId.slice(0, 3)}-${customerId.slice(3, 6)}-${customerId.slice(6)}`;
  }
  return customerId;
}

function buildGaqlQuery(customerId: string, startDate: string, endDate: string): string {
  // Google Ads Query Language (GAQL) query for insights
  // Fetch metrics grouped by date, campaign, ad group, and ad
  return `
    SELECT
      segments.date,
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      ad_group_ad.ad.id,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.value_per_conversion
    FROM ad_group_ad
    WHERE segments.date >= '${startDate}' AND segments.date <= '${endDate}'
    AND campaign.status = 'ENABLED'
    AND ad_group.status = 'ENABLED'
    AND ad_group_ad.ad.status = 'ENABLED'
    ORDER BY segments.date DESC
  `.trim();
}

async function fetchGoogleAdsInsights(
  accessToken: string,
  customerId: string,
  startDate: string,
  endDate: string,
): Promise<GoogleInsightRow[]> {
  const developerToken = Deno.env.get('GOOGLE_DEVELOPER_TOKEN');
  if (!developerToken) {
    throw new Error('Missing GOOGLE_DEVELOPER_TOKEN environment variable');
  }

  const query = buildGaqlQuery(customerId, startDate, endDate);
  const url = `${GOOGLE_ADS_ENDPOINT}/customers/${customerId}/googleAds:searchStream`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': developerToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google Ads API error: ${response.status} ${errorBody}`);
  }

  // Google Ads searchStream returns results in chunks
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body reader available');
  }

  const decoder = new TextDecoder();
  const insights: GoogleInsightRow[] = [];
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse JSON objects from the stream (may contain multiple JSON objects)
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          try {
            const chunk = JSON.parse(line);
            if (chunk.results && Array.isArray(chunk.results)) {
              for (const result of chunk.results) {
                const row = parseGoogleAdsResult(result);
                if (row) {
                  insights.push(row);
                }
              }
            }
          } catch (e) {
            console.warn('[sync-googleads] Failed to parse JSON chunk:', e, line);
          }
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer);
        if (chunk.results && Array.isArray(chunk.results)) {
          for (const result of chunk.results) {
            const row = parseGoogleAdsResult(result);
            if (row) {
              insights.push(row);
            }
          }
        }
      } catch (e) {
        console.warn('[sync-googleads] Failed to parse final buffer:', e);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return insights;
}

function parseGoogleAdsResult(result: any): GoogleInsightRow | null {
  // Extract data from Google Ads API response
  // Note: This is a simplified parser - adjust based on actual API response structure
  try {
    const segments = result.segments || {};
    const campaign = result.campaign || {};
    const adGroup = result.ad_group || {};
    const adGroupAd = result.ad_group_ad || {};
    const ad = adGroupAd?.ad || {};
    const metrics = result.metrics || {};

    const date = segments.date;
    if (!date) {
      return null; // Skip rows without date
    }

    // Note: We don't have tenant_id in the result, so we'll set it in processTenant
    return {
      tenant_id: '', // Will be set by caller
      date: date,
      customer_id: '', // Will be set by caller
      campaign_id: campaign.id ? String(campaign.id) : null,
      adgroup_id: adGroup.id ? String(adGroup.id) : null,
      ad_id: ad.id ? String(ad.id) : null,
      cost_micros: metrics.cost_micros ? Number(metrics.cost_micros) : null,
      impressions: metrics.impressions ? Number(metrics.impressions) : null,
      clicks: metrics.clicks ? Number(metrics.clicks) : null,
      conversions: metrics.conversions ? Number(metrics.conversions) : null,
      revenue: metrics.value_per_conversion && metrics.conversions
        ? Number(metrics.value_per_conversion) * Number(metrics.conversions)
        : null,
    };
  } catch (error) {
    console.warn('[sync-googleads] Failed to parse result:', error);
    return null;
  }
}

async function processTenant(client: SupabaseClient, connection: GoogleConnection): Promise<JobResult> {
  const tenantId = connection.tenant_id;
  const startedAt = new Date().toISOString();

  let jobLogInserted = false;
  try {
    await upsertJobLog(client, { tenantId, status: 'running', startedAt });
    jobLogInserted = true;
  } catch (logError) {
    console.error(`Failed to insert initial job log for tenant ${tenantId}:`, logError);
    // Continue anyway - we'll try to update it later
  }

  try {
    // Get access token (refresh if needed)
    const accessToken = await getAccessToken(client, connection);
    if (!accessToken) {
      throw new Error('No access token available. Token may be expired and refresh failed.');
    }

    // Get customer ID from connection meta
    const customerId = getCustomerId(connection.meta);
    if (!customerId) {
      throw new Error(
        'No customer ID found in connection meta. Please select a customer account in the integrations settings.',
      );
    }

    // Calculate date range (last 30 days by default, or use sync_start_date from meta)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const syncStartDate = connection.meta?.sync_start_date
      ? new Date(connection.meta.sync_start_date)
      : null;
    
    let startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (INCREMENTAL_WINDOW_DAYS - 1));

    if (syncStartDate && syncStartDate < startDate) {
      startDate = new Date(syncStartDate);
    }

    const endDate = new Date(today);

    // Format dates as YYYY-MM-DD for Google Ads API
    const startDateStr = startDate.toISOString().slice(0, 10);
    const endDateStr = endDate.toISOString().slice(0, 10);

    console.log(
      `[sync-googleads] Fetching insights for tenant ${tenantId}, customer ${formatCustomerIdForDisplay(customerId)}, date range: ${startDateStr} to ${endDateStr}`,
    );

    // Fetch insights from Google Ads API
    const rawInsights = await fetchGoogleAdsInsights(accessToken, customerId, startDateStr, endDateStr);

    // Add tenant_id and customer_id to each row
    const customerIdDisplay = formatCustomerIdForDisplay(customerId);
    const insights: GoogleInsightRow[] = rawInsights.map((row) => ({
      ...row,
      tenant_id: tenantId,
      customer_id: customerIdDisplay,
    }));

    console.log(`[sync-googleads] Fetched ${insights.length} insight rows for tenant ${tenantId}`);

    if (insights.length > 0) {
      // Upsert insights to database
      const { error: upsertError } = await client.from('google_insights_daily').upsert(insights, {
        onConflict: 'tenant_id,date,customer_id,campaign_id,adgroup_id,ad_id',
      });

      if (upsertError) {
        throw new Error(`Failed to upsert insights: ${upsertError.message}`);
      }

      // Aggregate KPIs by date
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

      // Upsert aggregated KPIs
      const { error: kpiError } = await client.from('kpi_daily').upsert(kpiRows, {
        onConflict: 'tenant_id,date,source',
      });

      if (kpiError) {
        throw new Error(`Failed to upsert KPIs: ${kpiError.message}`);
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
    console.error(`[sync-googleads] Error processing tenant ${tenantId}:`, message);

    await upsertJobLog(client, {
      tenantId,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: message,
    });

    return { tenantId, status: 'failed', error: message };
  } finally {
    // Ensure job log is always updated, even if the try-catch above fails
    if (jobLogInserted) {
      try {
        // Check if job log was already updated (has finished_at)
        const { data: existingJob } = await client
          .from('jobs_log')
          .select('finished_at')
          .eq('tenant_id', tenantId)
          .eq('source', SOURCE)
          .eq('status', 'running')
          .eq('started_at', startedAt)
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        // Only update if still in running status
        if (existingJob && !existingJob.finished_at) {
          await upsertJobLog(client, {
            tenantId,
            status: 'failed',
            startedAt,
            finishedAt: new Date().toISOString(),
            error: 'Job execution was interrupted or failed unexpectedly',
          });
        }
      } catch (finalError) {
        // Last resort - log but don't throw
        console.error(`Failed to update job log in finally block for tenant ${tenantId}:`, finalError);
      }
    }
  }
}

serve(async (req) => {
  try {
    const client = createSupabaseClient();

    // Parse optional payload (for tenant-specific syncs)
    let payload: { tenantId?: string } = {};
    try {
      if (req.body) {
        const bodyText = await req.text();
        if (bodyText) {
          payload = JSON.parse(bodyText);
        }
      }
    } catch {
      // Ignore parse errors, use default payload
    }

    // Fetch connections
    let query = client
      .from('connections')
      .select('tenant_id, access_token_enc, refresh_token_enc, expires_at, meta')
      .eq('source', SOURCE)
      .eq('status', 'connected');

    // If tenantId is specified in payload, filter to that tenant
    if (payload.tenantId) {
      query = query.eq('tenant_id', payload.tenantId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to list connections: ${error.message}`);
    }

    const connections = (data as GoogleConnection[]) ?? [];
    console.log(`[sync-googleads] Found ${connections.length} connected Google Ads tenant(s)`);

    if (connections.length === 0) {
      return new Response(
        JSON.stringify({ source: SOURCE, message: 'No connected Google Ads tenants found', results: [] }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

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
