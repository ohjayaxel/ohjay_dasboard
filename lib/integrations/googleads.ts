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

  // Merge existing meta with new meta if updating
  const existingMeta =
    existing && existing.meta && typeof existing.meta === 'object'
      ? (existing.meta as Record<string, unknown>)
      : {};

  const mergedMeta = payload.meta
    ? { ...existingMeta, ...payload.meta }
    : existingMeta;

  const row = {
    tenant_id: tenantId,
    source: 'google_ads',
    status: payload.status,
    access_token_enc: payload.accessToken ? encryptSecret(payload.accessToken) : undefined,
    refresh_token_enc: payload.refreshToken ? encryptSecret(payload.refreshToken) : undefined,
    expires_at: payload.expiresAt ?? undefined,
    meta: mergedMeta,
    updated_at: new Date().toISOString(),
  };

  // Remove undefined fields
  if (!payload.accessToken && existing) {
    delete (row as any).access_token_enc;
  }
  if (!payload.refreshToken && existing) {
    delete (row as any).refresh_token_enc;
  }
  if (!payload.expiresAt && existing) {
    delete (row as any).expires_at;
  }

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

  // For insert, ensure required fields
  const insertRow = {
    ...row,
    access_token_enc: row.access_token_enc ?? null,
    refresh_token_enc: row.refresh_token_enc ?? null,
    expires_at: row.expires_at ?? null,
  };

  const { error } = await client.from('connections').insert(insertRow);
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

  // After OAuth, fetch and classify all accessible accounts (MCC and child accounts)
  let availableAccounts: GoogleAdsAccountInfo[] = [];
  let managerCustomerId: string | null = null;
  let customersError: string | null = null;

  // If we have a real access token (not mock), fetch accounts
  if (tokenResponse.access_token && !tokenResponse.access_token.startsWith('mock-')) {
    try {
      // Temporarily save connection to enable fetchAndClassifyGoogleAdsAccounts to get token
      await upsertConnection(options.tenantId, {
        status: 'connected',
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token ?? null,
        expiresAt,
        meta: {
          token_type: tokenResponse.token_type,
          login_customer_id: options.loginCustomerId ?? null,
        },
      });

      // Fetch and classify all accounts
      const fetchResult = await fetchAndClassifyGoogleAdsAccounts(options.tenantId);

      if (fetchResult.error) {
        customersError = fetchResult.error;
      } else {
        availableAccounts = fetchResult.accounts;

        // Find manager account ID
        const managerAccount = availableAccounts.find(a => a.is_manager);
        if (managerAccount) {
          managerCustomerId = managerAccount.customer_id;
        }

        // Check if we have child accounts
        const childAccounts = availableAccounts.filter(a => !a.is_manager);
        if (childAccounts.length === 0) {
          customersError = 'We detected only Manager (MCC) accounts. To sync data, you must have access to at least one standard Google Ads account. Please verify your permissions in Google Ads.';
        } else {
          // We have child accounts - user must select one (do NOT auto-select)
          console.log(`[Google Ads] OAuth complete: Found ${childAccounts.length} child account(s). User must select one in admin UI.`);
        }
      }
    } catch (error) {
      // If automatic detection fails, log but don't fail the OAuth callback
      // User can manually trigger detection later
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[Google Ads] Automatic account detection failed during OAuth callback:', errorMsg);
      customersError = 'Failed to automatically detect accounts. Please click "Detect Google Ads accounts" to try again.';
    }
  } else {
    // Mock token or no token - set appropriate error message
    customersError = 'Using mock tokens. Real account detection requires valid OAuth credentials.';
  }

  // Get existing meta to preserve other fields
  const existing = await getExistingConnection(options.tenantId);
  const existingMeta =
    existing && existing.meta && typeof existing.meta === 'object'
      ? (existing.meta as Record<string, unknown>)
      : {};

  // Final connection save with all account information
  await upsertConnection(options.tenantId, {
    status: 'connected',
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? null,
    expiresAt,
    meta: {
      ...existingMeta,
      token_type: tokenResponse.token_type,
      login_customer_id: options.loginCustomerId ?? null,
      // New structure
      manager_customer_id: managerCustomerId,
      available_customers: availableAccounts,
      // Do NOT set selected_customer_id here - user must select in admin UI
      selected_customer_id: null,
      selected_customer_name: null,
      // Legacy fields (for backwards compatibility, but deprecated)
      customer_id: null,
      customer_name: null,
      accessible_customers: availableAccounts.filter(a => !a.is_manager).map(a => ({
        id: a.customer_id,
        name: a.descriptive_name,
      })),
      customers_error: customersError,
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

// Types must be defined before handleGoogleAdsOAuthCallback uses them
export type GoogleAdsCustomer = {
  id: string;
  name: string;
  descriptiveName?: string;
};

export type FetchAccessibleCustomersResult = {
  customers: GoogleAdsCustomer[];
  error?: string | null;
};

// Data model for connections.meta - Google Ads account information
export type GoogleAdsAccountInfo = {
  customer_id: string;
  descriptive_name: string;
  currency_code: string;
  time_zone: string;
  is_manager: boolean;
  manager_customer_id?: string;
};

export type GoogleAdsConnectionMeta = {
  // OAuth state
  oauth_state?: string | null;
  oauth_state_created_at?: string | null;
  oauth_redirect_path?: string | null;
  login_customer_id?: string | null;

  // Account selection (new structure)
  manager_customer_id?: string | null;
  selected_customer_id?: string | null;
  selected_customer_name?: string | null;
  available_customers?: GoogleAdsAccountInfo[];

  // Legacy fields (for backwards compatibility)
  customer_id?: string | null;
  customer_name?: string | null;
  accessible_customers?: Array<{ id: string; name: string }>;
  customers_error?: string | null;

  // Token info
  token_type?: string | null;
};

/**
 * Fetch and classify all accessible Google Ads accounts (MCC and child accounts).
 * Returns detailed account information including manager status.
 * 
 * Uses Google Ads API v21 REST endpoint: GET /v21/customers:listAccessibleCustomers
 * Then queries each account to determine if it's a manager account.
 */
export async function fetchAndClassifyGoogleAdsAccounts(tenantId: string): Promise<{
  accounts: GoogleAdsAccountInfo[];
  error?: string | null;
}> {
  const accessToken = await getGoogleAdsAccessToken(tenantId);

  if (!accessToken || !GOOGLE_DEVELOPER_TOKEN) {
    return {
      accounts: [],
      error: 'Missing access token or developer token',
    };
  }

  try {
    // Step 1: List all accessible customers
    const listResponse = await fetch(
      `${GOOGLE_REPORTING_ENDPOINT}:listAccessibleCustomers`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': GOOGLE_DEVELOPER_TOKEN,
        },
      },
    );

    if (!listResponse.ok) {
      const errorBody = await listResponse.text();
      let cleanError = `Failed to fetch accessible customers: ${listResponse.status}`;
      if (errorBody && !errorBody.includes('<!DOCTYPE')) {
        try {
          const errorJson = JSON.parse(errorBody);
          cleanError = errorJson.message || errorJson.error?.message || cleanError;
        } catch {
          if (errorBody.length < 500 && !errorBody.includes('<html')) {
            cleanError = `${cleanError} - ${errorBody.substring(0, 200)}`;
          }
        }
      }
      return { accounts: [], error: cleanError };
    }

    const listData = await listResponse.json();
    const resourceNames = listData.resourceNames || [];

    if (resourceNames.length === 0) {
      return {
        accounts: [],
        error: 'No customer accounts found. The OAuth account may not have access to any Google Ads accounts.',
      };
    }

    console.log(`[Google Ads] Found ${resourceNames.length} accessible account(s), classifying...`);

    // Step 2: For each account, fetch details using GAQL query
    const accounts: GoogleAdsAccountInfo[] = [];
    let managerCustomerId: string | null = null;

    for (const resourceName of resourceNames) {
      const customerId = resourceName.replace('customers/', '');

      try {
        // Use GAQL query to get customer details - works better than direct GET for manager accounts
        const query = `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer LIMIT 1`;

        let customerResponse = await fetch(
          `${GOOGLE_REPORTING_ENDPOINT}/${customerId}/googleAds:searchStream`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'developer-token': GOOGLE_DEVELOPER_TOKEN,
              'login-customer-id': customerId,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query }),
          },
        );

        // If that fails, try without login-customer-id (for regular accounts)
        if (!customerResponse.ok) {
          customerResponse = await fetch(
            `${GOOGLE_REPORTING_ENDPOINT}/${customerId}/googleAds:searchStream`,
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
        }

        if (customerResponse.ok) {
          const responseText = await customerResponse.text();
          let customer: any = null;

          // Parse response - handle multiple formats
          try {
            const parsed = JSON.parse(responseText);
            
            // Handle array of results
            if (Array.isArray(parsed)) {
              // Each item might have results array or direct customer
              for (const item of parsed) {
                if (item.customer) {
                  customer = item.customer;
                  break;
                } else if (item.results && Array.isArray(item.results) && item.results[0]?.customer) {
                  customer = item.results[0].customer;
                  break;
                } else if (item.id) {
                  // Direct customer object
                  customer = item;
                  break;
                }
              }
            } else if (parsed.results && Array.isArray(parsed.results)) {
              // Single object with results array
              customer = parsed.results[0]?.customer;
            } else if (parsed.customer) {
              // Single object with customer property
              customer = parsed.customer;
            } else if (parsed.id) {
              // Direct customer object
              customer = parsed;
            } else {
              // Try newline-delimited JSON
              const lines = responseText.trim().split('\n').filter(line => line.trim());
              if (lines.length > 0) {
                for (const line of lines) {
                  try {
                    const lineParsed = JSON.parse(line);
                    if (lineParsed.customer) {
                      customer = lineParsed.customer;
                      break;
                    } else if (lineParsed.results?.[0]?.customer) {
                      customer = lineParsed.results[0].customer;
                      break;
                    } else if (lineParsed.id) {
                      customer = lineParsed;
                      break;
                    }
                  } catch {
                    // Skip invalid lines
                  }
                }
              }
            }
          } catch (parseError) {
            console.warn(`[Google Ads] Failed to parse customer details for ${customerId}:`, parseError);
          }

          if (customer) {
            // Extract manager flag - must be explicitly true
            // Handle different possible formats (boolean, string "true"/"false", undefined, null)
            let managerFlag: boolean | undefined = undefined;
            if (customer.manager !== undefined && customer.manager !== null) {
              if (typeof customer.manager === 'boolean') {
                managerFlag = customer.manager;
              } else if (typeof customer.manager === 'string') {
                managerFlag = customer.manager.toLowerCase() === 'true';
              } else if (typeof customer.manager === 'number') {
                managerFlag = customer.manager === 1;
              }
            }
            const isManager = managerFlag === true;

            // Debug logging: show raw customer record
            console.log('[Google Ads] Customer record', {
              customerId: customer.id || customerId,
              descriptiveName: customer.descriptive_name || customer.descriptiveName || null,
              currencyCode: customer.currency_code || customer.currencyCode || null,
              timeZone: customer.time_zone || customer.timeZone || null,
              managerFlag: managerFlag,
              managerFlagType: typeof managerFlag,
            });
            
            if (isManager && !managerCustomerId) {
              managerCustomerId = customerId;
            }

            const accountInfo: GoogleAdsAccountInfo = {
              customer_id: customerId,
              descriptive_name: customer.descriptive_name || customer.descriptiveName || customerId,
              currency_code: customer.currency_code || customer.currencyCode || 'USD',
              time_zone: customer.time_zone || customer.timeZone || 'UTC',
              is_manager: isManager,
              manager_customer_id: isManager ? undefined : managerCustomerId || undefined,
            };

            accounts.push(accountInfo);

            // Log classification clearly
            console.log('[Google Ads] Classified account', {
              customerId: customerId,
              descriptiveName: accountInfo.descriptive_name,
              managerFlag: managerFlag,
              classification: isManager ? 'MANAGER' : 'CHILD',
            });
          } else {
            // If we can't get details, assume it's a manager account
            console.warn(`[Google Ads] Could not get details for ${customerId}, assuming manager account`);
            accounts.push({
              customer_id: customerId,
              descriptive_name: customerId,
              currency_code: 'USD',
              time_zone: 'UTC',
              is_manager: true,
            });
            if (!managerCustomerId) {
              managerCustomerId = customerId;
            }
          }
        } else {
          // If both attempts fail, treat as manager account
          console.warn(`[Google Ads] Failed to fetch details for ${customerId} (${customerResponse.status}), assuming manager account`);
          accounts.push({
            customer_id: customerId,
            descriptive_name: customerId,
            currency_code: 'USD',
            time_zone: 'UTC',
            is_manager: true,
          });
          if (!managerCustomerId) {
            managerCustomerId = customerId;
          }
        }
      } catch (error) {
        console.warn(`[Google Ads] Error fetching details for ${customerId}:`, error);
        // Treat as manager account on error
        accounts.push({
          customer_id: customerId,
          descriptive_name: customerId,
          currency_code: 'USD',
          time_zone: 'UTC',
          is_manager: true,
        });
        if (!managerCustomerId) {
          managerCustomerId = customerId;
        }
      }
    }

    // Step 3: If we only found manager accounts, fetch child accounts
    const managerAccounts = accounts.filter(a => a.is_manager);
    const childAccounts = accounts.filter(a => !a.is_manager);

    if (managerAccounts.length > 0 && childAccounts.length === 0) {
      console.log(`[Google Ads] Only manager accounts found, fetching child accounts from ${managerAccounts.length} manager(s)...`);

      for (const managerAccount of managerAccounts) {
        try {
          const query = `SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager FROM customer_client WHERE customer_client.status = 'ENABLED' AND customer_client.manager = false LIMIT 100`;

          let searchResponse = await fetch(
            `${GOOGLE_REPORTING_ENDPOINT}/${managerAccount.customer_id}/googleAds:searchStream`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'developer-token': GOOGLE_DEVELOPER_TOKEN,
                'login-customer-id': managerAccount.customer_id,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ query }),
            },
          );

          if (!searchResponse.ok) {
            searchResponse = await fetch(
              `${GOOGLE_REPORTING_ENDPOINT}/${managerAccount.customer_id}:googleAds:searchStream`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'developer-token': GOOGLE_DEVELOPER_TOKEN,
                  'login-customer-id': managerAccount.customer_id,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query }),
              },
            );
          }

          if (searchResponse.ok) {
            const responseText = await searchResponse.text();
            let results: any[] = [];

            // Parse response
            try {
              const parsed = JSON.parse(responseText);
              if (Array.isArray(parsed)) {
                results = parsed;
              } else if (parsed.results && Array.isArray(parsed.results)) {
                results = parsed.results;
              } else {
                results = [parsed];
              }
            } catch {
              const lines = responseText.trim().split('\n').filter(line => line.trim());
              for (const line of lines) {
                try {
                  const parsed = JSON.parse(line);
                  if (parsed.results && Array.isArray(parsed.results)) {
                    results.push(...parsed.results);
                  } else {
                    results.push(parsed);
                  }
                } catch {
                  // Skip invalid lines
                }
              }
            }

            for (const result of results) {
              const client = result.customerClient || result.results?.[0]?.customerClient;

              if (client && client.manager === false) {
                const clientCustomer = client.clientCustomer;
                let clientId = '';
                if (typeof clientCustomer === 'string') {
                  clientId = clientCustomer.replace('customers/', '').trim();
                } else if (clientCustomer?.id) {
                  clientId = String(clientCustomer.id).replace('customers/', '').trim();
                } else if (clientCustomer && typeof clientCustomer === 'object' && 'resourceName' in clientCustomer) {
                  clientId = String(clientCustomer.resourceName || '').replace('customers/', '').trim();
                }

                if (clientId) {
                  // Check if we already have this account
                  if (!accounts.find(a => a.customer_id === clientId)) {
                    accounts.push({
                      customer_id: clientId,
                      descriptive_name: client.descriptive_name || clientId,
                      currency_code: client.currency_code || 'USD',
                      time_zone: client.time_zone || 'UTC',
                      is_manager: false,
                      manager_customer_id: managerAccount.customer_id,
                    });
                    console.log(`[Google Ads] Found child account: ${clientId} - ${client.descriptive_name || clientId}`);
                  }
                }
              }
            }
          } else {
            const errorText = await searchResponse.text();
            console.warn(`[Google Ads] Failed to fetch child accounts from manager ${managerAccount.customer_id}: ${searchResponse.status} ${errorText.substring(0, 200)}`);
          }
        } catch (error) {
          console.warn(`[Google Ads] Error fetching child accounts from manager ${managerAccount.customer_id}:`, error);
        }
      }
    }

    // Update manager_customer_id for all child accounts
    const finalManagerId = managerCustomerId || managerAccounts[0]?.customer_id;
    if (finalManagerId) {
      accounts.forEach(account => {
        if (!account.is_manager && !account.manager_customer_id) {
          account.manager_customer_id = finalManagerId;
        }
      });
    }

    // Final classification summary
    const managerCount = accounts.filter(a => a.is_manager).length;
    const childCount = accounts.filter(a => !a.is_manager).length;

    console.log('[Google Ads] Classification complete', {
      managerCount,
      childCount,
    });

    return { accounts };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Google Ads] Error fetching and classifying accounts:', error);
    return {
      accounts: [],
      error: `Failed to fetch accounts: ${errorMessage}`,
    };
  }
}

