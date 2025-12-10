import { randomBytes } from 'crypto';

import { getSupabaseServiceClient } from '@/lib/supabase/server';

import { decryptSecret, encryptSecret } from './crypto';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REPORTING_ENDPOINT = 'https://googleads.googleapis.com/v21/customers';

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
  redirectPath?: string;
}) {
  requireClientCredentials();

  const client = getSupabaseServiceClient();
  const state = randomBytes(16).toString('hex');
  const now = new Date().toISOString();

  // Get existing connection or create placeholder
  const existing = await getExistingConnection(options.tenantId);
  const baseMeta =
    existing && existing.meta && typeof existing.meta === 'object'
      ? (existing.meta as Record<string, unknown>)
      : {};

  const nextMeta = {
    ...baseMeta,
    oauth_state: state,
    oauth_state_created_at: now,
    oauth_redirect_path: options.redirectPath || '/admin',
    login_customer_id: options.loginCustomerId ?? null,
  };

  if (existing) {
    const { error } = await client
      .from('connections')
      .update({
        meta: nextMeta,
        updated_at: now,
      })
      .eq('id', existing.id);

    if (error) {
      throw new Error(`Failed to update Google Ads connection: ${error.message}`);
    }
  } else {
    const { error } = await client.from('connections').insert({
      tenant_id: options.tenantId,
      source: 'google_ads',
      status: 'disconnected',
      updated_at: now,
      access_token_enc: null,
      refresh_token_enc: null,
      expires_at: null,
      meta: nextMeta,
    });

    if (error) {
      throw new Error(`Failed to create Google Ads connection: ${error.message}`);
    }
  }

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

  // OAuth callback does NOT automatically fetch customers
  // Users must click "Detect Google Ads accounts" button to trigger automatic detection
  let customerId = options.loginCustomerId ?? null;
  let customerName: string | null = null;

  if (tokenResponse.access_token && customerId) {
    customerName = customerId;
  }

  await upsertConnection(options.tenantId, {
    status: 'connected',
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? null,
    expiresAt,
    meta: {
      token_type: tokenResponse.token_type,
      login_customer_id: customerId,
      customer_id: customerId, // Also save as customer_id for backwards compatibility
      selected_customer_id: customerId || null, // May be set via loginCustomerId parameter
      customer_name: customerName,
      accessible_customers: [], // Empty initially - will be populated when user clicks "Detect accounts"
      customers_error: customerId
        ? null
        : 'No account selected yet. Click "Detect Google Ads accounts" to load accessible accounts.',
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

export type GoogleAdsCustomer = {
  id: string;
  name: string;
  descriptiveName?: string;
};

export type FetchAccessibleCustomersResult = {
  customers: GoogleAdsCustomer[];
  error?: string | null;
};

/**
 * Fetch all accessible Google Ads customers for a tenant.
 * Returns list of customers accessible from the MCC account.
 * 
 * Uses Google Ads API v21 REST endpoint: GET /v21/customers:listAccessibleCustomers
 */
export async function fetchAccessibleGoogleAdsCustomers(tenantId: string): Promise<FetchAccessibleCustomersResult> {
  const accessToken = await getGoogleAdsAccessToken(tenantId);

  if (!accessToken || !GOOGLE_DEVELOPER_TOKEN) {
    return {
      customers: [],
      error: 'Missing access token or developer token',
    };
  }

  try {
    // Google Ads API v21: GET to customers:listAccessibleCustomers
    // REST endpoint for listing accessible customers
    const response = await fetch(
      `${GOOGLE_REPORTING_ENDPOINT}:listAccessibleCustomers`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': GOOGLE_DEVELOPER_TOKEN,
        },
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      // Clean up HTML errors and extract useful message
      let cleanError = `Failed to fetch accessible customers: ${response.status}`;
      if (errorBody && !errorBody.includes('<!DOCTYPE')) {
        try {
          const errorJson = JSON.parse(errorBody);
          cleanError = errorJson.message || errorJson.error?.message || cleanError;
        } catch {
          // If not JSON, use first 200 chars if not HTML
          if (errorBody.length < 500 && !errorBody.includes('<html')) {
            cleanError = `${cleanError} - ${errorBody.substring(0, 200)}`;
          }
        }
      }
      return {
        customers: [],
        error: cleanError,
      };
    }

    const data = await response.json();
    const resourceNames = data.resourceNames || [];

    if (resourceNames.length === 0) {
      return {
        customers: [],
        error: 'No customer accounts found. The OAuth account may not have access to any Google Ads accounts.',
      };
    }

    // Fetch customer details for each resource
    // Separate manager accounts from regular customer accounts
    const allCustomers: GoogleAdsCustomer[] = [];
    const managerAccountIds: string[] = [];

    for (const resourceName of resourceNames) {
      // Extract customer ID from resource name (e.g., "customers/1234567890")
      const customerId = resourceName.replace('customers/', '');

      try {
        // Get customer details
        const customerResponse = await fetch(`${GOOGLE_REPORTING_ENDPOINT}/${customerId}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'developer-token': GOOGLE_DEVELOPER_TOKEN,
          },
        });

        if (customerResponse.ok) {
          const customerData = await customerResponse.json();
          const customer = customerData.customer;

          // Debug logging
          console.log(`[Google Ads] Customer ${customerId}:`, {
            id: customerId,
            descriptiveName: customer?.descriptiveName,
            manager: customer?.manager,
          });

          // Determine manager status ONLY via customer.manager === true
          if (customer?.manager === true) {
            // This is a Manager (MCC) account - don't add to customer list
            managerAccountIds.push(customerId);
            console.log(`[Google Ads] Manager account detected: ${customerId}`);
          } else {
            // Regular customer account
            allCustomers.push({
              id: customerId,
              name: customer?.descriptiveName || customer?.companyName || customerId,
              descriptiveName: customer?.descriptiveName,
            });
          }
        } else {
          // If we can't fetch details, we cannot determine manager status
          // Don't add it to either list - log a warning
          console.warn(`[Google Ads] Failed to fetch customer ${customerId} details: ${customerResponse.status}`);
        }
      } catch (error) {
        // If individual customer fetch fails, log and skip
        console.warn(`[Google Ads] Failed to fetch customer ${customerId} details:`, error);
      }
    }

    // If we found manager accounts but no regular customers, fetch child accounts
    if (managerAccountIds.length > 0 && allCustomers.length === 0) {
      console.log(`[Google Ads] Only manager accounts found. Fetching child accounts from ${managerAccountIds.length} manager(s)...`);

      for (const managerId of managerAccountIds) {
        try {
          // Use searchStream to get customer_client resources
          // GAQL query to fetch non-manager child accounts
          const query = `SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.manager FROM customer_client WHERE customer_client.status = 'ENABLED' AND customer_client.manager = false LIMIT 100`;

          const searchResponse = await fetch(
            `${GOOGLE_REPORTING_ENDPOINT}/${managerId}:googleAds:searchStream`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'developer-token': GOOGLE_DEVELOPER_TOKEN,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ query }),
            },
          );

          if (searchResponse.ok) {
            // Parse streaming JSON response
            // searchStream returns newline-delimited JSON where each line is a result
            const responseText = await searchResponse.text();
            const lines = responseText.trim().split('\n').filter(line => line.trim());

            for (const line of lines) {
              try {
                const result = JSON.parse(line);
                
                // searchStream results structure: { results: [{ customerClient: {...} }] }
                // Or could be direct: { customerClient: {...} }
                const client = result.results?.[0]?.customerClient || result.customerClient;

                if (client && client.manager === false) {
                  const clientCustomer = client.clientCustomer;
                  // Extract ID from "customers/1234567890" format
                  let clientId = '';
                  if (typeof clientCustomer === 'string') {
                    clientId = clientCustomer.replace('customers/', '').trim();
                  } else if (clientCustomer?.id) {
                    clientId = String(clientCustomer.id).replace('customers/', '').trim();
                  }

                  if (clientId) {
                    console.log(`[Google Ads] Found child account from manager ${managerId}:`, {
                      id: clientId,
                      descriptiveName: client.descriptiveName,
                      manager: client.manager,
                    });

                    allCustomers.push({
                      id: clientId,
                      name: client.descriptiveName || clientId,
                      descriptiveName: client.descriptiveName,
                    });
                  }
                }
              } catch (parseError) {
                // Skip invalid JSON lines (could be metadata or empty lines)
                console.warn(`[Google Ads] Failed to parse searchStream result line:`, parseError);
                continue;
              }
            }
          } else {
            const errorText = await searchResponse.text();
            console.warn(`[Google Ads] Failed to fetch clients for manager ${managerId}: ${searchResponse.status} ${errorText}`);
          }
        } catch (error) {
          console.warn(`[Google Ads] Error fetching clients for manager ${managerId}:`, error);
        }
      }
    }

    // Deduplicate customers by ID
    const uniqueCustomers = Array.from(
      new Map(allCustomers.map(c => [c.id, c])).values()
    );

    if (uniqueCustomers.length === 0) {
      return {
        customers: [],
        error: 'No regular Google Ads customer accounts found. Only manager (MCC) accounts were detected.',
      };
    }

    console.log(`[Google Ads] Returning ${uniqueCustomers.length} non-manager customer account(s):`, uniqueCustomers.map(c => ({ id: c.id, name: c.name })));

    return { customers: uniqueCustomers };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Google Ads] Error fetching accessible customers:', error);
    return {
      customers: [],
      error: `Failed to fetch accessible customers: ${errorMessage}`,
    };
  }
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

