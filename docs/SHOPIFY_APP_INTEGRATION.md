# Shopify App Integration Guide

Denna guide beskriver hur Shopify-appen ska integreras med analytics-plattformen för att hantera OAuth, datasynkning och webhooks med korrekt tenant-isolation.

## Översikt

Shopify-appen fungerar som en "plug and play"-koppling mellan Shopify och analytics-plattformen. Den hanterar:
- OAuth-flödet med tenant-val baserat på användaraccess
- Token-lagring i Supabase
- Datasynkning från Shopify till Supabase
- Webhooks för realtidsuppdateringar

## Viktiga koncept

### Roll-struktur

- **platform_admin** (super-admin): Har access till alla tenants, kan hantera platform admins
- **admin** (tenant admin): Har access till sin tenant, kan hantera tenant members
- **editor/viewer** (tenant user): Har access till sin tenant med begränsade rättigheter

### Tenant-isolation

Varje Shopify-butik kan bara kopplas till EN tenant. Validering sker vid:
1. OAuth-initiering - verifierar att användaren har access till valt tenant
2. OAuth callback - verifierar state-signatur och att shop inte redan är kopplad till annan tenant
3. Webhooks - hittar rätt tenant via shop domain

## API Endpoints i Huvudplattformen

### 1. GET `/api/shopify/tenants`

Hämtar lista över tenants som användaren har access till.

**Request:**
```
GET /api/shopify/tenants
Headers:
  Cookie: <session-cookie> (för autentisering)
```

**Response:**
```json
{
  "tenants": [
    {
      "id": "uuid",
      "name": "Tenant Name",
      "slug": "tenant-slug",
      "isConnected": false,
      "connectedShopDomain": null
    }
  ],
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "role": "platform_admin",
    "isPlatformAdmin": true
  }
}
```

**Logik:**
- Platform admins får alla tenants
- Vanliga användare får bara tenants de är medlem i
- Varje tenant inkluderar om Shopify redan är kopplad och vilken shop domain

### 2. POST `/api/shopify/oauth/init`

Initierar OAuth-flödet för en specifik tenant.

**Request:**
```json
POST /api/shopify/oauth/init
Content-Type: application/json
Cookie: <session-cookie>

{
  "tenantId": "uuid",
  "shopDomain": "store.myshopify.com"
}
```

**Response:**
```json
{
  "url": "https://store.myshopify.com/admin/oauth/authorize?...",
  "state": "base64-encoded-signed-state"
}
```

**Validering:**
- Kontrollerar att användaren har access till tenant (platform_admin eller medlem)
- Normaliserar shop domain
- Skapar signerad state med HMAC (inkluderar tenantId, shopDomain, userId, timestamp)

**State-struktur:**
```typescript
{
  data: {
    tenantId: string,
    shopDomain: string,
    userId: string,
    timestamp: number,
    nonce: string
  },
  sig: string // HMAC-SHA256 signature
}
```

## Implementation i Shopify-appen

### 1. Tenant-val UI (`/app/connect`)

När användaren öppnar Shopify-appen ska de först välja vilket tenant-konto de vill koppla till.

**Flow:**
1. Hämta tenants från `/api/shopify/tenants`
2. Visa dropdown/lista med tillgängliga tenants
3. Användaren väljer tenant
4. Klicka "Connect" → initierar OAuth

