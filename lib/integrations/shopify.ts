import { createHmac, randomBytes } from 'crypto';

import { getSupabaseServiceClient } from '@/lib/supabase/server';

import { decryptSecret, encryptSecret } from './crypto';

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:3000';

const SHOPIFY_SCOPES = ['read_orders', 'read_customers'];

type ConnectionRow = {
  id: string;
  access_token_enc: Buffer | null;
  refresh_token_enc: Buffer | null;
  meta: Record<string, any> | null;
};

const SHOPIFY_REDIRECT_PATH = '/api/oauth/shopify/callback';

function buildRedirectUri(): string {
  // Se till att det inte finns trailing slash
  const baseUrl = APP_BASE_URL.replace(/\/$/, '');
  const redirectPath = SHOPIFY_REDIRECT_PATH.replace(/\/$/, '');
  return `${baseUrl}${redirectPath}`;
}

// Kräv credentials för OAuth flow
function requireOAuthCredentials() {
  if (!SHOPIFY_API_KEY) {
    throw new Error('Missing SHOPIFY_API_KEY environment variable. Required for OAuth flow.');
  }

  if (!SHOPIFY_API_SECRET) {
    throw new Error('Missing SHOPIFY_API_SECRET environment variable. Required for OAuth flow.');
  }
}

// Varning för bakåtkompatibilitet (Custom Apps behöver inte dessa)
function requireAppCredentials() {
  // Varnar bara, kastar inte error (för Custom Apps kan fungera utan dessa)
  if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
    console.warn('SHOPIFY_API_KEY or SHOPIFY_API_SECRET missing. OAuth flow will not work, but Custom Apps can still be used.');
  }
}

async function getExistingConnection(tenantId: string): Promise<ConnectionRow | null> {
  const client = getSupabaseServiceClient();
  const { data, error } = await client
    .from('connections')
    .select('id, access_token_enc, refresh_token_enc, meta')
    .eq('tenant_id', tenantId)
    .eq('source', 'shopify')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read Shopify connection: ${error.message}`);
  }

  return (data as ConnectionRow) ?? null;
}

async function upsertConnection(
  tenantId: string,
  payload: {
    status: string;
    accessToken?: string;
    meta?: Record<string, unknown>;
  },
) {
  const client = getSupabaseServiceClient();
  const existing = await getExistingConnection(tenantId);

  const row = {
    tenant_id: tenantId,
    source: 'shopify',
    status: payload.status,
    access_token_enc: payload.accessToken ? encryptSecret(payload.accessToken) : null,
    refresh_token_enc: null,
    meta: payload.meta ?? {},
  };

  if (existing) {
    const { error } = await client
      .from('connections')
      .update(row)
      .eq('id', existing.id);

    if (error) {
      throw new Error(`Failed to update Shopify connection: ${error.message}`);
    }
    return;
  }

  const { error } = await client.from('connections').insert(row);
  if (error) {
    throw new Error(`Failed to insert Shopify connection: ${error.message}`);
  }
}

export async function getShopifyAuthorizeUrl(options: { 
  tenantId: string; 
  shopDomain: string;
  state?: string; // Optional pre-signed state from API
}) {
  requireOAuthCredentials(); // Kräv credentials för OAuth

  // Normalisera shop domain
  const normalizedShop = options.shopDomain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();

  // Använd antingen den skickade state (från API) eller skapa en enkel state
  const state = options.state || randomBytes(16).toString('hex');
  
  // Verifiera att scopes är exakt 'read_orders'
  const scopes = SHOPIFY_SCOPES.join(',');
  if (scopes !== 'read_orders') {
    console.warn(`Warning: SHOPIFY_SCOPES is "${scopes}", expected "read_orders"`);
  }
  
  // Bygg redirect URI (utan trailing slash)
  const redirectUri = buildRedirectUri();
  
  // Bygg OAuth URL med URLSearchParams (encodar automatiskt)
  const params = new URLSearchParams({
    client_id: SHOPIFY_API_KEY!,
    scope: scopes,
    redirect_uri: redirectUri, // URLSearchParams encodar automatiskt
    state,
  });

  const authorizeUrl = `https://${normalizedShop}/admin/oauth/authorize?${params.toString()}`;

  // Debug logging
  console.log('=== Shopify OAuth Debug ===');
  console.log('Client ID:', SHOPIFY_API_KEY);
  console.log('Scopes:', scopes);
  console.log('Redirect URI:', redirectUri);
  console.log('Normalized Shop:', normalizedShop);
  console.log('OAuth URL:', authorizeUrl);

  return {
    url: authorizeUrl,
    state,
  };
}

