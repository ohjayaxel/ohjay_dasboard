// deno-lint-ignore-file no-explicit-any
/**
 * Google Ads Sync Edge Function
 * 
 * Syncs Google Ads performance data from geographic_view into google_ads_geographic_daily table.
 * 
 * MANUAL TESTING:
 * 
 * 1. Manual date window test:
 *    curl -X POST "https://<PROJECT_REF>.functions.supabase.co/sync-googleads" \
 *      -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
 *      -H "Content-Type: application/json" \
 *      -d '{
 *        "tenantId": "skinome",
 *        "mode": "manual_test",
 *        "dateFrom": "2025-12-09",
 *        "dateTo": "2025-12-10"
 *      }'
 * 
 * 2. Hourly test (syncs last hour based on last_hourly_sync_at):
 *    curl -X POST "https://<PROJECT_REF>.functions.supabase.co/sync-googleads" \
 *      -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
 *      -H "Content-Type: application/json" \
 *      -d '{
 *        "tenantId": "skinome",
 *        "mode": "hourly_test"
 *      }'
 * 
 * 3. Daily test (syncs last day based on last_daily_sync_at):
 *    curl -X POST "https://<PROJECT_REF>.functions.supabase.co/sync-googleads" \
 *      -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
 *      -H "Content-Type: application/json" \
 *      -d '{
 *        "tenantId": "skinome",
 *        "mode": "daily_test"
 *      }'
 * 
 * SQL VALIDATION QUERIES:
 * 
 * -- Check data exists for tenant:
 * SELECT
 *   COUNT(*) AS rows_inserted,
 *   MIN(date) AS first_date,
 *   MAX(date) AS last_date,
 *   COUNT(DISTINCT customer_id) AS customer_count,
 *   COUNT(DISTINCT campaign_id) AS campaign_count
 * FROM google_ads_geographic_daily
 * WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'skinome');
 * 
 * -- Check by customer_id:
 * SELECT
 *   customer_id,
 *   COUNT(*) AS rows_inserted,
 *   MIN(date) AS first_date,
 *   MAX(date) AS last_date
 * FROM google_ads_geographic_daily
 * WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'skinome')
 * GROUP BY customer_id;
 * 
 * -- Manually set sync timestamps for testing (in connections.meta):
 * UPDATE connections
 * SET meta = jsonb_set(
 *   COALESCE(meta, '{}'::jsonb),
 *   '{last_hourly_sync_at}',
 *   to_jsonb(NOW() - INTERVAL '2 hours')
 * )
 * WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'skinome')
 *   AND source = 'google_ads';
 * 
 * UPDATE connections
 * SET meta = jsonb_set(
 *   COALESCE(meta, '{}'::jsonb),
 *   '{last_daily_sync_at}',
 *   to_jsonb(DATE '2025-12-08')
 * )
 * WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'skinome')
 *   AND source = 'google_ads';
 */

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
const INITIAL_SYNC_DAYS = 30; // Initial sync: last 30 days

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

type GeographicDailyRow = {
  tenant_id: string;
  customer_id: string;
  date: string;
  campaign_id: string;
  campaign_name: string | null;
  ad_group_id: string;
  ad_group_name: string | null;
  country_criterion_id: string;
  country_code: string | null;
  location_type: 'AREA_OF_INTEREST' | 'LOCATION_OF_PRESENCE';
  impressions: number;
  clicks: number;
  cost_micros: number;
  conversions: number;
  conversions_value: number;
  conversion_action_id: string | null;
};

type JobResult = {
  tenantId: string;
  status: 'succeeded' | 'failed';
  error?: string;
  inserted?: number;
  mode?: string;
  syncStart?: string;
  syncEnd?: string;
  apiRows?: number;
};

type SyncMode = 'manual_test' | 'hourly_test' | 'daily_test' | undefined;

type SyncRequestPayload = {
  tenantId?: string;
  mode?: SyncMode;
  dateFrom?: string;
  dateTo?: string;
};