**Implementation:**
```typescript
// app/connect/page.tsx

'use client';

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

type Tenant = {
  id: string;
  name: string;
  slug: string;
  isConnected: boolean;
  connectedShopDomain: string | null;
};

export default function ConnectPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const shopDomain = searchParams.get('shop'); // Från Shopify session
  
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  
  useEffect(() => {
    loadTenants();
  }, []);
  
  async function loadTenants() {
    try {
      setLoading(true);
      // Hämta tenants från huvudplattformen
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_ANALYTICS_URL}/api/shopify/tenants`,
        {
          credentials: 'include', // Inkludera cookies för session
        }
      );
      
      if (!response.ok) {
        throw new Error('Failed to load tenants');
      }
      
      const data = await response.json();
      setTenants(data.tenants);
      setIsPlatformAdmin(data.user.isPlatformAdmin);
      
      // Auto-select om bara en tenant
      if (data.tenants.length === 1) {
        setSelectedTenantId(data.tenants[0].id);
      }
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }
  
  async function handleConnect() {
    if (!selectedTenantId || !shopDomain) {
      setError('Please select a tenant and ensure shop domain is available');
      return;
    }
    
    try {
      // Hämta OAuth URL från huvudplattformen med valt tenant
      const oauthResponse = await fetch(
        `${process.env.NEXT_PUBLIC_ANALYTICS_URL}/api/shopify/oauth/init`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            tenantId: selectedTenantId,
            shopDomain: shopDomain,
          })
        }
      );
      
      if (!oauthResponse.ok) {
        const errorData = await oauthResponse.json();
        throw new Error(errorData.error || 'Failed to initialize OAuth');
      }
      
      const { url } = await oauthResponse.json();
      
      // Redirecta till OAuth URL (Shopify hanterar resten)
      window.location.href = url;
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
    }
  }
  
  // ... resten av UI-koden ...
}
```

### 2. OAuth Callback (`/app/auth/oauth/callback`)

Validera state, extrahera tenantId och spara connection.

**Implementation:**
```typescript
// app/auth/oauth/callback/route.ts

import { redirect } from 'next/navigation';
import { createHmac } from 'crypto';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const shop = searchParams.get('shop');
  
  if (!code || !state || !shop) {
    return redirect('/app?error=missing_oauth_params');
  }
  
  try {
    // 1. Dekoda och validera state
    const stateDecoded = JSON.parse(
      Buffer.from(state, 'base64').toString()
    );
    
    if (!stateDecoded.data || !stateDecoded.sig) {
      throw new Error('Invalid state format');
    }
    
    // 2. Verifiera HMAC-signatur
    const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!; // Samma som i huvudplattformen
    const statePayload = JSON.stringify(stateDecoded.data);
    const expectedSig = createHmac('sha256', ENCRYPTION_KEY)
      .update(statePayload)
      .digest('hex');
    
    if (stateDecoded.sig !== expectedSig) {
      throw new Error('State signature verification failed');
    }
    
    // 3. Validera timestamp (max 10 minuter gammal)
    const stateAge = Date.now() - stateDecoded.data.timestamp;
    if (stateAge > 10 * 60 * 1000) {
      throw new Error('OAuth state expired');
    }
    
    // 4. Extrahera tenantId och shopDomain
    const { tenantId, shopDomain: expectedShopDomain } = stateDecoded.data;
    
    // 5. Normalisera och verifiera shop domain matchar
    const normalizedShop = shop
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '')
      .toLowerCase();
    
    if (normalizedShop !== expectedShopDomain) {
      throw new Error(`Shop domain mismatch: ${normalizedShop} !== ${expectedShopDomain}`);
    }
    
    // 6. VERIFIERA att shop inte redan är kopplad till en annan tenant
    const { data: existingConnection } = await supabase
      .from('connections')
      .select('tenant_id, meta')
      .eq('source', 'shopify')
      .eq('status', 'connected')
      .eq('meta->>store_domain', normalizedShop)
      .maybeSingle();
    
    if (existingConnection && existingConnection.tenant_id !== tenantId) {
      // Shop är redan kopplad till annan tenant - AVBRYT
      return redirect(
        `/app?error=${encodeURIComponent(
          'This Shopify store is already connected to another account. ' +
          'Please disconnect it first or contact support.'
        )}`
      );
    }
    
    // 7. Utför token exchange med Shopify
    const tokenEndpoint = `https://${normalizedShop}/admin/oauth/access_token`;
    const tokenRes = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY!,
        client_secret: process.env.SHOPIFY_API_SECRET!,
        code: code,
      }),
    });
    
    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${tokenRes.status}`);
    }
    
    const tokenData = await tokenRes.json();
    
    // 8. Spara connection i Supabase via huvudplattformens API
    // ELLER direkt i Supabase om du har service role key
    await saveConnection(tenantId, tokenData.access_token, normalizedShop);
    
    // 9. Redirect tillbaka till huvudplattformen eller status-sida
    return redirect(
      `${process.env.NEXT_PUBLIC_ANALYTICS_URL}/admin/tenants/${tenantSlug}/integrations?status=shopify-connected`
    );
    
  } catch (error) {
    console.error('OAuth callback validation failed:', error);
    return redirect(
      `/app?error=${encodeURIComponent(
        error instanceof Error ? error.message : 'OAuth validation failed'
      )}`
    );
  }
}

function normalizeShopDomain(domain: string): string {
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}
```

