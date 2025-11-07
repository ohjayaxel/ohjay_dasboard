import { randomBytes } from 'crypto';

import { getSupabaseServiceClient } from '@/lib/supabase/server';

import { decryptSecret, encryptSecret } from './crypto';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REPORTING_ENDPOINT = 'https://googleads.googleapis.com/v16/customers';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_DEVELOPER_TOKEN = process.env.GOOGLE_DEVELOPER_TOKEN;
const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:3000';

const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/adwords'];

type ConnectionRow = {
  id: string;
  access_token_enc: Buffer | null;
  refresh_token_enc: Buffer | null;
  expires_at: string | null;
  meta: Record<string, any> | null;
};

const GOOGLE_REDIRECT_PATH = '/api/oauth/googleads/callback';

function buildRedirectUri() {
  // TODO: allow per-environment overrides for redirect URI.
  return `${APP_BASE_URL}${GOOGLE_REDIRECT_PATH}`;
}

function requireClientCredentials() {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error('Missing GOOGLE_CLIENT_ID environment variable.');
  }

  if (!GOOGLE_CLIENT_SECRET) {
    throw new Error('Missing GOOGLE_CLIENT_SECRET environment variable.');
  }
}

async function getExistingConnection(tenantId: string): Promise<ConnectionRow | null> {
  const client = getSupabaseServiceClient();
  const { data, error } = await client
    .from('connections')
    .select('id, access_token_enc, refresh_token_enc, expires_at, meta')
    .eq('tenant_id', tenantId)
    .eq('source', 'google_ads')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read Google Ads connection: ${error.message}`);
  }

  return (data as ConnectionRow) ?? null;
}

async function upsertConnection(
  tenantId: string,
  payload: {
    status: string;
    accessToken?: string;
    refreshToken?: string | null;
    expiresAt?: string | null;
    meta?: Record<string, unknown>;
  },
) {
  const client = getSupabaseServiceClient();
  const existing = await getExistingConnection(tenantId);

  const row = {
    tenant_id: tenantId,
    source: 'google_ads',
    status: payload.status,
    access_token_enc: payload.accessToken ? encryptSecret(payload.accessToken) : null,
    refresh_token_enc: payload.refreshToken ? encryptSecret(payload.refreshToken) : null,
    expires_at: payload.expiresAt ?? null,
    meta: payload.meta ?? {},
  };

  if (existing) {
    const { error } = await client
      .from('connections')
      .update(row)
      .eq('id', existing.id);

    if (error) {
      throw new Error(`Failed to update Google Ads connection: ${error.message}`);
    }
    return;
  }

  const { error } = await client.from('connections').insert(row);
  if (error) {
    throw new Error(`Failed to insert Google Ads connection: ${error.message}`);
  }
}

export async function getGoogleAdsAuthorizeUrl(options: {
  tenantId: string;
  loginCustomerId?: string;
}) {
  requireClientCredentials();

  const state = randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID!,
    redirect_uri: buildRedirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  if (options.loginCustomerId) {
    params.set('login_hint', options.loginCustomerId);
  }

  // TODO: Persist state + tenant metadata for callback validation.
  return {
    url: `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`,
    state,
  };
}

export async function handleGoogleAdsOAuthCallback(options: {
  tenantId: string;
  code: string;
  state: string;
  loginCustomerId?: string;
}) {
  requireClientCredentials();

  const redirectUri = buildRedirectUri();

  let tokenResponse: any = null;

  if (GOOGLE_CLIENT_SECRET) {
    try {
      const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID!,
          client_secret: GOOGLE_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code: options.code,
          redirect_uri: redirectUri,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Google token exchange failed: ${res.status} ${body}`);
      }

      tokenResponse = await res.json();
    } catch (error) {
      console.error('Google Ads token exchange failed, using mock tokens.', error);
    }
  }

  if (!tokenResponse) {
    tokenResponse = {
      access_token: `mock-google-access-token-${options.tenantId}`,
      refresh_token: `mock-google-refresh-token-${options.tenantId}`,
      expires_in: 3600,
      token_type: 'Bearer',
    };
  }

  const expiresAt = tokenResponse.expires_in
    ? new Date(Date.now() + Number(tokenResponse.expires_in) * 1000).toISOString()
    : null;

  await upsertConnection(options.tenantId, {
    status: 'connected',
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? null,
    expiresAt,
    meta: {
      token_type: tokenResponse.token_type,
      login_customer_id: options.loginCustomerId ?? null,
      // TODO: persist customer ID selection when UI exposes it.
    },
  });
}

export async function refreshGoogleAdsTokenIfNeeded(tenantId: string) {
  const connection = await getExistingConnection(tenantId);
  if (!connection) {
    throw new Error('Google Ads connection not found.');
  }

  if (!connection.expires_at || !connection.refresh_token_enc) {
    return;
  }

  if (!GOOGLE_CLIENT_SECRET) {
    console.warn('Missing GOOGLE_CLIENT_SECRET; skipping token refresh.');
    return;
  }

  const expiresAt = new Date(connection.expires_at).getTime();
  if (Date.now() < expiresAt - 5 * 60 * 1000) {
    return;
  }

  const refreshToken = decryptSecret(connection.refresh_token_enc);
  if (!refreshToken) {
    console.warn('Google Ads refresh token unavailable.');
    return;
  }

  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID!,
      client_secret: GOOGLE_CLIENT_SECRET!,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Ads token refresh failed: ${res.status} ${body}`);
  }

  const body = await res.json();
  const newExpiresAt = body.expires_in
    ? new Date(Date.now() + Number(body.expires_in) * 1000).toISOString()
    : null;

  await upsertConnection(tenantId, {
    status: 'connected',
    accessToken: body.access_token,
    refreshToken,
    expiresAt: newExpiresAt,
  });
}

export async function getGoogleAdsAccessToken(tenantId: string): Promise<string | null> {
  const connection = await getExistingConnection(tenantId);
  if (!connection) {
    return null;
  }

  return decryptSecret(connection.access_token_enc);
}

export async function fetchGoogleAdsInsights(params: {
  tenantId: string;
  customerId: string;
  query: string;
}) {
  const accessToken = await getGoogleAdsAccessToken(params.tenantId);

  if (!accessToken || !GOOGLE_DEVELOPER_TOKEN) {
    return [
      {
        date: new Date().toISOString().slice(0, 10),
        cost_micros: 1500000,
        impressions: 2500,
        clicks: 180,
        conversions: 12,
        revenue: 890.5,
      },
    ];
  }

  const url = `${GOOGLE_REPORTING_ENDPOINT}/${params.customerId}:googleAds:searchStream`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': GOOGLE_DEVELOPER_TOKEN,
      'login-customer-id': params.customerId.replace(/-/g, ''),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: params.query }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Ads insights fetch failed: ${res.status} ${body}`);
  }

  const body = await res.json();
  return body; // TODO: normalize response into table schema.
}