type SyncWindow = {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
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

    // Handle hex-encoded strings (e.g., \x7b2274797065223a... which is hex-encoded JSON)
    if (payload.startsWith('\\x') || payload.startsWith('0x')) {
      const hexValue = payload.replace(/^(\\x|0x)/, '');
      const decodedHex = hexToBytes(hexValue);
      
      // Check if decoded hex is actually a JSON string containing Buffer data
      try {
        const jsonString = new TextDecoder().decode(decodedHex);
        if (jsonString.startsWith('{') && jsonString.includes('"type":"Buffer"')) {
          const parsed = JSON.parse(jsonString);
          if (parsed && typeof parsed === 'object' && parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
            return Uint8Array.from(parsed.data);
          }
        }
      } catch {
        // Not JSON, treat as raw bytes
      }
      
      return decodedHex;
    }
    if (/^[0-9a-fA-F]+$/.test(payload)) {
      const decodedHex = hexToBytes(payload);
      
      // Check if decoded hex is actually a JSON string containing Buffer data
      try {
        const jsonString = new TextDecoder().decode(decodedHex);
        if (jsonString.startsWith('{') && jsonString.includes('"type":"Buffer"')) {
          const parsed = JSON.parse(jsonString);
          if (parsed && typeof parsed === 'object' && parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
            return Uint8Array.from(parsed.data);
          }
        }
      } catch {
        // Not JSON, treat as raw bytes
      }
      
      return decodedHex;
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
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('Failed to decrypt Google Ads access token:', errorMsg);
    
    // Provide helpful error message if decryption fails
    // This usually means ENCRYPTION_KEY doesn't match the key used to encrypt the token
    throw new Error(
      'Unable to decrypt Google Ads access token. This usually means ENCRYPTION_KEY in Edge Function environment ' +
      'does not match the key used when the token was encrypted. Please re-authenticate Google Ads connection ' +
      'by disconnecting and reconnecting in the integrations settings.'
    );
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

/**
 * Get the selected child customer ID from connection meta.
 * This is the account we will query for reporting data.
 * 
 * Returns null if not set or if the selected account is a manager account.
 */
function getSelectedCustomerId(meta: Record<string, any> | null): string | null {
  if (!meta) return null;

  // Try selected_customer_id first (new structure)
  if (typeof meta.selected_customer_id === 'string' && meta.selected_customer_id.length > 0) {
    const customerId = meta.selected_customer_id.replace(/-/g, ''); // Remove dashes for API calls
    
    // Verify this is NOT a manager account
    const availableAccounts = Array.isArray(meta.available_customers) ? meta.available_customers : [];
    const selectedAccount = availableAccounts.find((a: any) => {
      const aId = String(a.customer_id || '').replace(/-/g, '');
      return aId === customerId;
    });
    
    if (selectedAccount && selectedAccount.is_manager === true) {
      console.warn(`[sync-googleads] Selected customer ${customerId} is a manager account - cannot query reporting data from it`);
      return null;
    }
    
    return customerId;
  }

  // Fall back to customer_id (legacy)
  if (typeof meta.customer_id === 'string' && meta.customer_id.length > 0) {
    return meta.customer_id.replace(/-/g, '');
  }

  return null;
}

/**
 * Get the manager customer ID (MCC account) to use as login-customer-id header.
 * This is required when querying child accounts through a manager account.
 * 
 * Returns manager_customer_id if available, otherwise falls back to selected_customer_id.
 */
function getManagerCustomerId(meta: Record<string, any> | null): string | null {
  if (!meta) return null;

  // Use manager_customer_id if set (new structure)
  if (typeof meta.manager_customer_id === 'string' && meta.manager_customer_id.length > 0) {
    return meta.manager_customer_id.replace(/-/g, '');
  }

  // Fall back to login_customer_id (legacy)
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

/**
 * Build GAQL query for geographic_view.
 * 
 * This query uses geographic_view which provides country + campaign + ad_group + metrics
 * in a single pass, eliminating the need for multiple queries or joins.
 * 
 * Based on Phase 2 Diagnostic Report: geographic_view supports campaign.id and ad_group.id fields.
 */
function buildGeographicViewQuery(startDate: string, endDate: string): string {
  return `
SELECT
  segments.date,
  customer.id,
  campaign.id,
  campaign.name,
  ad_group.id,
  ad_group.name,
  geographic_view.country_criterion_id,
  geographic_view.location_type,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros,
  metrics.conversions,
  metrics.conversions_value
FROM geographic_view
WHERE segments.date >= '${startDate}' AND segments.date <= '${endDate}'
  AND campaign.status != 'REMOVED'
  AND ad_group.status != 'REMOVED'
ORDER BY segments.date DESC, campaign.id, ad_group.id, geographic_view.country_criterion_id
LIMIT 10000
  `.trim();
}

/**
 * Build GAQL query for conversion_action data.
 * 
 * This query fetches conversion_action per date, campaign, ad_group, and country.
 * Note: segments.conversion_action cannot be used with clicks, cost_micros, or impressions,
 * so we query it separately and merge with geographic data.
 */
function buildConversionActionQuery(startDate: string, endDate: string): string {
  return `
SELECT
  segments.date,
  customer.id,
  campaign.id,
  ad_group.id,
  geographic_view.country_criterion_id,
  geographic_view.location_type,
  segments.conversion_action,
  metrics.conversions,
  metrics.conversions_value
FROM geographic_view
WHERE segments.date >= '${startDate}' AND segments.date <= '${endDate}'
  AND campaign.status != 'REMOVED'
  AND ad_group.status != 'REMOVED'
  AND metrics.conversions > 0
ORDER BY segments.date DESC, campaign.id, ad_group.id, geographic_view.country_criterion_id
LIMIT 10000
  `.trim();
}

/**
 * Build GAQL query for geo_target_constant lookup.
 * 
 * Fetches country code mappings for all countries.
 * This can be cached as it changes infrequently.
 * 
 * TODO: Consider persisting this into a reference table for performance.
 */
function buildGeoTargetConstantQuery(): string {
  return `
SELECT
  geo_target_constant.id,
  geo_target_constant.name,
  geo_target_constant.country_code,
  geo_target_constant.target_type,
  geo_target_constant.status
FROM geo_target_constant
WHERE geo_target_constant.target_type = 'Country'
  `.trim();
}

/**
 * Extract conversion action ID from resource name.
 * 
 * Format: "customers/{customerId}/conversionActions/{actionId}"
 * Returns: "{actionId}" or null if not parseable
 */
function extractConversionActionId(resourceName: string | null | undefined): string | null {
  if (!resourceName || typeof resourceName !== 'string') {
    return null;
  }

  const match = resourceName.match(/conversionActions\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Parse streaming JSON response from Google Ads searchStream API.
 * 
 * searchStream returns newline-delimited JSON where each line contains:
 * { results: [{ ... }] } or sometimes just { ... }
 * Or may return a JSON array directly in v21
 */
async function parseSearchStreamResponse(response: Response): Promise<any[]> {
  const text = await response.text();
  
  // Try parsing as JSON array first (v21 sometimes returns arrays)
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const allResults: any[] = [];
      for (const item of parsed) {
        if (item.results && Array.isArray(item.results)) {
          allResults.push(...item.results);
        } else {
          allResults.push(item);
        }
      }
      return allResults;
    }
    
    // Single object with results array
    if (parsed.results && Array.isArray(parsed.results)) {
      return parsed.results;
    }
    
    // Single result object
    return [parsed];
  } catch {
    // Fallback: parse as newline-delimited JSON
    const lines = text.trim().split('\n').filter(line => line.trim());
    const allResults: any[] = [];
    
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.results && Array.isArray(parsed.results)) {
          allResults.push(...parsed.results);
        } else {
          allResults.push(parsed);
        }
      } catch {
        // Skip invalid lines
      }
    }
    
    return allResults;
  }
}