### 3. Webhook Tenant Lookup (`/webhooks/shopify`)

Hitta rätt tenant från shop domain när webhooks kommer in.

**Implementation:**
```typescript
// webhooks/shopify/route.ts

export async function POST(request: Request) {
  // 1. Verifiera HMAC-signatur
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256');
  const body = await request.text();
  
  const isValid = await verifyShopifyWebhook(body, hmacHeader);
  if (!isValid) {
    return new Response('Invalid HMAC', { status: 401 });
  }
  
  // 2. Extrahera shop domain från header
  const shopDomain = request.headers.get('x-shopify-shop-domain');
  if (!shopDomain) {
    return new Response('Missing shop domain', { status: 400 });
  }
  
  const normalizedShop = normalizeShopDomain(shopDomain);
  
  // 3. Hitta tenant via shop domain
  const { data: connection, error } = await supabase
    .from('connections')
    .select('tenant_id, status, meta, access_token_enc')
    .eq('source', 'shopify')
    .eq('status', 'connected')
    .eq('meta->>store_domain', normalizedShop)
    .maybeSingle();
  
  if (error) {
    console.error('Database error finding tenant:', error);
    return new Response('Database error', { status: 500 });
  }
  
  if (!connection) {
    console.warn(`Webhook received for unknown shop: ${normalizedShop}`);
    // Returnera 200 för att Shopify inte ska försöka igen
    // men logga för investigation
    return new Response('Shop not found', { status: 200 });
  }
  
  const tenantId = connection.tenant_id;
  
  // 4. Processera webhook med rätt tenantId
  const webhookData = JSON.parse(body);
  await processWebhook(tenantId, webhookData);
  
  return new Response('OK', { status: 200 });
}
```

### 4. Manual Sync (`/app/api/sync`)

Endpoint för manuell datasynkning.

**Implementation:**
```typescript
// app/api/sync/route.ts

export async function POST(request: Request) {
  // 1. Verifiera SYNC_SERVICE_KEY
  const authHeader = request.headers.get('authorization');
  const serviceKey = authHeader?.replace('Bearer ', '');
  
  if (serviceKey !== process.env.SYNC_SERVICE_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  const { tenantId, shopDomain } = await request.json();
  
  if (!tenantId || !shopDomain) {
    return new Response('Missing tenantId or shopDomain', { status: 400 });
  }
  
  const normalizedShop = normalizeShopDomain(shopDomain);
  
  // 2. Hämta connection för tenantId
  const { data: connection, error } = await supabase
    .from('connections')
    .select('tenant_id, meta, access_token_enc, status')
    .eq('tenant_id', tenantId)
    .eq('source', 'shopify')
    .eq('status', 'connected')
    .maybeSingle();
  
  if (error || !connection) {
    return new Response(
      `No connected Shopify account found for tenant ${tenantId}`,
      { status: 404 }
    );
  }
  
  // 3. VERIFIERA att shopDomain matchar connection
  const connectionShopDomain = normalizeShopDomain(
    connection.meta?.store_domain || ''
  );
  
  if (connectionShopDomain !== normalizedShop) {
    return new Response(
      `Shop domain mismatch: requested ${normalizedShop} but tenant is ` +
      `connected to ${connectionShopDomain}`,
      { status: 400 }
    );
  }
  
  // 4. Fortsätt med sync...
  // ... dekryptera token ...
  // ... hämta orders från Shopify ...
  // ... spara till Supabase ...
}
```

## Säkerhetsvalidering

### State Validation

**I huvudplattformen (`/api/shopify/oauth/init`):**
- Signerar state med HMAC-SHA256
- Inkluderar tenantId, shopDomain, userId, timestamp, nonce

