import { createHmac, randomBytes } from 'crypto';

import { getSupabaseServiceClient } from '@/lib/supabase/server';

import { decryptSecret, encryptSecret } from './crypto';

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:3000';

const SHOPIFY_SCOPES = ['read_orders'];

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

function requireAppCredentials() {
  if (!SHOPIFY_API_KEY) {
    throw new Error('Missing SHOPIFY_API_KEY environment variable.');
  }

  if (!SHOPIFY_API_SECRET) {
    throw new Error('Missing SHOPIFY_API_SECRET environment variable.');
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
  requireAppCredentials();

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

function normalizeShopDomain(domain: string): string {
  return domain
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
  requireAppCredentials();

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

export async function verifyShopifyWebhook(payload: string, hmacHeader: string | null): Promise<boolean> {
  if (!SHOPIFY_API_SECRET) {
    console.warn('Missing SHOPIFY_API_SECRET; skipping webhook verification.');
    return true;
  }

  if (!hmacHeader) {
    return false;
  }

  const digest = createHmac('sha256', SHOPIFY_API_SECRET).update(payload).digest('base64');
  return digest === hmacHeader;
}

export async function getShopifyAccessToken(tenantId: string): Promise<string | null> {
  const connection = await getExistingConnection(tenantId);
  if (!connection) {
    return null;
  }

  return decryptSecret(connection.access_token_enc);
}

export async function registerShopifyWebhooks(shopDomain: string, accessToken: string): Promise<void> {
  requireAppCredentials();

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

export async function fetchShopifyOrders(params: {
  tenantId: string;
  shopDomain: string;
  since?: string;
}) {
  const accessToken = await getShopifyAccessToken(params.tenantId);

  if (!accessToken || !SHOPIFY_API_SECRET) {
    const today = new Date().toISOString().slice(0, 10);
    return [
      {
        id: `mock-order-${params.tenantId}`,
        processed_at: today,
        total_price: '120.50',
        subtotal_price: '110.00',
        total_discounts: '10.50',
        currency: 'USD',
        customer: { id: 'mock-customer' },
      },
    ];
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