/**
 * Fetch geographic insights from Google Ads API using geographic_view.
 */
async function fetchGeographicInsights(
  accessToken: string,
  customerId: string,
  startDate: string,
  endDate: string,
  loginCustomerId: string | null,
): Promise<any[]> {
  const developerToken = Deno.env.get('GOOGLE_DEVELOPER_TOKEN');
  if (!developerToken) {
    throw new Error('Missing GOOGLE_DEVELOPER_TOKEN environment variable');
  }

  const query = buildGeographicViewQuery(startDate, endDate);
  const url = `${GOOGLE_ADS_ENDPOINT}/customers/${customerId}/googleAds:searchStream`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json',
  };

  // Add login-customer-id header if we have a manager account
  if (loginCustomerId && loginCustomerId !== customerId) {
    headers['login-customer-id'] = loginCustomerId;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let errorMessage = `Google Ads API error: ${response.status}`;
    
    // Provide helpful diagnostics for common errors
    if (response.status === 404) {
      errorMessage += '. This usually means the customer_id is a manager account or you lack permission on the selected child account.';
    } else if (response.status === 400) {
      errorMessage += '. Bad Request - this could be due to invalid query, date format, or missing required fields.';
    }
    
    // Try to extract useful error details from response
    try {
      const errorJson = JSON.parse(errorBody);
      if (errorJson.error?.message) {
        errorMessage += ` ${errorJson.error.message}`;
      }
      // Log full error for debugging
      console.error('[sync-googleads] Google Ads API error details:', JSON.stringify(errorJson, null, 2));
    } catch {
      if (errorBody && errorBody.length < 500 && !errorBody.includes('<!DOCTYPE')) {
        errorMessage += ` ${errorBody.substring(0, 200)}`;
        console.error('[sync-googleads] Google Ads API error body (raw):', errorBody.substring(0, 500));
      }
    }
    
    // Log request details for debugging
    console.error('[sync-googleads] Request details:', {
      url,
      customerId,
      loginCustomerId,
      startDate,
      endDate,
      queryLength: query.length,
    });
    
    throw new Error(errorMessage);
  }

  return await parseSearchStreamResponse(response);
}

