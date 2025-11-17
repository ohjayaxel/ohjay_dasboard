# Shopify App Implementation Guide

Denna guide ger steg-för-steg-instruktioner för att implementera Shopify-appen som integrerar med analytics-plattformen.

## Översikt

Shopify-appen fungerar som en "plug and play"-koppling mellan Shopify och analytics-plattformen. Den enda funktionaliteten som behöver implementeras i Shopify-appen är:

1. **Tenant-val UI** (`/app/connect`) - Användaren väljer vilket tenant-konto som ska kopplas till Shopify-butiken
2. **Webhooks** (`/webhooks/shopify`) - Hantera Shopify webhooks för orders/create och orders/updated
3. **Manual Sync API** (`/app/api/sync`) - Endpoint för manuell datasynkning från huvudplattformen

**VIKTIGT:** OAuth callback hanteras i huvudplattformen, inte i Shopify-appen.

## Prerequisites

- Shopify-app projektet är uppsatt med Shopify CLI
- Huvudplattformens API är tillgänglig på `https://ohjay-dashboard.vercel.app`
- Supabase credentials finns tillgängliga (samma som huvudplattformen)
- Shopify app credentials är konfigurerade

## Environment Variables

Sätt följande environment variables i Shopify-appen:

```bash
# Analytics Platform URL
NEXT_PUBLIC_ANALYTICS_URL=https://ohjay-dashboard.vercel.app

# Supabase (samma som huvudplattformen)
SUPABASE_URL=https://punicovacaktaszqcckp.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>

# Shopify App Credentials
SHOPIFY_API_KEY=<app_client_id>
SHOPIFY_API_SECRET=<app_client_secret>

# Encryption Key (måste matcha huvudplattformen för webhook-verifiering)
ENCRYPTION_KEY=<encryption_key>
```

## Steg 1: Skapa Connect-knapp i Shopify-appen

**VIKTIGT:** Tenant-val och OAuth-koppling hanteras nu på huvudplattformen. Shopify-appen behöver bara ha en enkel knapp som redirectar till huvudplattformen.

### 1.1 Skapa Connect-knapp

Skapa en enkel sida i Shopify-appen som redirectar till huvudplattformens connect-sida. Exempel för Remix (`app/routes/app.connect.tsx`):

```typescript
import { redirect } from '@remix-run/node';

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const shop = url.searchParams.get('shop');

  if (!shop) {
    return redirect('/app?error=missing_shop');
  }

  // Redirect till huvudplattformens connect-sida
  const analyticsUrl = process.env.NEXT_PUBLIC_ANALYTICS_URL || 'https://ohjay-dashboard.vercel.app';
  const connectUrl = `${analyticsUrl}/connect/shopify?shop=${encodeURIComponent(shop)}`;
  
  return redirect(connectUrl);
}
```

Eller för Next.js App Router (`app/app/connect/page.tsx`):

```typescript
'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

export default function ConnectPage() {
  const searchParams = useSearchParams();
  const shop = searchParams.get('shop');

  useEffect(() => {
    if (!shop) {
      window.location.href = '/app?error=missing_shop';
      return;
    }

    // Redirect till huvudplattformens connect-sida
    const analyticsUrl = process.env.NEXT_PUBLIC_ANALYTICS_URL || 'https://ohjay-dashboard.vercel.app';
    const connectUrl = `${analyticsUrl}/connect/shopify?shop=${encodeURIComponent(shop)}`;
    
    window.location.href = connectUrl;
  }, [shop]);

  return (
    <div className="p-8 text-center">
      <p>Redirecting to analytics platform...</p>
    </div>
  );
}
```

**Flöde:**
1. Användare öppnar Shopify-appen
2. Shopify-appen redirectar direkt till `https://ohjay-dashboard.vercel.app/connect/shopify?shop=store.myshopify.com`
3. Huvudplattformen visar tenant-val UI för inloggad användare
4. Användare väljer tenant → OAuth initieras direkt
5. Shopify OAuth → Callback i huvudplattformen → Redirect till integrations-sidan

### 1.2 Alternativ: Next.js App Router

Om du använder Next.js App Router, skapa `app/app/connect/page.tsx`:

```typescript
'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

// ... samma komponent-kod som ovan men utan loader ...
// Använd useEffect för att hämta tenants

export default function ConnectPage() {
  const searchParams = useSearchParams();
  const shop = searchParams.get('shop');
  
  // ... resten av implementationen ...
}
```

## Steg 2: Implementera Webhooks (`/webhooks/shopify`)

Shopify-appen behöver hantera webhooks för `orders/create` och `orders/updated` för att hitta rätt tenant och processera orders.

### 2.1 Skapa Webhook Route

Skapa filen `app/routes/webhooks.shopify.tsx` (eller motsvarande):