**I Shopify-appen (callback):**
- Verifierar HMAC-signatur
- Validerar timestamp (max 10 minuter)
- Verifierar shop domain matchar

### Shop Domain Uniqueness

**Vid OAuth callback:**
- Kontrollera om shop redan är kopplad till annan tenant
- Om ja → neka och visa tydligt felmeddelande
- Om samma tenant → uppdatera befintlig connection

**Vid webhook:**
- Hitta tenant via `meta->>'store_domain'`
- Om shop inte finns → logga men returnera 200 (förhindra retries)

### Access Validation

**Vid OAuth-initiering:**
- Verifiera att användaren har access till valt tenant
- Platform admin → tillåt alltid
- Vanlig användare → verifiera membership

**I callback:**
- Validera att användaren fortfarande har access (optional men rekommenderat)

## Supabase Connection Structure

**connections tabell:**
```sql
{
  tenant_id: uuid,
  source: 'shopify',
  status: 'connected' | 'disconnected' | 'error',
  access_token_enc: bytea, -- Krypterad med AES-GCM
  refresh_token_enc: null, -- Shopify använder inte refresh tokens
  meta: {
    shop: 'store.myshopify.com',
    store_domain: 'store.myshopify.com', -- Normaliserad, för webhook lookup
    scope: 'read_orders',
    app_installed_at: '2024-...'
  }
}
```

## Environment Variables för Shopify-appen

```bash
# Supabase Connection (från huvudplattformen)
SUPABASE_URL=https://punicovacaktaszqcckp.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>

# Shopify App Credentials
SHOPIFY_API_KEY=<app_client_id>
SHOPIFY_API_SECRET=<app_client_secret>

# App Configuration
APP_BASE_URL=https://ohjay-dashboard.vercel.app
NEXT_PUBLIC_ANALYTICS_URL=https://ohjay-dashboard.vercel.app

# Encryption (måste matcha huvudplattformen)
ENCRYPTION_KEY=f1a2c3d4e5f60718293a4b5c6d7e8f90abcdeffedcba0987654321fedcba0123

# Sync Service Key (för manuell sync från huvudplattformen)
SYNC_SERVICE_KEY=<secret-key-for-sync-api>
```

## Testscenarier

1. ✅ Platform admin öppnar appen → ser alla tenants → kan välja vilken som helst
2. ✅ Vanlig användare med en tenant → ser bara sin tenant → auto-select
3. ✅ Vanlig användare med flera tenants → ser sina tenants → kan välja
4. ✅ Vanlig användare försöker OAuth med tenant de inte har access till → nekas med 403
5. ✅ Shop kopplas till Tenant A → fungerar
6. ✅ Samma shop försöker kopplas till Tenant B → nekas med tydligt meddelande
7. ✅ Webhook från känd shop → hittar rätt tenant
8. ✅ Webhook från okänd shop → returnerar 200 men loggar
9. ✅ Manual sync med fel shopDomain → nekas
10. ✅ Manual sync med rätt tenantId men fel shop → nekas

## Checklist för Implementation

### Huvudplattformen:
- [x] Skapa `/api/shopify/tenants` endpoint
- [x] Skapa `/api/shopify/oauth/init` endpoint
- [x] Uppdatera `getShopifyAuthorizeUrl` för att ta emot state
- [x] Uppdatera `handleShopifyOAuthCallback` för att normalisera shop domain

### Shopify-appen:
- [ ] Skapa `/app/connect` sida med tenant-dropdown
- [ ] Hämta tenants från huvudplattformens API
- [ ] Visa tenants baserat på behörigheter
- [ ] Auto-select om bara en tenant
- [ ] Uppdatera OAuth callback med state-validering
- [ ] Validera shop domain uniqueness
- [ ] Implementera webhook tenant lookup
- [ ] Implementera manual sync endpoint med validation
- [ ] Hantera fel-scenarier

### Säkerhet:
- [x] HMAC-signatur för state
- [x] Timestamp-validering
- [x] Shop domain normalisering
- [x] Shop uniqueness validation
- [ ] Access validation i callback (optional)