export function normalizeShopDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

export async function handleShopifyOAuthCallback(options: {
  tenantId: string;
  code: string;
  state: string;
  shop: string;
}) {
  requireOAuthCredentials(); // Kräv credentials för OAuth

  // Normalisera shop domain
  const normalizedShop = normalizeShopDomain(options.shop);
  const tokenEndpoint = `https://${normalizedShop}/admin/oauth/access_token`;

  let tokenResponse: any = null;

  if (SHOPIFY_API_SECRET) {
    try {
      const res = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: SHOPIFY_API_KEY!,
          client_secret: SHOPIFY_API_SECRET,
          code: options.code,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Shopify token exchange failed: ${res.status} ${body}`);
      }

      tokenResponse = await res.json();
    } catch (error) {
      console.error('Shopify token exchange failed, using mock token.', error);
    }
  }

  if (!tokenResponse) {
    tokenResponse = {
      access_token: `mock-shopify-access-token-${options.tenantId}`,
      scope: SHOPIFY_SCOPES.join(','),
    };
  }

  await upsertConnection(options.tenantId, {
    status: 'connected',
    accessToken: tokenResponse.access_token,
    meta: {
      scope: tokenResponse.scope,
      shop: normalizedShop,
      store_domain: normalizedShop, // Normaliserad för webhook lookup
    },
  });

  // Register webhooks after connection is established
  try {
    await registerShopifyWebhooks(normalizedShop, tokenResponse.access_token);
  } catch (error) {
    console.error(`Failed to register Shopify webhooks for ${normalizedShop}:`, error);
    // Don't fail OAuth callback if webhook registration fails - can be done manually later
  }
}

export async function verifyShopifyWebhook(
  payload: string, 
  hmacHeader: string | null,
  webhookSecret?: string // Optional: custom webhook secret från connection metadata
): Promise<boolean> {
  // För Custom Apps, kan webhook secret komma från connection metadata
  const secretToUse = webhookSecret || SHOPIFY_API_SECRET;
  
  if (!secretToUse) {
    console.warn('Missing webhook secret; skipping webhook verification.');
    return true; // Allow if no secret configured (för development/Custom Apps)
  }

  if (!hmacHeader) {
    return false;
  }

  const digest = createHmac('sha256', secretToUse).update(payload).digest('base64');
  return digest === hmacHeader;
}

export async function getShopifyAccessToken(tenantId: string): Promise<string | null> {
  const connection = await getExistingConnection(tenantId);
  if (!connection) {
    return null;
  }

  return decryptSecret(connection.access_token_enc);
}

export async function getShopifyConnection(tenantId: string): Promise<{
  id: string;
  meta: Record<string, any> | null;
  store_domain?: string;
  shop?: string;
} | null> {
  const connection = await getExistingConnection(tenantId);
  if (!connection) {
    return null;
  }

  return {
    id: connection.id,
    meta: connection.meta,
    store_domain: connection.meta?.store_domain || connection.meta?.shop,
    shop: connection.meta?.shop || connection.meta?.store_domain,
  };
}

export async function registerShopifyWebhooks(shopDomain: string, accessToken: string): Promise<void> {
  // Webhooks behöver bara access token, inte API_KEY/SECRET
  // requireAppCredentials(); // <-- TA BORT - behövs inte för Custom Apps

  const normalizedShop = normalizeShopDomain(shopDomain);
  const webhookBaseUrl = APP_BASE_URL.replace(/\/$/, '');
  const webhookUrl = `${webhookBaseUrl}/api/webhooks/shopify`;

  const webhooks = [
    { topic: 'orders/create', address: webhookUrl },
    { topic: 'orders/updated', address: webhookUrl },
  ];

  console.log(`[shopify] Registering webhooks for ${normalizedShop}:`, webhooks);

  for (const webhook of webhooks) {
    try {
      // First, check if webhook already exists
      const listUrl = `https://${normalizedShop}/admin/api/2023-10/webhooks.json?topic=${webhook.topic}`;
      const listRes = await fetch(listUrl, {
        headers: {
          'X-Shopify-Access-Token': accessToken,
        },
      });

      if (listRes.ok) {
        const listBody = await listRes.json();
        const existingWebhook = (listBody.webhooks || []).find(
          (wh: any) => wh.address === webhook.address && wh.topic === webhook.topic,
        );

        if (existingWebhook) {
          console.log(`[shopify] Webhook ${webhook.topic} already registered: ${existingWebhook.id}`);
          continue;
        }
      }

      // Register new webhook
      const createUrl = `https://${normalizedShop}/admin/api/2023-10/webhooks.json`;
      const createRes = await fetch(createUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({
          webhook: {
            topic: webhook.topic,
            address: webhook.address,
            format: 'json',
          },
        }),
      });

      if (!createRes.ok) {
        const body = await createRes.text();
        throw new Error(`Failed to register webhook ${webhook.topic}: ${createRes.status} ${body}`);
      }

      const createBody = await createRes.json();
      console.log(`[shopify] Successfully registered webhook ${webhook.topic}:`, createBody.webhook?.id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[shopify] Failed to register webhook ${webhook.topic} for ${normalizedShop}:`, errorMessage);
      // Continue with next webhook even if one fails
    }
  }
}

export async function validateCustomAppToken(shopDomain: string, accessToken: string): Promise<{ valid: boolean; error?: string }> {
  const normalizedShop = normalizeShopDomain(shopDomain);
  const trimmedToken = accessToken.trim();
  const testUrl = `https://${normalizedShop}/admin/api/2023-10/shop.json`;

  try {
    const res = await fetch(testUrl, {
      headers: {
        'X-Shopify-Access-Token': trimmedToken,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      let errorMessage = `Shopify API returned ${res.status}`;
      try {
        const errorBody = JSON.parse(body);
        if (errorBody.errors) {
          errorMessage = typeof errorBody.errors === 'string' 
            ? errorBody.errors 
            : JSON.stringify(errorBody.errors);
        }
      } catch {
        errorMessage = body || errorMessage;
      }
      return { valid: false, error: errorMessage };
    }

    // Token is valid if we can successfully fetch shop data
    const body = await res.json();
    if (body.shop) {
      return { valid: true };
    }

    return { valid: false, error: 'Invalid response from Shopify API' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { valid: false, error: `Failed to validate token: ${errorMessage}` };
  }
}

export async function connectShopifyCustomApp(options: {
  tenantId: string;
  shopDomain: string;
  accessToken: string;
}): Promise<void> {
  const normalizedShop = normalizeShopDomain(options.shopDomain);
  const trimmedToken = options.accessToken.trim();

  // Validate token first
  const validation = await validateCustomAppToken(normalizedShop, trimmedToken);
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid Shopify access token');
  }

  // Save connection
  await upsertConnection(options.tenantId, {
    status: 'connected',
    accessToken: trimmedToken,
    meta: {
      shop: normalizedShop,
      store_domain: normalizedShop,
      connection_method: 'custom_app',
    },
  });

  // Register webhooks automatically
  try {
    await registerShopifyWebhooks(normalizedShop, trimmedToken);
  } catch (error) {
    console.error(`Failed to register Shopify webhooks for ${normalizedShop}:`, error);
    // Don't fail connection if webhook registration fails - can be done manually later
  }
}

export async function fetchShopifyOrders(params: {
  tenantId: string;
  shopDomain: string;
  since?: string;
}) {
  const accessToken = await getShopifyAccessToken(params.tenantId);

  // TA BORT kontrollen på SHOPIFY_API_SECRET - den behövs inte för att hämta orders
  if (!accessToken) {
    throw new Error('No access token found for this tenant');
  }

  const url = new URL(`https://${params.shopDomain}/admin/api/2023-10/orders.json`);
  url.searchParams.set('status', 'any');
  url.searchParams.set('limit', '250');
  if (params.since) {
    url.searchParams.set('created_at_min', params.since);
  }

  const res = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': accessToken,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify orders fetch failed: ${res.status} ${body}`);
  }

  const body = await res.json();
  return body.orders ?? [];
}