/**
 * Fetch all accessible Google Ads customers for a tenant.
 * Returns list of customers accessible from the MCC account.
 * 
 * Uses Google Ads API v21 REST endpoint: GET /v21/customers:listAccessibleCustomers
 * 
 * @deprecated Use fetchAndClassifyGoogleAdsAccounts instead for better MCC support
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
        // Try without login-customer-id first (for regular accounts)
        let customerResponse = await fetch(`${GOOGLE_REPORTING_ENDPOINT}/${customerId}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'developer-token': GOOGLE_DEVELOPER_TOKEN,
          },
        });

        // If that fails with 404, try with login-customer-id (for manager accounts)
        if (!customerResponse.ok && customerResponse.status === 404) {
          customerResponse = await fetch(`${GOOGLE_REPORTING_ENDPOINT}/${customerId}`, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'developer-token': GOOGLE_DEVELOPER_TOKEN,
              'login-customer-id': customerId,
            },
          });
        }

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
          // If we can't fetch details even with both methods, treat as manager account
          // Manager accounts often return 404 when queried directly
          // We'll try to fetch child accounts from them
          const errorText = await customerResponse.text();
          console.warn(`[Google Ads] Failed to fetch customer ${customerId} details: ${customerResponse.status}`);
          console.log(`[Google Ads] Treating ${customerId} as potential manager account (will try to fetch child accounts)`);
          managerAccountIds.push(customerId);
        }
      } catch (error) {
        // If individual customer fetch fails, treat as potential manager account
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn(`[Google Ads] Failed to fetch customer ${customerId} details:`, errorMsg);
        console.log(`[Google Ads] Treating ${customerId} as potential manager account (will try to fetch child accounts)`);
        managerAccountIds.push(customerId);
      }
    }

    // Log summary before child account fetching
    console.log(`[Google Ads] Summary after processing ${resourceNames.length} accessible customer(s):`);
    console.log(`[Google Ads]   - Regular accounts found: ${allCustomers.length}`);
    if (allCustomers.length > 0) {
      console.log(`[Google Ads]   - Regular account IDs: ${allCustomers.map(c => c.id).join(', ')}`);
    }
    console.log(`[Google Ads]   - Manager accounts detected: ${managerAccountIds.length}`);
    if (managerAccountIds.length > 0) {
      console.log(`[Google Ads]   - Manager account IDs: ${managerAccountIds.join(', ')}`);
    }

    // If we found manager accounts but no regular customers, fetch child accounts
    if (managerAccountIds.length > 0 && allCustomers.length === 0) {
      console.log(`[Google Ads] ✅ Condition met: managerAccountIds.length (${managerAccountIds.length}) > 0 && allCustomers.length (${allCustomers.length}) === 0`);
      console.log(`[Google Ads] Starting to fetch child accounts from ${managerAccountIds.length} manager account(s)...`);

      for (const managerId of managerAccountIds) {
        try {
          // Use searchStream to get customer_client resources
          // GAQL query to fetch non-manager child accounts
          const query = `SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.manager FROM customer_client WHERE customer_client.status = 'ENABLED' AND customer_client.manager = false LIMIT 100`;

          // Try primary endpoint first: /googleAds:searchStream
          let searchResponse = await fetch(
            `${GOOGLE_REPORTING_ENDPOINT}/${managerId}/googleAds:searchStream`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'developer-token': GOOGLE_DEVELOPER_TOKEN,
                'login-customer-id': managerId, // Required when operating under manager account
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ query }),
            },
          );

          // If primary endpoint fails, try alternative format
          if (!searchResponse.ok) {
            console.log(`[Google Ads] Primary endpoint failed (${searchResponse.status}), trying alternative format...`);
            searchResponse = await fetch(
              `${GOOGLE_REPORTING_ENDPOINT}/${managerId}:googleAds:searchStream`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'developer-token': GOOGLE_DEVELOPER_TOKEN,
                  'login-customer-id': managerId,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query }),
              },
            );
          }

          if (searchResponse.ok) {
            // Parse streaming JSON response - handle multiple formats
            // searchStream can return: JSON array, newline-delimited JSON, or single object
            const responseText = await searchResponse.text();
            console.log(`[Google Ads] Response from manager ${managerId}: ${responseText.length} bytes`);
            
            // Try parsing as JSON array first (v21 sometimes returns arrays)
            let results: any[] = [];
            try {
              const parsed = JSON.parse(responseText);
              if (Array.isArray(parsed)) {
                // Array of result objects
                console.log(`[Google Ads] Parsed as JSON array with ${parsed.length} items`);
                for (const item of parsed) {
                  if (item.results && Array.isArray(item.results)) {
                    results.push(...item.results);
                  } else {
                    results.push(item);
                  }
                }
              } else if (parsed.results && Array.isArray(parsed.results)) {
                // Single object with results array
                console.log(`[Google Ads] Parsed as object with results array (${parsed.results.length} items)`);
                results = parsed.results;
              } else {
                // Single result object
                console.log(`[Google Ads] Parsed as single object`);
                results = [parsed];
              }
            } catch {
              // Fallback: parse as newline-delimited JSON
              const lines = responseText.trim().split('\n').filter(line => line.trim());
              console.log(`[Google Ads] Parsing as newline-delimited JSON (${lines.length} lines)`);
              for (const line of lines) {
                try {
                  const parsed = JSON.parse(line);
                  if (parsed.results && Array.isArray(parsed.results)) {
                    results.push(...parsed.results);
                  } else {
                    results.push(parsed);
                  }
                } catch {
                  // Skip invalid lines
                }
              }
            }

            console.log(`[Google Ads] Processing ${results.length} result(s) from manager ${managerId}`);

            // Process all results to extract customer clients
            for (const result of results) {
              try {
                // searchStream results structure can be:
                // - { results: [{ customerClient: {...} }] } - already extracted above
                // - { customerClient: {...} } - direct format
                const client = result.customerClient || (result.results?.[0]?.customerClient);

                if (!client) {
                  console.log(`[Google Ads] Skipping result - no customerClient field:`, JSON.stringify(result).substring(0, 200));
                  continue;
                }

                // Log client structure for debugging
                console.log(`[Google Ads] Processing client:`, {
                  hasClientCustomer: !!client.clientCustomer,
                  clientCustomerType: typeof client.clientCustomer,
                  manager: client.manager,
                  descriptiveName: client.descriptiveName,
                });

                if (client.manager === false) {
                  const clientCustomer = client.clientCustomer;
                  // Extract ID from "customers/1234567890" format
                  let clientId = '';
                  if (typeof clientCustomer === 'string') {
                    clientId = clientCustomer.replace('customers/', '').trim();
                  } else if (clientCustomer?.id) {
                    clientId = String(clientCustomer.id).replace('customers/', '').trim();
                  } else if (clientCustomer && typeof clientCustomer === 'object' && 'resourceName' in clientCustomer) {
                    // Sometimes it's an object with resourceName field
                    clientId = String(clientCustomer.resourceName || '').replace('customers/', '').trim();
                  }

                  if (clientId) {
                    console.log(`[Google Ads] ✅ Found child account from manager ${managerId}:`, {
                      id: clientId,
                      descriptiveName: client.descriptiveName,
                      manager: client.manager,
                    });

                    allCustomers.push({
                      id: clientId,
                      name: client.descriptiveName || clientId,
                      descriptiveName: client.descriptiveName,
                    });
                  } else {
                    console.warn(`[Google Ads] ⚠️  Could not extract client ID from:`, JSON.stringify(clientCustomer));
                  }
                } else {
                  console.log(`[Google Ads] Skipping client - is manager: ${client.manager}`);
                }
              } catch (parseError) {
                // Skip invalid result entries
                console.warn(`[Google Ads] Failed to process searchStream result:`, parseError);
                continue;
              }
            }
          } else {
            const errorText = await searchResponse.text();
            console.error(`[Google Ads] ❌ Failed to fetch clients for manager ${managerId}: ${searchResponse.status}`);
            console.error(`[Google Ads] Error response: ${errorText.substring(0, 1000)}`);
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

  const url = `${GOOGLE_REPORTING_ENDPOINT}/${params.customerId}/googleAds:searchStream`;
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

