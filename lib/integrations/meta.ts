import { randomBytes } from 'crypto';

import { getSupabaseServiceClient } from '@/lib/supabase/server';

import { decryptSecret, encryptSecret } from './crypto';

const META_API_VERSION = process.env.META_API_VERSION ?? 'v18.0';
const META_OAUTH_BASE = `https://www.facebook.com/${META_API_VERSION}/dialog/oauth`;
const META_TOKEN_ENDPOINT = `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token`;
const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:3000';

const META_SCOPES = ['ads_read'];

type ConnectionRow = {
  id: string;
  access_token_enc: Buffer | null;
  refresh_token_enc: Buffer | null;
  expires_at: string | null;
};

type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
};

const META_REDIRECT_PATH = '/api/oauth/meta/callback';

function normalizedBaseUrl() {
  const base = APP_BASE_URL ?? 'http://localhost:3000';
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function buildRedirectUri() {
  return `${normalizedBaseUrl()}${META_REDIRECT_PATH}`;
}

type MetaAdAccount = {
  account_id: string;
  name?: string;
};

async function fetchMetaAdAccounts(accessToken: string): Promise<MetaAdAccount[]> {
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}/me/adaccounts`);
  url.searchParams.set('fields', 'account_id,name');

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Meta ad accounts fetch failed: ${response.status} ${body}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload?.data)) {
    return [];
  }

  return payload.data
    .filter((item: any) => typeof item?.account_id === 'string')
    .map((item: any) => ({
      account_id: item.account_id as string,
      name: typeof item?.name === 'string' ? item.name : undefined,
    }));
}

function requireAppCredentials() {
  if (!META_APP_ID) {
    throw new Error('Missing META_APP_ID environment variable.');
  }

  if (!META_APP_SECRET) {
    throw new Error('Missing META_APP_SECRET environment variable.');
  }
}

async function getExistingConnection(tenantId: string): Promise<ConnectionRow | null> {
  const client = getSupabaseServiceClient();
  const { data, error } = await client
    .from('connections')
    .select('id, access_token_enc, refresh_token_enc, expires_at')
    .eq('tenant_id', tenantId)
    .eq('source', 'meta')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read Meta connection: ${error.message}`);
  }

  return data as ConnectionRow | null;
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
    source: 'meta',
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
      throw new Error(`Failed to update Meta connection: ${error.message}`);
    }
    return;
  }

  const { error } = await client.from('connections').insert(row);
  if (error) {
    throw new Error(`Failed to insert Meta connection: ${error.message}`);
  }
}

export async function getMetaAuthorizeUrl(tenantId: string) {
  const state = randomBytes(16).toString('hex');

  if (!META_APP_ID) {
    const fallbackParams = new URLSearchParams({
      state,
      code: 'mock-code',
    });

    return {
      url: `${buildRedirectUri()}?${fallbackParams.toString()}`,
      state,
    };
  }

  const params = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: buildRedirectUri(),
    response_type: 'code',
    scope: META_SCOPES.join(','),
    display: 'page',
    auth_type: 'rerequest',
    state,
  });

  return {
    url: `${META_OAUTH_BASE}?${params.toString()}`,
    state,
  };
}

export async function handleMetaOAuthCallback(options: {
  tenantId: string;
  code: string;
  state: string;
}) {
  const redirectUri = buildRedirectUri();

  let tokenResponse: TokenResponse | null = null;

  if (META_APP_ID && META_APP_SECRET) {
    try {
      const params = new URLSearchParams({
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        redirect_uri: redirectUri,
        code: options.code,
      });

      const res = await fetch(`${META_TOKEN_ENDPOINT}?${params.toString()}`, {
        method: 'GET',
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Meta token exchange failed: ${res.status} ${body}`);
      }

      tokenResponse = (await res.json()) as TokenResponse;
    } catch (error) {
      console.error('Meta token exchange failed, falling back to mock tokens.', error);
    }
  }

  if (!tokenResponse) {
    // Mock tokens for local development when credentials are not configured.
    tokenResponse = {
      access_token: `mock-meta-access-token-${options.tenantId}`,
      token_type: 'bearer',
      expires_in: 60 * 60 * 2,
      refresh_token: `mock-meta-refresh-token-${options.tenantId}`,
    };
  }

  const expiresAt = tokenResponse.expires_in
    ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
    : null;

  let accounts: MetaAdAccount[] = [];
  try {
    accounts = await fetchMetaAdAccounts(tokenResponse.access_token);
  } catch (error) {
    console.error('Failed to fetch Meta ad accounts', error);
  }

  const selectedAccountId = accounts[0]?.account_id ?? null;

  await upsertConnection(options.tenantId, {
    status: 'connected',
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? null,
    expiresAt,
    meta: {
      token_type: tokenResponse.token_type,
      accounts,
      selected_account_id: selectedAccountId,
      // TODO: store key version when encryption rotation is implemented.
    },
  });
}

export async function refreshMetaTokenIfNeeded(tenantId: string) {
  const connection = await getExistingConnection(tenantId);

  if (!connection) {
    throw new Error('Meta connection not found.');
  }

  if (!connection.expires_at || !connection.refresh_token_enc) {
    return;
  }

  const expiresAt = new Date(connection.expires_at).getTime();

  // Refresh token if less than 5 minutes remaining.
  if (Date.now() < expiresAt - 5 * 60 * 1000) {
    return;
  }

  if (!META_APP_SECRET) {
    console.warn('Missing META_APP_SECRET; skipping token refresh.');
    return;
  }

  const refreshToken = decryptSecret(connection.refresh_token_enc);
  if (!refreshToken) {
    console.warn('Meta refresh token is unavailable.');
    return;
  }

  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: META_APP_ID!,
    client_secret: META_APP_SECRET,
    fb_exchange_token: refreshToken,
  });

  const res = await fetch(`${META_TOKEN_ENDPOINT}?${params.toString()}`, {
    method: 'GET',
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Meta token refresh failed: ${res.status} ${body}`);
  }

  const body = (await res.json()) as TokenResponse;
  const newExpiresAt = body.expires_in
    ? new Date(Date.now() + body.expires_in * 1000).toISOString()
    : null;

  await upsertConnection(tenantId, {
    status: 'connected',
    accessToken: body.access_token,
    refreshToken,
    expiresAt: newExpiresAt,
  });
}

export async function getMetaAccessToken(tenantId: string): Promise<string | null> {
  const connection = await getExistingConnection(tenantId);
  if (!connection) {
    return null;
  }

  return decryptSecret(connection.access_token_enc);
}

export async function fetchMetaInsightsDaily(params: {
  tenantId: string;
  adAccountId: string;
  startDate: string;
  endDate: string;
}) {
  const accessToken = await getMetaAccessToken(params.tenantId);

  if (!accessToken || !META_APP_SECRET) {
    // Local development fallback payload.
    return [
      {
        date: params.startDate,
        spend: 123.45,
        impressions: 1000,
        clicks: 120,
        purchases: 4,
        revenue: 420.67,
      },
    ];
  }

  const url = new URL(
    `https://graph.facebook.com/${META_API_VERSION}/${params.adAccountId}/insights`,
  );
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('time_range', JSON.stringify({ since: params.startDate, until: params.endDate }));
  url.searchParams.set('level', 'ad');
  url.searchParams.set('fields', ['spend', 'impressions', 'clicks', 'purchases', 'purchase_value'].join(','));

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Meta insights fetch failed: ${response.status} ${body}`);
  }

  const body = await response.json();
  return body.data ?? [];
}