/**
 * Fetch conversion action data from Google Ads API.
 * 
 * This query fetches conversion_action per date, campaign, ad_group, and country.
 * Note: This must be a separate query because segments.conversion_action cannot
 * be used with clicks, cost_micros, or impressions in the same query.
 * 
 * Returns an array of results with conversion_action data.
 */
async function fetchConversionActionInsights(
  accessToken: string,
  customerId: string,
  startDate: string,
  endDate: string,
  loginCustomerId: string | null,
): Promise<any[]> {
  const developerToken = Deno.env.get('GOOGLE_DEVELOPER_TOKEN');
  if (!developerToken) {
    throw new Error('Missing GOOGLE_DEVELOPER_TOKEN environment variable');
  }

  const query = buildConversionActionQuery(startDate, endDate);
  const url = `${GOOGLE_ADS_ENDPOINT}/customers/${customerId}/googleAds:searchStream`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json',
  };

  // Add login-customer-id header if we have a manager account
  if (loginCustomerId && loginCustomerId !== customerId) {
    headers['login-customer-id'] = loginCustomerId;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let errorMessage = `Google Ads API error (conversion action query): ${response.status}`;
    
    // Try to extract useful error details from response
    try {
      const errorJson = JSON.parse(errorBody);
      if (errorJson.error?.message) {
        errorMessage += ` ${errorJson.error.message}`;
      }
      console.error('[sync-googleads] Conversion action query error:', JSON.stringify(errorJson, null, 2));
    } catch {
      if (errorBody && errorBody.length < 500 && !errorBody.includes('<!DOCTYPE')) {
        errorMessage += ` ${errorBody.substring(0, 200)}`;
      }
    }
    
    // Log error but don't fail the entire sync - conversion_action is optional
    console.warn(`[sync-googleads] Failed to fetch conversion action data: ${errorMessage}`);
    return [];
  }

  return await parseSearchStreamResponse(response);
}

/**
 * Fetch geo target constants for country code mapping.
 * 
 * Returns a map of country_criterion_id -> country_code.
 * 
 * TODO: Consider persisting this into a reference table for performance.
 */