```typescript
import { json } from '@remix-run/node';
import { createHmac } from 'crypto';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET!;

function normalizeShopDomain(domain: string): string {
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function verifyShopifyWebhook(payload: string, hmacHeader: string | null): boolean {
  if (!SHOPIFY_API_SECRET) {
    console.warn('Missing SHOPIFY_API_SECRET; skipping webhook verification.');
    return true; // I development, kan du returnera true för att testa
  }

  if (!hmacHeader) {
    return false;
  }

  const digest = createHmac('sha256', SHOPIFY_API_SECRET)
    .update(payload)
    .digest('base64');

  return digest === hmacHeader;
}

export async function action({ request }: { request: Request }) {
  // 1. Verifiera HMAC-signatur
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256');
  const body = await request.text();

  const isValid = verifyShopifyWebhook(body, hmacHeader);
  if (!isValid) {
    console.error('Invalid HMAC signature for Shopify webhook');
    return json({ error: 'Invalid HMAC' }, { status: 401 });
  }

  // 2. Extrahera shop domain från header
  const shopDomain = request.headers.get('x-shopify-shop-domain');
  if (!shopDomain) {
    console.error('Missing shop domain in Shopify webhook');
    return json({ error: 'Missing shop domain' }, { status: 400 });
  }

  const normalizedShop = normalizeShopDomain(shopDomain);

  // 3. Hitta tenant via shop domain
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: connection, error: connectionError } = await supabase
    .from('connections')
    .select('tenant_id, status, meta, access_token_enc')
    .eq('source', 'shopify')
    .eq('status', 'connected')
    .eq('meta->>store_domain', normalizedShop)
    .maybeSingle();

  if (connectionError) {
    console.error('Database error finding tenant:', connectionError);
    return json({ error: 'Database error' }, { status: 500 });
  }

  if (!connection) {
    console.warn(`Webhook received for unknown shop: ${normalizedShop}`);
    // Returnera 200 för att Shopify inte ska försöka igen
    // Men logga för investigation
    return json({ message: 'Shop not found' }, { status: 200 });
  }

  const tenantId = connection.tenant_id;

  // 4. Processera webhook med rätt tenantId
  const webhookData = JSON.parse(body);
  const webhookTopic = request.headers.get('x-shopify-topic');

  try {
    await processWebhook(tenantId, webhookTopic, webhookData, supabase);
    return json({ status: 'ok' }, { status: 200 });
  } catch (error) {
    console.error('Failed to process webhook:', error);
    // Returnera 200 för att Shopify inte ska retrya för hårda fel
    // Men logga för investigation
    return json({ error: 'Processing failed' }, { status: 200 });
  }
}

async function processWebhook(
  tenantId: string,
  topic: string | null,
  data: any,
  supabase: any
) {
  if (topic === 'orders/create' || topic === 'orders/updated') {
    // Processera order-data och spara till Supabase
    // Detta beror på hur din databas-struktur ser ut
    // Exempel:

    const order = data;
    const orderData = {
      tenant_id: tenantId,
      shopify_order_id: order.id.toString(),
      order_number: order.order_number,
      processed_at: order.processed_at,
      created_at: order.created_at,
      updated_at: order.updated_at,
      total_price: parseFloat(order.total_price || '0'),
      subtotal_price: parseFloat(order.subtotal_price || '0'),
      total_discounts: parseFloat(order.total_discounts || '0'),
      total_tax: parseFloat(order.total_tax || '0'),
      currency: order.currency,
      customer_id: order.customer?.id?.toString() || null,
      email: order.email,
      financial_status: order.financial_status,
      fulfillment_status: order.fulfillment_status,
      raw_data: order, // Spara hela order-objektet som JSON
    };

    // Upsert order i shopify_orders tabellen
    const { error } = await supabase
      .from('shopify_orders')
      .upsert(orderData, {
        onConflict: 'tenant_id,shopify_order_id',
      });

    if (error) {
      throw new Error(`Failed to save order: ${error.message}`);
    }

    console.log(`Processed ${topic} webhook for tenant ${tenantId}, order ${order.id}`);
  }
}
```

### 2.2 Konfigurera Webhooks i shopify.app.toml

Lägg till webhooks i din `shopify.app.toml`:

```toml
[webhooks]
api_version = "2023-10"

[[webhooks.subscriptions]]
topics = ["orders/create", "orders/updated"]
uri = "/webhooks/shopify"
```

## Steg 3: Implementera Manual Sync API (`/app/api/sync`)

Om huvudplattformen behöver trigga manuell datasynkning från Shopify-appen.

### 3.1 Skapa Sync Route

Skapa filen `app/routes/app.api.sync.tsx`:

```typescript
import { json } from '@remix-run/node';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SYNC_SERVICE_KEY = process.env.SYNC_SERVICE_KEY!; // Secret key för autentisering

function normalizeShopDomain(domain: string): string {
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

export async function action({ request }: { request: Request }) {
  // 1. Verifiera SYNC_SERVICE_KEY
  const authHeader = request.headers.get('authorization');
  const serviceKey = authHeader?.replace('Bearer ', '');

  if (serviceKey !== SYNC_SERVICE_KEY) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { tenantId, shopDomain } = await request.json();

  if (!tenantId || !shopDomain) {
    return json({ error: 'Missing tenantId or shopDomain' }, { status: 400 });
  }

  const normalizedShop = normalizeShopDomain(shopDomain);

  // 2. Hämta connection för tenantId
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: connection, error: connectionError } = await supabase
    .from('connections')
    .select('tenant_id, meta, access_token_enc, status')
    .eq('tenant_id', tenantId)
    .eq('source', 'shopify')
    .eq('status', 'connected')
    .maybeSingle();

  if (connectionError || !connection) {
    return json(
      { error: `No connected Shopify account found for tenant ${tenantId}` },
      { status: 404 }
    );
  }

  // 3. VERIFIERA att shopDomain matchar connection
  const connectionShopDomain = normalizeShopDomain(
    (connection.meta as any)?.store_domain || ''
  );

  if (connectionShopDomain !== normalizedShop) {
    return json(
      {
        error: `Shop domain mismatch: requested ${normalizedShop} but tenant is connected to ${connectionShopDomain}`,
      },
      { status: 400 }
    );
  }

  // 4. Hämta access token (dekryptera om det behövs)
  // Detta beror på hur tokens är krypterade
  // För nu, anta att access_token_enc är krypterad och behöver dekrypteras
  // Du behöver använda samma encryption-logik som huvudplattformen

  // 5. Hämta orders från Shopify Admin API
  try {
    const orders = await fetchShopifyOrders(
      normalizedShop,
      connection.access_token_enc // Detta behöver dekrypteras
    );

    // 6. Spara orders till Supabase
    // ... implementation ...

    return json({ status: 'ok', ordersProcessed: orders.length });
  } catch (error) {
    console.error('Failed to sync orders:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    );
  }
}

async function fetchShopifyOrders(shopDomain: string, accessToken: string) {
  const url = new URL(`https://${shopDomain}/admin/api/2023-10/orders.json`);
  url.searchParams.set('status', 'any');
  url.searchParams.set('limit', '250');

  const res = await fetch(url.toString(), {
    headers: {
      'X-Shopify-Access-Token': accessToken,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify orders fetch failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  return data.orders || [];
}
```

## Steg 4: Konfigurera Shopify App Settings

### 4.1 Redirect URI

I Shopify Partner Dashboard, se till att Redirect URI är satt till:
```
https://ohjay-dashboard.vercel.app/api/oauth/shopify/callback
```

**VIKTIGT:** OAuth callback hanteras i huvudplattformen, inte i Shopify-appen.

### 4.2 Scopes

Se till att din Shopify-app har rätt scopes:
- `read_orders` (minsta krav)

## Steg 5: Testa Implementationen

### 5.1 Test Tenant-val

1. Öppna Shopify-appen i en butik
2. Verifiera att `/app/connect` visar tillgängliga tenants
3. Välj en tenant och klicka "Connect"
4. Verifiera att OAuth-flödet fungerar och redirectar tillbaka till integrations-sidan

### 5.2 Test Webhooks

1. Skapa en test-order i Shopify
2. Verifiera att webhook anländer och processeras korrekt
3. Kontrollera att order sparas i Supabase med rätt tenantId

### 5.3 Test Manual Sync

1. Anropa `/app/api/sync` med korrekt autentisering
2. Verifiera att orders hämtas och sparas korrekt

## Troubleshooting

### Problem: "Authentication required" när man hämtar tenants

**Lösning:** Användaren måste vara inloggad i huvudplattformen. Redirect till signin-sidan:

```typescript
window.location.href = `${ANALYTICS_URL}/signin?redirect=${encodeURIComponent(window.location.href)}`;
```

### Problem: Webhooks anländer men hittar inte rätt tenant

**Lösning:** 
- Verifiera att `meta->>store_domain` matchar shop domain exakt (normaliserad)
- Kontrollera att connection status är 'connected'
- Logga shop domain från webhook header för debugging

### Problem: OAuth callback fungerar inte

**Lösning:**
- OAuth callback hanteras i huvudplattformen, inte i Shopify-appen
- Verifiera att Redirect URI i Shopify Partner Dashboard är korrekt
- Kontrollera att state-validering fungerar i huvudplattformen

## Checklist

- [ ] Environment variables är konfigurerade
- [ ] `/app/connect` sida är implementerad
- [ ] Tenant-dropdown fungerar och hämtar från huvudplattformens API
- [ ] OAuth-initiering redirectar korrekt
- [ ] Webhooks är konfigurerade i shopify.app.toml
- [ ] Webhook route hittar rätt tenant via shop domain
- [ ] Orders processeras och sparas korrekt i Supabase
- [ ] Manual sync API fungerar (om behövs)
- [ ] Error handling är implementerad
- [ ] Logging är på plats för debugging

## Support

Om du stöter på problem:

1. Kontrollera logs i Shopify-appen
2. Verifiera att huvudplattformens API fungerar
3. Kontrollera Supabase connections-tabellen för connection status
4. Verifiera att shop domain är normaliserat konsekvent