async function fetchGeoTargetConstants(
  accessToken: string,
  customerId: string,
  loginCustomerId: string | null,
): Promise<Map<string, string>> {
  const developerToken = Deno.env.get('GOOGLE_DEVELOPER_TOKEN');
  if (!developerToken) {
    throw new Error('Missing GOOGLE_DEVELOPER_TOKEN environment variable');
  }

  const query = buildGeoTargetConstantQuery();
  const url = `${GOOGLE_ADS_ENDPOINT}/customers/${customerId}/googleAds:searchStream`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json',
  };

  if (loginCustomerId && loginCustomerId !== customerId) {
    headers['login-customer-id'] = loginCustomerId;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google Ads geo target constant fetch failed: ${response.status} ${errorBody}`);
  }

  const results = await parseSearchStreamResponse(response);
  const mapping = new Map<string, string>();

  for (const result of results) {
    try {
      const geoConstant = result.geoTargetConstant || result.geo_target_constant;
      if (geoConstant?.id && geoConstant?.countryCode) {
        mapping.set(String(geoConstant.id), geoConstant.countryCode);
      }
    } catch (error) {
      console.warn('[fetchGeoTargetConstants] Failed to parse result:', error);
    }
  }

  return mapping;
}

/**
 * Build a lookup key for matching conversion action data with geographic data.
 */
function buildConversionActionKey(
  date: string,
  campaignId: string,
  adGroupId: string,
  countryCriterionId: string | number,
  locationType: string,
): string {
  return `${date}|${campaignId}|${adGroupId}|${countryCriterionId}|${locationType}`;
}

/**
 * Parse conversion action data and build a lookup map.
 * 
 * Returns a Map<key, conversion_action_id> where key is built from
 * date, campaign, ad_group, country, and location_type.
 */
function buildConversionActionMap(
  conversionActionResults: any[],
  countryCodeMap: Map<string, string>,
): Map<string, string> {
  const conversionActionMap = new Map<string, string>();

  for (const result of conversionActionResults) {
    try {
      const segments = result.segments || {};
      const campaign = result.campaign || {};
      const adGroup = result.adGroup || result.ad_group || {};
      const geographicView = result.geographicView || result.geographic_view || {};

      const date = segments.date;
      const campaignId = campaign.id ? String(campaign.id) : null;
      const adGroupId = adGroup.id ? String(adGroup.id) : null;
      const countryCriterionId = geographicView.countryCriterionId || geographicView.country_criterion_id;
      const locationType = geographicView.locationType || geographicView.location_type;
      const conversionAction = segments.conversionAction || segments.conversion_action;

      // Skip rows without required fields
      if (!date || !campaignId || !adGroupId || !countryCriterionId || !locationType || !conversionAction) {
        continue;
      }

      // Validate location_type
      if (locationType !== 'AREA_OF_INTEREST' && locationType !== 'LOCATION_OF_PRESENCE') {
        continue;
      }

      // Extract conversion action ID
      const conversionActionId = extractConversionActionId(conversionAction);
      if (!conversionActionId) {
        continue;
      }

      // Build lookup key and store conversion_action_id
      const key = buildConversionActionKey(date, campaignId, adGroupId, countryCriterionId, locationType);
      conversionActionMap.set(key, conversionActionId);
    } catch (error) {
      console.warn('[buildConversionActionMap] Failed to parse conversion action result:', error);
      // Continue processing other rows
    }
  }

  return conversionActionMap;
}

/**
 * Transform API results into GeographicDailyRow format.
 */
function transformGeographicResults(
  results: any[],
  tenantId: string,
  customerId: string,
  countryCodeMap: Map<string, string>,
  conversionActionMap: Map<string, string> | null = null,
): GeographicDailyRow[] {
  const rows: GeographicDailyRow[] = [];

  for (const result of results) {
    try {
      const segments = result.segments || {};
      const customer = result.customer || {};
      const campaign = result.campaign || {};
      const adGroup = result.adGroup || result.ad_group || {};
      const geographicView = result.geographicView || result.geographic_view || {};
      const metrics = result.metrics || {};

      const date = segments.date;
      const campaignId = campaign.id ? String(campaign.id) : null;
      const adGroupId = adGroup.id ? String(adGroup.id) : null;
      const countryCriterionId = geographicView.countryCriterionId || geographicView.country_criterion_id;
      const locationType = geographicView.locationType || geographicView.location_type;

      // Skip rows without required fields
      if (!date || !campaignId || !adGroupId || !countryCriterionId || !locationType) {
        continue;
      }

      // Validate location_type
      if (locationType !== 'AREA_OF_INTEREST' && locationType !== 'LOCATION_OF_PRESENCE') {
        continue;
      }

      // Look up conversion_action_id from the separate query results
      let conversionActionId: string | null = null;
      if (conversionActionMap) {
        const key = buildConversionActionKey(date, campaignId, adGroupId, countryCriterionId, locationType);
        conversionActionId = conversionActionMap.get(key) || null;
      }

      const countryCode = countryCodeMap.get(String(countryCriterionId)) || null;
      const customerIdFormatted = customer.id ? formatCustomerIdForDisplay(String(customer.id)) : customerId;

      rows.push({
        tenant_id: tenantId,
        customer_id: customerIdFormatted,
        date,
        campaign_id: campaignId,
        campaign_name: campaign.name || null,
        ad_group_id: adGroupId,
        ad_group_name: adGroup.name || null,
        country_criterion_id: String(countryCriterionId),
        country_code: countryCode,
        location_type: locationType as 'AREA_OF_INTEREST' | 'LOCATION_OF_PRESENCE',
        impressions: metrics.impressions ? Number(metrics.impressions) : 0,
        clicks: metrics.clicks ? Number(metrics.clicks) : 0,
        cost_micros: metrics.costMicros || metrics.cost_micros ? Number(metrics.costMicros || metrics.cost_micros) : 0,
        conversions: metrics.conversions ? Number(metrics.conversions) : 0,
        conversions_value: metrics.conversionsValue || metrics.conversions_value ? Number(metrics.conversionsValue || metrics.conversions_value) : 0,
        conversion_action_id: conversionActionId,
      });
    } catch (error) {
      console.warn('[transformGeographicResults] Failed to parse result row:', error);
      // Continue processing other rows
    }
  }

  return rows;
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

/**
 * Resolve sync window based on mode and connection state.
 * 
 * - manual_test + dateFrom/dateTo: Use provided dates
 * - hourly_test: Use last_hourly_sync_at to NOW() - 1 hour (or last 24h if no timestamp)
 * - daily_test: Use last_daily_sync_at to TODAY - 1 day (or last 30d if no timestamp)
 * - default/cron: Use existing logic (last 30 days or sync_start_date)
 */
async function resolveSyncWindow(
  client: SupabaseClient,
  connection: GoogleConnection,
  mode: SyncMode,
  dateFrom?: string,
  dateTo?: string,
): Promise<SyncWindow> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Manual test mode: use provided dates
  if (mode === 'manual_test') {
    if (!dateFrom || !dateTo) {
      throw new Error(
        'manual_test mode requires both dateFrom and dateTo parameters. ' +
        'Example: {"tenantId": "skinome", "mode": "manual_test", "dateFrom": "2025-12-09", "dateTo": "2025-12-10"}'
      );
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateFrom) || !dateRegex.test(dateTo)) {
      throw new Error(
        'Invalid date format. Use YYYY-MM-DD format. ' +
        `Received: dateFrom="${dateFrom}", dateTo="${dateTo}"`
      );
    }

    // Parse and validate dates
    const fromDate = new Date(dateFrom + 'T00:00:00Z');
    const toDate = new Date(dateTo + 'T23:59:59Z');

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new Error(`Invalid dates: dateFrom="${dateFrom}", dateTo="${dateTo}"`);
    }

    if (fromDate > toDate) {
      throw new Error(`dateFrom (${dateFrom}) must be <= dateTo (${dateTo})`);
    }

    // Prevent syncing too large a range by mistake
    const daysDiff = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysDiff > 90) {
      throw new Error(
        `Date range too large: ${daysDiff} days. Maximum allowed: 90 days. ` +
        'Please use a smaller date range for manual testing.'
      );
    }

    return {
      startDate: dateFrom,
      endDate: dateTo,
    };
  }

  // Hourly test mode: sync last hour from last_hourly_sync_at
  if (mode === 'hourly_test') {
    const meta = connection.meta || {};
    const lastSyncStr = meta.last_hourly_sync_at;

    let startDate: Date;
    if (lastSyncStr && typeof lastSyncStr === 'string') {
      // Parse last sync time and sync from then to now - 1 hour
      const lastSync = new Date(lastSyncStr);
      if (!isNaN(lastSync.getTime())) {
        startDate = new Date(lastSync);
      } else {
        // Invalid timestamp, default to 24 hours ago
        startDate = new Date(today);
        startDate.setDate(startDate.getDate() - 1);
      }
    } else {
      // No last sync, default to 24 hours ago
      startDate = new Date(today);
      startDate.setDate(startDate.getDate() - 1);
    }

    // End date: now - 1 hour (to avoid syncing incomplete current hour)
    const endDate = new Date();
    endDate.setHours(endDate.getHours() - 1, 0, 0, 0);

    return {
      startDate: startDate.toISOString().slice(0, 10),
      endDate: endDate.toISOString().slice(0, 10),
    };
  }

  // Daily test mode: sync last day from last_daily_sync_at
  if (mode === 'daily_test') {
    const meta = connection.meta || {};
    const lastSyncStr = meta.last_daily_sync_at;

    let startDate: Date;
    if (lastSyncStr && typeof lastSyncStr === 'string') {
      // Parse last sync date and sync from then to yesterday
      const lastSync = new Date(lastSyncStr);
      if (!isNaN(lastSync.getTime())) {
        startDate = new Date(lastSync);
        startDate.setHours(0, 0, 0, 0);
      } else {
        // Invalid timestamp, default to 30 days ago
        startDate = new Date(today);
        startDate.setDate(startDate.getDate() - 30);
      }
    } else {
      // No last sync, default to 30 days ago
      startDate = new Date(today);
      startDate.setDate(startDate.getDate() - 30);
    }

    // End date: yesterday (to avoid syncing incomplete current day)
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() - 1);

    return {
      startDate: startDate.toISOString().slice(0, 10),
      endDate: endDate.toISOString().slice(0, 10),
    };
  }

  // Default/cron mode: existing logic
  const syncStartDate = connection.meta?.sync_start_date
    ? new Date(connection.meta.sync_start_date)
    : null;

  let startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (INCREMENTAL_WINDOW_DAYS - 1));

  if (syncStartDate && syncStartDate < startDate) {
    startDate = new Date(syncStartDate);
  }

  const endDate = new Date(today);

  return {
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
  };
}

/**
 * Update last sync timestamps in connections.meta.
 */
async function updateLastSyncTimestamps(
  client: SupabaseClient,
  tenantId: string,
  mode: SyncMode,
  endDate: string,
): Promise<void> {
  if (mode === 'hourly_test') {
    const { error } = await client
      .from('connections')
      .update({
        meta: client.rpc('jsonb_set', {
          base: client.select('meta').from('connections').eq('tenant_id', tenantId).eq('source', SOURCE).single(),
          path: '{last_hourly_sync_at}',
          new_value: new Date().toISOString(),
        }),
        updated_at: new Date().toISOString(),
      })
      .eq('tenant_id', tenantId)
      .eq('source', SOURCE);

    // Simpler approach: read, update, write
    const { data: conn } = await client
      .from('connections')
      .select('meta')
      .eq('tenant_id', tenantId)
      .eq('source', SOURCE)
      .single();

    if (conn) {
      const meta = (conn.meta as Record<string, any>) || {};
      meta.last_hourly_sync_at = new Date().toISOString();

      await client
        .from('connections')
        .update({ meta, updated_at: new Date().toISOString() })
        .eq('tenant_id', tenantId)
        .eq('source', SOURCE);
    }
  } else if (mode === 'daily_test') {
    const { data: conn } = await client
      .from('connections')
      .select('meta')
      .eq('tenant_id', tenantId)
      .eq('source', SOURCE)
      .single();

    if (conn) {
      const meta = (conn.meta as Record<string, any>) || {};
      meta.last_daily_sync_at = endDate;

      await client
        .from('connections')
        .update({ meta, updated_at: new Date().toISOString() })
        .eq('tenant_id', tenantId)
        .eq('source', SOURCE);
    }
  }
}

async function processTenant(
  client: SupabaseClient,
  connection: GoogleConnection,
  mode: SyncMode,
  dateFrom?: string,
  dateTo?: string,
): Promise<JobResult> {
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
    let accessToken: string | null = null;
    try {
      accessToken = await getAccessToken(client, connection);
    } catch (decryptError) {
      const errorMsg = decryptError instanceof Error ? decryptError.message : String(decryptError);
      console.error(`[sync-googleads] Failed to get access token for tenant ${tenantId}:`, errorMsg);
      
      // If decryption fails, provide helpful error
      if (errorMsg.includes('decrypt') || errorMsg.includes('Unable to decrypt')) {
        throw new Error(
          `Unable to decrypt Google Ads access token for tenant ${tenantId}. ` +
          `This usually means ENCRYPTION_KEY in Edge Function environment does not match the key used to encrypt the token. ` +
          `Please re-authenticate Google Ads connection by disconnecting and reconnecting in the integrations settings.`
        );
      }
      throw decryptError;
    }
    
    if (!accessToken) {
      throw new Error('No access token available. Token may be expired and refresh failed.');
    }

    // Get selected customer ID (child account) from connection meta
    const selectedCustomerId = getSelectedCustomerId(connection.meta);
    
    // Explicit check: verify selected_customer_id is NOT a manager account
    const meta = connection.meta || {};
    const availableAccounts = Array.isArray(meta.available_customers) ? meta.available_customers : [];
    const selectedAccountId = typeof meta.selected_customer_id === 'string' 
      ? meta.selected_customer_id.replace(/-/g, '') 
      : null;
    
    if (selectedAccountId) {
      const selectedAccount = availableAccounts.find((a: any) => {
        const aId = String(a.customer_id || '').replace(/-/g, '');
        return aId === selectedAccountId;
      });
      
      if (selectedAccount && selectedAccount.is_manager === true) {
        const errorMsg = '[sync-googleads] selected_customer_id refers to a manager account, cannot run reporting queries. Please select a non-manager account in admin.';
        console.error(errorMsg, {
          tenantId,
          selectedCustomerId: selectedAccountId,
          accountName: selectedAccount.descriptive_name,
        });
        throw new Error(
          'Cannot run reporting queries against a Google Ads manager account. ' +
          'Please select a standard (non-manager) account in the admin panel.',
        );
      }
    }
    
    if (!selectedCustomerId) {
      throw new Error(
        'No customer account selected in connection meta. Please select a customer account in the integrations settings.',
      );
    }

    // Get manager customer ID for login-customer-id header (if applicable)
    const managerCustomerId = getManagerCustomerId(connection.meta);
    
    // Log account selection for diagnostics
    const selectedCustomerName = connection.meta?.selected_customer_name || selectedCustomerId;
    const managerName = managerCustomerId ? formatCustomerIdForDisplay(managerCustomerId) : 'none';
    console.log(
      `[sync-googleads] Selected Google Ads customer: ${selectedCustomerName} (${formatCustomerIdForDisplay(selectedCustomerId)})`
    );
    console.log(
      `[sync-googleads] Using login-customer-id: ${managerName}`
    );

    // Resolve sync window based on mode
    const syncWindow = await resolveSyncWindow(client, connection, mode, dateFrom, dateTo);
    const startDateStr = syncWindow.startDate;
    const endDateStr = syncWindow.endDate;

    // Structured logging: sync start
    console.log(JSON.stringify({
      event: 'sync_start',
      tenantId,
      mode: mode || 'default',
      customerId: formatCustomerIdForDisplay(selectedCustomerId),
      customerName: selectedCustomerName,
      managerCustomerId: managerName,
      syncStart: startDateStr,
      syncEnd: endDateStr,
      timestamp: new Date().toISOString(),
    }));

    console.log(
      `[sync-googleads] Fetching geographic insights for tenant ${tenantId}, customer ${formatCustomerIdForDisplay(selectedCustomerId)}, date range: ${startDateStr} to ${endDateStr}`,
    );

    // Fetch geographic insights from Google Ads API
    // Use selectedCustomerId (child account) for the URL, managerCustomerId for login-customer-id header
    const rawResults = await fetchGeographicInsights(accessToken, selectedCustomerId, startDateStr, endDateStr, managerCustomerId);
    
    // Structured logging: API fetch complete
    console.log(JSON.stringify({
      event: 'api_fetch_complete',
      tenantId,
      mode: mode || 'default',
      apiRows: rawResults.length,
      timestamp: new Date().toISOString(),
    }));
    
    console.log(`[sync-googleads] Fetched ${rawResults.length} result rows from geographic insights API`);

    // Fetch conversion action data separately (cannot be combined with clicks/cost_micros/impressions)
    console.log(`[sync-googleads] Fetching conversion action data`);
    const conversionActionResults = await fetchConversionActionInsights(accessToken, selectedCustomerId, startDateStr, endDateStr, managerCustomerId);
    console.log(`[sync-googleads] Fetched ${conversionActionResults.length} conversion action result rows`);
    
    // Fetch country code mapping
    console.log(`[sync-googleads] Fetching country code mapping`);
    const countryCodeMap = await fetchGeoTargetConstants(accessToken, selectedCustomerId, managerCustomerId);
    console.log(`[sync-googleads] Loaded ${countryCodeMap.size} country mappings`);
    
    // Build conversion action lookup map
    const conversionActionMap = buildConversionActionMap(conversionActionResults, countryCodeMap);
    console.log(`[sync-googleads] Built conversion action map with ${conversionActionMap.size} entries`);

    // Transform results to database rows (merge conversion action data)
    const rows = transformGeographicResults(rawResults, tenantId, selectedCustomerId, countryCodeMap, conversionActionMap);
    
    // Structured logging: transformation complete
    console.log(JSON.stringify({
      event: 'transformation_complete',
      tenantId,
      mode: mode || 'default',
      apiRows: rawResults.length,
      transformedRows: rows.length,
      timestamp: new Date().toISOString(),
    }));
    
    console.log(`[sync-googleads] Transformed ${rows.length} rows for database`);

    if (rows.length > 0) {
      // Batch upsert (Supabase has a limit, so we'll do in batches of 1000)
      const batchSize = 1000;
      let upserted = 0;

      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        
        const { error: upsertError } = await client
          .from('google_ads_geographic_daily')
          .upsert(batch, {
            onConflict: 'tenant_id,customer_id,date,campaign_id,ad_group_id,country_criterion_id,location_type',
          });

        if (upsertError) {
          throw new Error(`Failed to upsert batch ${i / batchSize + 1}: ${upsertError.message}`);
        }
        
        upserted += batch.length;
      }

      console.log(`[sync-googleads] Upserted ${upserted} rows to google_ads_geographic_daily`);
    }

    // Structured logging: database write complete
    console.log(JSON.stringify({
      event: 'database_write_complete',
      tenantId,
      mode: mode || 'default',
      table: 'google_ads_geographic_daily',
      rowsInserted: rows.length,
      timestamp: new Date().toISOString(),
    }));

    // Update last sync timestamps if in hourly/daily test mode
    if (mode === 'hourly_test' || mode === 'daily_test') {
      await updateLastSyncTimestamps(client, tenantId, mode, endDateStr);
    }

    await upsertJobLog(client, {
      tenantId,
      status: 'succeeded',
      startedAt,
      finishedAt: new Date().toISOString(),
    });

    // Structured logging: sync complete
    console.log(JSON.stringify({
      event: 'sync_complete',
      tenantId,
      mode: mode || 'default',
      status: 'succeeded',
      syncStart: startDateStr,
      syncEnd: endDateStr,
      apiRows: rawResults.length,
      rowsInserted: rows.length,
      timestamp: new Date().toISOString(),
    }));

    return {
      tenantId,
      status: 'succeeded',
      inserted: rows.length,
      mode: mode || 'default',
      syncStart: startDateStr,
      syncEnd: endDateStr,
      apiRows: rawResults.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    
    // Structured logging: sync failed
    console.error(JSON.stringify({
      event: 'sync_failed',
      tenantId,
      mode: mode || 'default',
      status: 'failed',
      error: message,
      timestamp: new Date().toISOString(),
    }));
    
    console.error(`[sync-googleads] Error processing tenant ${tenantId}:`, message);

    await upsertJobLog(client, {
      tenantId,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: message,
    });

    return {
      tenantId,
      status: 'failed',
      error: message,
      mode: mode || 'default',
    };
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

    // Fetch connections with access_token_enc and refresh_token_enc
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
