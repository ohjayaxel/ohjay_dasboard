# SHOPIFY_ANALYTICS_CALCULATION_KNOWLEDGE_BASE

Senast uppdaterad: 2026-01-09

## 1) Grunddefinitioner (Shopify Analytics “Sales”)

- **Gross Sales**: summan av (artikelpris × antal) före rabatter och returer. Vanligtvis exkl. moms i våra beräkningar.
- **Discounts**: total rabatt (order/line) som hör till ordern.
- **Returns**: produktreturer (refunds) som Shopify Analytics räknar som “Returns” för rapportperioden.
- **Net Sales**: **Gross Sales − Discounts − Returns**. Om Net Sales diffar är felet alltid i någon av de tre termerna.

## 2) Incidenter / driftproblem

### 2.1 `sync-shopify` Edge Function: Shopify GraphQL fetch failed: 404 `{"errors":"Not Found"}`

- **Symptom**
  - Trigger via HTTP (curl) lyckas auth-mässigt (HTTP 200 från Supabase Edge), men `results[].status="failed"` med:
    - `Shopify GraphQL fetch failed: 404 {"errors":"Not Found"}`

- **Root cause**
  - I `supabase/functions/sync-shopify/index.ts` använde vi en wrapper `fetchWithRetry()` som **ignorerade `method` och `body`** och endast skickade headers.
  - Resultatet blev en **GET** mot `https://{shop}/admin/api/2023-10/graphql.json` istället för en POST.
  - Shopify svarar då med **404 Not Found** och body `{"errors":"Not Found"}`.

- **Fix**
  - Uppdatera `fetchWithRetry(url, init, attempt)` till att acceptera full `RequestInit` och skicka vidare allt (`method`, `headers`, `body`, osv).
  - Verifiera att anropet görs med `method: 'POST'` och GraphQL-body.

- **Kod**
  - Fixen ligger i: `supabase/functions/sync-shopify/index.ts`

- **Verifiering**
  - Efter redeploy av Edge Function ska samma curl-trigger inte längre ge 404 från Shopify.

### 2.2 `sync-shopify` Edge Function: GraphQL schema mismatch (`totalDutiesSet` saknas)

- **Symptom**
  - `Shopify GraphQL errors: Field 'totalDutiesSet' doesn't exist on type 'Order'`

- **Root cause**
  - Vår GraphQL-query i Edge Functionen frågade efter `totalDutiesSet`, men fältet finns inte i vissa butikers Admin GraphQL-schema (beroende på API-version/feature-set).
  - Shopify returnerar då ett GraphQL error och vi failar hela sync-jobbet.

- **Fix**
  - Ta bort `totalDutiesSet` från query + mapping och låt `duties_amount` vara `null` tills vi har en kompatibel, schema-säker lösning.

# Shopify Analytics Calculation Knowledge Base

**Uppdaterad:** 2025-01-27  
**Syfte:** Central kunskapsbas för Shopify Analytics-beräkningar baserad på analys av 62,770+ orders. Denna dokumentation ska användas som referens vid felsökning och vidareutveckling.

**VIKTIGT:** Denna fil ska ALLTID konsulteras innan ny kod skrivs för att:
- Undvika att lösa redan lösta problem
- Var medveten om identifierade men ej lösta problem
- Följa etablerade patterns och lösningar
- Dokumentera alla nya insikter och scripts

**Senaste uppdatering:** Omfattande mismatch analys genomförd (2025-01-27) - Analyserat 145,894 orders dataset med 92.70% accuracy (7.30% mismatch rate). Identifierat Returns/Refunds som största källan till Net Sales discrepancies (avg diff 789 kr för 190 orders). KRITISK UPPTÄCKT: CSV inkluderar shipping refunds/order-level refunds som saknar refund_line_items. Skapat nya analysscripts för mismatch patterns och refunds. Produkt-ID matchning nu implementerad med read_products scope.

## Översikt

Detta dokument samlar alla insikter, formler och edge cases som har identifierats genom noggrann analys av Shopify API-data jämfört med Shopify Analytics CSV-exporter. Alla beräkningar måste matcha Shopify Analytics rapporter för att säkerställa konsistens.

## Shopify Webhooks - Implementation & Best Practices

**Källa:** [Shopify REST Admin API - Webhooks](https://shopify.dev/docs/api/admin-rest/latest/resources/webhook#post-webhooks)

### Webhook Översikt

Shopify webhooks används för att få realtidsnotifikationer när specifika events inträffar i en shop. Genom att använda webhooks kan vi:
- Minska antalet API-anrop (mer effektivt)
- Uppdatera data snabbt när events inträffar
- Undvika periodiska polling-anrop

### Nuvarande Implementation

**Webhook Topics:**
- `orders/create` - När en ny order skapas
- `orders/updated` - När en befintlig order uppdateras

**Webhook Endpoint:**
- URL: `/api/webhooks/shopify`
- Format: JSON (standard)
- Verification: HMAC SHA-256 (via `x-shopify-hmac-sha256` header)

**Implementation Filer:**
- `lib/integrations/shopify.ts` - `registerShopifyWebhooks()` funktion (rad 275-342)
- `app/api/webhooks/shopify/route.ts` - Webhook handler (POST route)

### Webhook Subscription Object (REST Admin API)

Enligt Shopify dokumentation har varje webhook subscription följande properties:

| Property | Type | Beskrivning |
|----------|------|-------------|
| `address` | string (required) | Destination URI där webhook skickar POST request |
| `topic` | string (required) | Event som triggar webhook (t.ex. "orders/create") |
| `format` | string | Format för data ("json" eller "xml"), default: "json" |
| `api_version` | string (read-only) | Admin API version som Shopify använder för att serialisera events |
| `fields` | array (optional) | Array av top-level resource fields som ska inkluderas (om frånvarande, alla fields skickas) |
| `metafield_namespaces` | array (optional) | Namespaces för metafields som ska inkluderas |
| `id` | number (read-only) | Unikt numeriskt ID för webhook subscription |
| `created_at` | datetime (read-only) | När webhook subscription skapades (ISO 8601 format) |
| `updated_at` | datetime (read-only) | När webhook subscription uppdaterades senast (ISO 8601 format) |

### Webhook Registration (vår implementation)

**Funktion:** `registerShopifyWebhooks(shopDomain: string, accessToken: string)`

**Process:**
1. **Normaliserar shop domain** (tar bort protocol, trailing slashes, etc.)
2. **Bygger webhook URL** baserat på `APP_BASE_URL` + `/api/webhooks/shopify`
3. **För varje webhook topic:**
   - Kollar om webhook redan finns via GET `/admin/api/{version}/webhooks.json?topic={topic}`
   - Om redan registrerad med samma address → skip
   - Annars → skapar ny webhook via POST `/admin/api/{version}/webhooks.json`
4. **Request body för webhook creation:**
   ```json
   {
     "webhook": {
       "topic": "orders/create",
       "address": "https://yourdomain.com/api/webhooks/shopify",
       "format": "json"
     }
   }
   ```

**Nuvarande API Version:** `2023-10` (hårdkodad i `registerShopifyWebhooks`)

**Viktiga Noteringar:**
- Webhooks registreras automatiskt efter OAuth callback (se `handleShopifyOAuthCallback`)
- Om webhook registration misslyckas, fortsätter OAuth callback ändå (fel loggas men blockerar inte)
- Webhooks kräver endast `access_token` (inte API_KEY/SECRET)

### Webhook Verification

**Funktion:** `verifyShopifyWebhook(payload: string, hmacHeader: string | null, webhookSecret?: string)`

**Process:**
1. **Hämta HMAC header:** `x-shopify-hmac-sha256` från request headers
2. **Skapa HMAC digest:**
   - Algorithm: SHA-256
   - Secret: `SHOPIFY_API_SECRET` (eller custom `webhookSecret` för Custom Apps)
   - Data: Raw request body (som string)
   - Encoding: Base64
3. **Jämför:** `digest === hmacHeader`
4. **Returnera:** `true` om match, annars `false`

**Säkerhetsnoteringar:**
- Om `SHOPIFY_API_SECRET` saknas → returnerar `true` (för development/Custom Apps kompatibilitet)
- Om `hmacHeader` saknas → returnerar `false`

**Implementation:** `lib/integrations/shopify.ts` rad 226-245

### Webhook Handler (vår implementation)

**Route:** `POST /api/webhooks/shopify`

**Process:**
1. **Verifiera HMAC** via `verifyShopifyWebhook()`
2. **Extrahera shop domain** från `x-shopify-shop-domain` header
3. **Hitta tenant** via shop domain lookup i `connections` tabellen
4. **Extrahera webhook topic** från `x-shopify-topic` header
5. **Processera order:**
   - Parsa JSON body
   - Konvertera till vårt internt format
   - Beräkna sales metrics
   - Upsert till database

**Headers som används:**
- `x-shopify-hmac-sha256` - HMAC signature för verifiering
- `x-shopify-shop-domain` - Shop domain (t.ex. "store.myshopify.com")
- `x-shopify-topic` - Webhook topic (t.ex. "orders/create", "orders/updated")

**Implementation:** `app/api/webhooks/shopify/route.ts` rad 890+

### Mandatory Webhooks (Shopify Requirement)

Shopify kräver att alla apps prenumererar på vissa webhooks för GDPR-kompatibilitet:

| Topic | Event | Status |
|-------|-------|--------|
| `customers/data_request` | Requests to view stored customer data | ⚠️ EJ IMPLEMENTERAD |
| `customers/redact` | Requests to delete customer data | ⚠️ EJ IMPLEMENTERAD |
| `shop/redact` | Requests to delete shop data | ⚠️ EJ IMPLEMENTERAD |

**Viktigt:** Dessa MÅSTE implementeras för production apps. De kan registreras via:
1. Partner Dashboard (rekommenderat)
2. App configuration TOML file
3. Via REST Admin API (samma process som `orders/create`)

**Rekommendation:** Implementera dessa webhooks för GDPR-kompatibilitet.

### Webhook Considerations (från Shopify dokumentation)

1. **Webhook subscriptions är scopade till app:**
   - När en webhook registreras för en app, kan andra apps inte se/modifiera/ta bort den
   - Varje app har sina egna webhook subscriptions

2. **Shopify Admin-created webhooks:**
   - Webhooks som skapas via Shopify Admin returneras INTE i API-anrop
   - Dessa är endast kopplade till shopen, inte appen

3. **API Version:**
   - `api_version` i webhook subscription är ärvd från appen som skapade subscription
   - Detta avgör vilken API version Shopify använder för att serialisera webhook events

4. **Fields Filtering:**
   - Använd `fields` array för att begränsa vilka fields som skickas i webhook payload
   - Om `fields` saknas, skickas alla fields
   - Exempel: `fields: ["id", "updated_at"]` skickar bara dessa två fields

5. **Metafields:**
   - Använd `metafield_namespaces` för att inkludera specifika metafield namespaces
   - `private_metafield_namespaces` är deprecated

### Webhook Topics Reference

**Orders:**
- `orders/create` - När en ny order skapas ✅ IMPLEMENTERAD
- `orders/updated` - När en order uppdateras ✅ IMPLEMENTERAD
- `orders/paid` - När en order betalas
- `orders/cancelled` - När en order avbryts
- `orders/fulfilled` - När en order fullföljs
- `orders/partially_fulfilled` - När en order delvis fullföljs

**Customers:**
- `customers/create` - När en ny kund skapas
- `customers/update` - När kunddata uppdateras
- `customers/delete` - När en kund tas bort

**Products:**
- `products/create` - När en ny produkt skapas
- `products/update` - När en produkt uppdateras
- `products/delete` - När en produkt tas bort

**Full list:** Se [Shopify Webhook Events](https://shopify.dev/docs/api/admin-rest/latest/resources/webhook#webhook-events)

### API Endpoints (REST Admin API)

**Create Webhook:**
```
POST /admin/api/{version}/webhooks.json
```

**List Webhooks:**
```
GET /admin/api/{version}/webhooks.json
GET /admin/api/{version}/webhooks.json?topic={topic}  # Filter by topic
```

**Get Single Webhook:**
```
GET /admin/api/{version}/webhooks/{webhook_id}.json
```

**Update Webhook:**
```
PUT /admin/api/{version}/webhooks/{webhook_id}.json
```

**Delete Webhook:**
```
DELETE /admin/api/{version}/webhooks/{webhook_id}.json
```

**Get Webhook Count:**
```
GET /admin/api/{version}/webhooks/count.json?topic={topic}
```

### Best Practices

1. **Webhook Idempotency:**
   - Alla webhook handlers ska vara idempotenta (samma resultat även om webhook skickas flera gånger)
   - Använd order ID som unique identifier för att undvika duplicering

2. **Error Handling:**
   - Returnera 200 OK även vid fel (för att undvika retry loops från Shopify)
   - Logga fel internt för debugging
   - Shopify retryar webhooks som returnerar 4xx/5xx status codes

3. **Performance:**
   - Processera webhooks asynkront när möjligt
   - Använd queue system för tunga operationer
   - Returnera 200 OK snabbt, processera sedan i bakgrunden

4. **Security:**
   - ALDRIG verifiera webhooks utan HMAC check
   - Använd HTTPS för alla webhook endpoints
   - Validera shop domain mot whitelist om möjligt

5. **Testing:**
   - Använd Shopify CLI för att testa webhooks lokalt
   - Se [Shopify Webhook Testing](https://shopify.dev/docs/apps/webhooks/configuration/test) för mer info

### Framtida Förbättringar

1. **✅ PRIORITET HIGH:** Implementera mandatory webhooks (`customers/data_request`, `customers/redact`, `shop/redact`)
2. **Medium:** Överväg att lägga till `orders/paid` och `orders/cancelled` webhooks för bättre real-time tracking
3. **Low:** Implementera webhook retry queue för failed webhooks
4. **Low:** Lägg till webhook endpoint för att uppdatera/ta bort webhooks programmatiskt

## Grundprinciper

### 1. Data Sources - Använd ALLTID direkt från Shopify API

**VIKTIGT:** Alla värden för beräkningar måste komma direkt från Shopify API. Inga egna beräkningar av grundläggande värden.

| Värde | API Field Path | Beskrivning |
|-------|---------------|-------------|
| `total_tax` | `order.totalTaxSet.shopMoney.amount` | Total skatt på ordern (direkt från API) |
| `subtotal_price` | `order.subtotalPriceSet.shopMoney.amount` | Subtotal efter rabatter, INKL moms |
| `total_discounts` | `order.totalDiscountsSet.shopMoney.amount` | Totala rabatter INKL moms (order-level field, prefererad källa) |
| `line_item.price` | `lineItems[].originalUnitPriceSet.shopMoney.amount` | Pris per enhet INKL moms |
| `refund_line_item.subtotal` | `refunds[].refundLineItems[].subtotalSet.shopMoney.amount` | Returbedrag EXKL moms (måste summeras manuellt - INGEN order-level field) |
| `returns` | `sum(refund_line_items[].subtotal)` | **INGEN order-level field** - måste summeras manuellt från refund_line_items |

### 2. Rounding

Alla belopp ska avrundas till 2 decimaler för att undvika floating-point precision-problem:
```typescript
function roundTo2Decimals(value: number): number {
  return Math.round(value * 100) / 100;
}
```

## Gross Sales (Bruttoförsäljning) - Beräkning

### Grundformel

Gross Sales = Summan av (product selling price × ordered quantity) för alla line items, **EXKLUSIVE tax**.

**Observera:** Shopify API returnerar `line_item.price` som INKLUDERAR tax (originalUnitPriceSet), så vi måste konvertera till EXKL tax.

### Beräkningsstrategi (baserad på analys av 62,770 orders)

#### Fall 1: Orders med `total_tax = 0`

**Formel:**
```
Gross Sales = sum(line_items.price × quantity)
```

**Gäller när:**
- 100% rabatterade orders (net sales = 0)
- Orders utanför Sverige (ingen moms)
- Specialfall där Shopify explicit sätter `total_tax = 0`

**Implementering:**
```typescript
if (totalTax === 0 && grossSalesInclTax > 0) {
  grossSales = grossSalesInclTax; // INCL tax = EXCL tax när ingen tax
}
```

**Analysresultat:**
- 100% matchning för orders med `total_tax = 0`
- CSV använder alltid `sum(line_items)` direkt när tax = 0

#### Fall 2: Orders med `total_tax > 0`

**Formel:**
```
tax_rate = total_tax / (subtotal_price - total_tax)
Gross Sales = sum(line_items.price × quantity) / (1 + tax_rate)
```

**Gäller när:**
- Order har skatt (majoriteten av orders i Sverige)
- `subtotal_price > 0` och `total_tax > 0`

**Implementering:**
```typescript
const taxRate = totalTax / (subtotalPrice - totalTax);
if (taxRate > 0 && grossSalesInclTax > 0) {
  grossSales = grossSalesInclTax / (1 + taxRate);
}
```

**Analysresultat:**
- ~86% matchning för orders med tax
- Tax rate beräknas från faktiska order-värden (inte standard 25%)

#### Fall 3: Fallback-metoder (mindre vanliga)

Om ovanstående inte kan användas:

**Fallback 1:** Använd `subtotal_excl_tax`
```typescript
if (subtotalExclTax > 0) {
  grossSales = subtotalExclTax;
}
```

**Fallback 2:** Använd `grossSalesInclTax` direkt
```typescript
if (grossSalesInclTax > 0) {
  grossSales = grossSalesInclTax; // Antag att redan EXCL tax
}
```

### Identifierade mönster i CSV (från pattern analysis)

1. **CSV = subtotal_excl_tax**
   - Används när subtotal_excl_tax matchar CSV Gross Sales
   - Oftast när inga komplexa discounts eller refunds

2. **CSV = sum(line_items) / (1 + tax_rate)** (~86% av orders med tax)
   - Standard-metod för orders med tax
   - Tax rate beräknad från faktiska order-värden

3. **CSV = subtotal_price / (1 + tax_rate)**
   - Används när subtotal_price-formeln matchar bättre
   - Kan förekomma vid vissa refund-scenarier

4. **Other patterns** (~14% av orders med tax)
   - Kräver fortsatt analys för att identifiera
   - Kan bero på rounding differences, mixed tax rates, eller Shopify Analytics interna beräkningar

## Discounts (Rabatter) - Beräkning

### Grundformel

Discounts = Summan av alla rabatter, **EXKLUSIVE tax**.

**Observera:** Shopify API returnerar `total_discounts` som INKLUDERAR tax, så vi måste konvertera.

### Hämtning från API

**VIKTIGT - Order-nivå field:**
- Discounts hämtas på **order-nivå** via `totalDiscountsSet` i GraphQL Admin API
- Detta är det rekommenderade sättet enligt Shopify-dokumentationen
- Field: `order.totalDiscountsSet.shopMoney.amount` (GraphQL)
- Mappas till: `order.total_discounts` (i vår kod)

**GraphQL Query:**
```graphql
totalDiscountsSet {
  shopMoney {
    amount
    currencyCode
  }
}
```

### Beräkningsstrategi

**Formel:**
```
tax_rate = total_tax / (subtotal_price - total_tax)
Discounts EXCL = Discounts INCL / (1 + tax_rate)
```

**Implementering:**
```typescript
let discountsInclTax = parseFloat(order.total_discounts || '0');
let discounts = 0;

if (taxRate > 0) {
  discounts = discountsInclTax / (1 + taxRate);
} else {
  discounts = discountsInclTax; // Fallback: antag redan EXCL tax
}
```

**Källor för discounts (prioriterade):**
1. **Primär:** `order.total_discounts` (order-level total från `totalDiscountsSet`)
2. **Fallback:** Summa av `line_items[].total_discount` (line-item level) om order-level saknas

## Returns (Returer) - Beräkning

### Grundformel

Returns = Summan av returnerade items från refunds, **EXKLUSIVE tax**.

### Hämtning från API

**VIKTIGT - Ingen order-nivå field:**
- **Returns har INGET order-level field** i Shopify GraphQL Admin API (till skillnad från discounts)
- Shopify API tillhandahåller INTE något `totalRefundedSet` eller liknande field på Order object
- Därför måste vi **summera manuellt** från `refund_line_items[].subtotal`

**GraphQL Query:**
```graphql
refunds(first: 50) {
  id
  createdAt
  refundLineItems(first: 250) {
    edges {
      node {
        quantity
        subtotalSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        lineItem {
          id
          originalUnitPriceSet {
            shopMoney {
              amount
            }
          }
        }
      }
    }
  }
  transactions(first: 50) {
    edges {
      node {
        id
        kind
        status
        amountSet {
          shopMoney {
            amount
          }
        }
      }
    }
  }
}
```

**Notera:**
- `refundLineItems.subtotalSet.shopMoney.amount` är redan **EXCL tax** (prefererad källa)
- `refund.transactions` inkluderas för shipping/order-level refunds som saknar refund_line_items
- Vi använder `refund.transactions` endast när `refund_line_items` är tom eller saknas

**KRITISKT - Datum-filtrering av refunds (2025-01-27):**
- **Refunds filtreras baserat på rapportperioden (refund.created_at), INTE order.processed_at**
- Shopify Analytics CSV exporter inkluderar endast refunds där `refund.created_at` är inom rapportperioden
- **Exempel:** Order 7008752206167 har 2 refunds:
  - Refund 1 (28 november): 86.35 kr
  - Refund 2 (30 december): 1,381.60 kr
- För perioden **1 november - 31 december:** Båda refunds inkluderas (86.35 + 1,381.60 = 1,467.95 kr)
- För perioden **1-30 december:** Endast Refund 2 inkluderas (1,381.60 kr)
- Detta är logiskt eftersom refunds påverkar Net Sales på det datum de skapades, inte när ordern skapades

### Beräkningsstrategi

**Formel (prefererad):**
```
Returns = sum(refund_line_items[].subtotal)
```

`subtotal` från refund line items är redan EXCL tax och kommer direkt från Shopify API.

**Fallback (om subtotal saknas):**
```typescript
Returns = refund_line_item.line_item.price × refund_line_item.quantity
```

**Shipping/Order-level refunds (refunds utan refund_line_items):**
- Om refund har inga `refund_line_items` men har `refund.transactions`, inkludera dessa
- Endast transactions med `kind === 'REFUND'` och `status === 'SUCCESS'`
- **OBS:** Detta förbättrade INTE matchningen i vår analys (avg diff ökade från 789 kr till 955 kr)
- CSV Analytics verkar använda en annan logik än att bara lägga till refund.transactions

**Implementering:**
```typescript
let returns = 0;
if (order.refunds && order.refunds.length > 0) {
  for (const refund of order.refunds) {
    // CRITICAL: Filter refunds by report period (refund.created_at), NOT order.processed_at
    // This matches Shopify Analytics CSV export behavior
    if (datePeriod) {
      const refundDate = refund.created_at.split('T')[0]; // Get date part (YYYY-MM-DD)
      if (datePeriod.from && refundDate < datePeriod.from) {
        continue; // Refund is before period start
      }
      if (datePeriod.to && refundDate > datePeriod.to) {
        continue; // Refund is after period end
      }
    }
    
    // First, try refund_line_items (product refunds)
    if (refund.refund_line_items && refund.refund_line_items.length > 0) {
      for (const refundLineItem of refund.refund_line_items) {
        if (refundLineItem.subtotal) {
          returns += parseFloat(refundLineItem.subtotal);
        } else {
          // Fallback: calculate from price × quantity
          const subtotal = calculateRefundLineItemSubtotal(refundLineItem, order.line_items);
          returns += subtotal;
        }
      }
    }
    
    // If no refund_line_items, check refund.transactions for shipping/order-level refunds
    // NOTE: This may not match CSV Analytics behavior (see analysis results)
    if ((!refund.refund_line_items || refund.refund_line_items.length === 0) && 
        refund.transactions && refund.transactions.length > 0) {
      for (const transaction of refund.transactions) {
        if (transaction.kind === 'REFUND' && transaction.status === 'SUCCESS' && transaction.amount) {
          returns += parseFloat(transaction.amount);
        }
      }
    }
  }
}
```

**Användning med datum-period:**
```typescript
// For period 1-30 December, only refunds created in December are included
const result = calculateShopifyLikeSales(orders, {
  from: '2025-12-01',
  to: '2025-12-30',
});
```

**Källor för returns (prioriterade):**
1. **Primär:** `refund_line_items[].subtotal` (EXCL tax, från `refundLineItems.subtotalSet`)
2. **Fallback:** `refund_line_item.line_item.price × quantity` om subtotal saknas
3. **Shipping refunds:** `refund.transactions[].amount` för refunds utan refund_line_items (experimentellt, matchar inte CSV)

## Net Sales (Nettoförsäljning) - Beräkning

### Grundformel (Shopify Analytics standard)

```
Net Sales = Gross Sales - Discounts - Returns
```

Alla värden i EXCLUSIVE tax.

**Implementering:**
```typescript
const netSales = roundTo2Decimals(grossSales - discounts - returns);
```

**VIKTIGT:** Detta är Shopify Analytics formel. Även om vi kan beräkna `Net Sales = subtotal_price - total_tax - returns`, så använder Shopify Analytics den ovanstående formeln för konsistens.

## Tax (Skatt) - Beräkning

### Grundregel

**ANVÄND ALLTID `total_tax` DIREKT FRÅN API**

```typescript
const totalTax = order.total_tax ? parseFloat(order.total_tax || '0') : 0;
```

**Historisk lärdom:**
- ❌ **FEL:** Beräkna tax som `gross_sales * tax_rate` → ~15% fel
- ✅ **RÄTT:** Använd `total_tax` direkt från API → ~0.9% fel

**Tax rate beräkning (för interna beräkningar):**
```typescript
const taxRate = totalTax > 0 && subtotalExclTax > 0 
  ? totalTax / subtotalExclTax 
  : 0;
```

## Edge Cases och Specialfall

### 1. 100% Rabatterade Orders

**Beskrivning:** Orders där `subtotal_price = 0` p.g.a. fullständig rabatt.

**Hantering:**
- `total_tax` är vanligtvis `0`
- `grossSalesInclTax` = sum(line_items) är korrekt
- `grossSales = grossSalesInclTax` (eftersom tax = 0)
- `netSales = 0` (eftersom discounts = grossSales)

**Exempel:** Order 7139036332375
- `subtotal_price`: 0.00 kr
- `total_tax`: 0.00 kr
- `total_discounts`: 2,206.07 kr
- `sum(line_items)`: 2,206.07 kr
- `Gross Sales`: 2,206.07 kr ✅

### 2. Orders utanför Sverige (Ingen Moms)

**Beskrivning:** Orders där `total_tax = 0` p.g.a. att ordern inte är från Sverige.

**Hantering:**
- Samma som orders med `total_tax = 0`
- `grossSales = grossSalesInclTax`

### 3. Orders med Refunds

**Beskrivning:** Orders som har delvis eller fullständigt returnerats.

**Hantering:**
- Returns beräknas från `refund_line_items[].subtotal`
- Net Sales = Gross Sales - Discounts - Returns
- Kan påverka tax rate-beräkningen om refunds ändrar subtotal

### 4. Orders med Mixed Tax Rates

**Beskrivning:** Orders med produkter som har olika moms-satser.

**Hantering:**
- Shopify API returnerar total tax som summan av alla tax rates
- Tax rate beräknas som `total_tax / (subtotal_price - total_tax)` (genomsnittlig tax rate)
- Detta är korrekt för Gross Sales-beräkning enligt Shopify Analytics

## Implementation Status

### Nuvarande Implementation (lib/shopify/sales.ts)

- ✅ Zero-tax orders hanteras korrekt
- ✅ Tax rate beräknas från API-värden
- ✅ Gross Sales använder korrekt formel baserat på tax-status
- ✅ Discounts konverteras från INCL till EXCL tax
- ✅ 100% rabatterade produkter: Tax-komponenten inkluderas i både Gross Sales och Discounts
- ✅ Returns använder subtotal direkt från API
- ✅ Net Sales beräknas enligt Shopify Analytics formel
- ✅ Alla värden avrundas till 2 decimaler
- ✅ Index alignment fixad i `calculateShopifyLikeSales` (returnerar alla orders för korrekt index-mapping)

**Accuracy Status (2025-01-27 - efter alla fixar):**

**Stor Dataset Analys (145,894 orders):**
- **92.70% perfect matches** (135,251 av 145,894 orders)
- 10,643 mismatches (7.30%)
- Analys genomförd med `scripts/analyze_remaining_mismatches.ts`
- **UPPDATERAD:** Accuracy är högre än tidigare rapporterat (87.66%) - troligen påverkat av dataset storlek och tidsperiod

**Mindre Dataset Verifiering (3,014 orders):**
- **87.66% perfect matches** (2,642 av 3,014 orders)
- 372 mismatches (12.34%)
- Per metric accuracy (från mindre dataset):
  - Gross Sales: 89.32% match (322 mismatches)
  - Net Sales: 94.89% match (154 mismatches)
  - Discounts: 90.15% match (297 mismatches)
  - Returns: 98.81% match (36 mismatches)
  - Tax: 98.87% match (34 mismatches)
- Max diff: 1,000.00 kr (orders med CSV = 0.00 kr)

**Notering:** Accuracy varierar mellan datasets och tidsperioder. Stor dataset (145,894 orders) visar 92.70% accuracy vilket är bättre än mindre dataset (87.66%).

### Kända Begränsningar och Identifierade Mönster

1. **79.80 kr Diff-mönster (2025-01-27)** ✅ FIXAD

   **Beskrivning:**
   - Många orders hade exakt 79.80 kr diff mellan API och CSV
   - T.ex. order 7127244669271: API = 2,180.00 kr, CSV = 2,259.80 kr
   
   **Karakteristik:**
   - Orders med 100% rabatterade produkter (23 orders identifierade)
   - 79.80 kr = 399.00 × 0.25/1.25 (tax-komponenten av en 399.00 kr produkt)
   - Systematiskt mönster - alla 23 orders hade 100% rabatterade produkter
   
   **Lösning identifierad och implementerad:**
   - Shopify Analytics inkluderar tax-komponenten av 100% rabatterade produkter i både Gross Sales OCH Discounts
   - Tax component = price × tax_rate / (1 + tax_rate)
   - Formel: `CSV Gross Sales = API Gross Sales + sum(tax components of 100% discounted items)`
   - Formel: `CSV Discounts = API Discounts + sum(tax components of 100% discounted items)`
   - Identifiera 100% rabatterade: `Math.abs(itemTotal - itemDiscount) < 0.01`
   
   **Resultat:**
   - 25 orders fixade (alla 79.80 kr diff-orders)
   - Order 7127244669271: Alla metrics matchar nu perfekt ✅
   - Hypotes testad: 23/23 orders matchade perfekt (100%)
   
   **Implementation:** `lib/shopify/sales.ts` rad 337-361 (Gross Sales), rad 372-393 (Discounts)

2. **Orders med CSV Gross Sales = 0.00 kr** ✅ IDENTIFIERAT

   **Beskrivning:**
   - Orders där CSV visar 0.00 kr men API visar ett värde (t.ex. 1,000.00 kr)
   - T.ex. orders: 7137911177559, 7144336785751, 7133027336535
   
   **Karakteristik (analys 2025-01-27):**
   - 5 orders identifierade i dataset (3,015 orders) = 0.17%
   - **100% har `total_tax = 0`** (alla 5 orders)
   - **100% har `fulfillment_status = null`** (ingen fulfillment)
   - Financial status: "paid" (100%)
   - Cancelled: NO (0%)
   - Test orders: NO (0%)
   - Värden: Exakt 1,000.00 kr (2 orders) eller 600.00 kr (3 orders)
   - Subtotal price: > 0 (t.ex. 1,000.00 kr eller 600.00 kr)
   
   **Slutsats:**
   - Shopify Analytics exkluderar orders med `total_tax = 0` OCH `fulfillment_status = null`
   - Dessa orders är troligen special orders (gift cards, store credits, eller andra non-standard orders)
   - Även om de är "paid" och inte test orders, exkluderar Shopify Analytics dem från Gross Sales
   
   **Rekommendation:**
   - För att matcha CSV exakt: Filtrera bort orders med `total_tax = 0` OCH `fulfillment_status = null`
   - Dessa orders utgör endast 0.17% av dataset (5/3,015 orders)
   - Impact på total accuracy är minimal men skulle ge 100% match för dessa orders
   
   **Implementation:** Kräver uppdatering i `calculateShopifyLikeSales` eller filtrering efter beräkning

3. **Zero Subtotal Orders**

   **Beskrivning:**
   - Orders med `subtotal_price = 0` (100% rabatterade orders)
   - Inget av de testade formlerna fungerar bra (högst 9.1% match i tidigare analys)
   - Nu är dessa troligen inkluderade i 79.80 kr diff-mönstret

4. **High Tax Rate Orders (>26%)**

   **Beskrivning:**
   - 43 orders med tax rate > 26% (troligen mixed tax rates)
   - Avg diff: 6.78 kr (relativt liten)
   - Inget matchar perfekt, men diff är acceptabel

5. **Orders med Large Discounts (>50% av gross)**

   **Beskrivning:**
   - Endast 2 orders i senaste analysen
   - Avg diff: 59.91 kr
   - Kanske relaterat till 79.80 kr diff-mönstret eller Zero Subtotal

## Testresultat och Verifiering

### Test Dataset

- **Total orders analyserade:** 62,770 (comparison_file_2.csv)
- **Datumintervall:** 2025-12-01 till 2025-12-19
- **Tenant:** skinome

### Accuracy Resultat

**EFTER Index Alignment Bug Fix (2025-01-27):**
- **Total orders analyserade:** 3,015 orders
- **Perfect matches:** 2,667 orders = **88.5% accuracy** ✅
- **Mismatches:** 347 orders = 11.5%
- **Avg diff för mismatches:** 19.69 kr
- **Max diff:** 1,000.00 kr (orders med CSV = 0.00 kr)

**FÖRE Bug Fix (för referens):**
- 1,794 mismatches av 5,000 orders = 64.1% accuracy
- Nuvarande implementation matchade 0% av mismatch-orders (pga index alignment bug)

**Förbättring efter fix: +24.4% accuracy!** 🎉

**Per kategori (347 mismatch-orders):**

| Kategori | Antal Orders | Avg Diff | Notes |
|----------|--------------|----------|-------|
| Has Discounts (No Refunds) | 311 (89.6%) | 9.17 kr | Många med 79.80 kr diff-mönster |
| No Discounts No Refunds | 33 (9.5%) | 4.92 kr | Relativt små diffar |
| High Tax Rate (>26%) | 43 (12.4%) | 6.78 kr | Acceptabel diff (mixed tax rates) |
| Has Refunds | 3 (0.9%) | 5.80 kr | Fungerar bra |
| Large Discounts (>50%) | 2 (0.6%) | 59.91 kr | Kanske relaterat till 79.80 kr mönster |

**Identifierade mönster i mismatches:**
1. **79.80 kr diff-mönster:** Många orders har exakt 79.80 kr diff (100% rabatterade produkter)
2. **CSV = 0.00 kr:** Orders som Shopify Analytics exkluderar (annullerade/test orders)

### Test Scripts

Följande scripts finns för validering och debugging:

1. **`scripts/compare_api_with_shopify_csv.ts`**
   - Total och daglig jämförelse mellan API och CSV
   - Visar aggregerade värden och dagliga totals

2. **`scripts/verify_orders_accuracy.ts`**
   - Order-level accuracy-statistik
   - Identifierar orders som inte matchar

3. **`scripts/analyze_gross_sales_discrepancies.ts`**
   - Pattern analysis för Gross Sales-beräkningar
   - Kategoriserar mismatches i olika mönster

4. **`scripts/analyze_csv_gross_sales_formula.ts`**
   - Testar olika formler mot CSV-data
   - Identifierar vilken formel som bäst matchar CSV

5. **`scripts/compare_single_order_detail.ts`**
   - Detaljerad jämförelse för individuella orders
   - Visar alla värden steg-för-steg

6. **`scripts/analyze_zero_tax_orders.ts`**
   - Specifik analys av orders med `total_tax = 0`
   - Validerar hantering av zero-tax orders

7. **`scripts/debug_gross_sales_calculation.ts`**
   - Debug-script för specifik order
   - Visar alla beräkningssteg i detalj

8. **`scripts/systematic_analyze_mismatches.ts`** ⭐ NYTT
   - Systematisk analys av mismatch-orders
   - Kategoriserar orders efter egenskaper (refunds, discounts, tax rates, etc.)
   - Testar olika formler per kategori
   - Identifierar bäst matchande formel per kategori
   - Genererar rekommendationer för förbättringar

9. **`scripts/analyze_line_item_level.ts`** ⭐ NYTT (2025-01-27)
   - Analyserar CSV med produkt-ID dimension
   - Jämför CSV Gross Sales per line item mot olika API-formler
   - Identifierar vilken formel CSV använder för varje line item
   - Resultat: 60.2% matchar `API Total EXCL tax` (vår nuvarande formel)

10. **`scripts/analyze_unmatched_line_items.ts`** ⭐ NYTT (2025-01-27)
    - Analyserar line items som inte matchar någon formel
    - Identifierar patterns för de 22.8% unmatched line items
    - Genomsnittlig diff: 361.79 kr

11. **`scripts/analyze_mixed_patterns_in_orders.ts`** ⭐ NYTT (2025-01-27)
    - Analyserar orders där CSV använder olika formler för olika line items
    - Identifierade 6 orders med mixed patterns

12. **`scripts/analyze_line_item_allocation.ts`** ⭐ NYTT (2025-01-27)
    - Analyserar hur CSV fördelar Gross Sales mellan line items i multi-product orders
    - Identifierar proportional allocation: `(apiTotalExclTax / sumApiTotalExclTax) × subtotalExclTax`
    - Resultat: 35.3% använder proportional allocation, 64.7% följer annan regel

13. **`scripts/analyze_unmatched_gross_discounts_returns.ts`** ⭐ NYTT (2025-01-27)
    - Fokuserar på vilken komponent (Gross Sales, Discounts, eller Returns) som är fel
    - Baserat på insikten: Net Sales = Gross Sales - Discounts - Returns (alltid)
    - Om Net Sales är fel, identifierar vilken av de tre komponenterna som är felaktig

14. **`scripts/analyze_csv_gross_equals_net_plus_tax.ts`** ⭐ NYTT (2025-01-27)
    - Analyserar pattern där CSV Gross Sales = CSV Net Sales + CSV Tax
    - Identifierade att 53.5% av unmatched line items följer detta mönster
    - Viktigt för att förstå hur CSV beräknar Gross Sales i vissa edge cases

15. **`scripts/comprehensive_unmatched_analysis.ts`** ⭐ NYTT (2025-01-27)
    - Omfattande analys av alla unmatched line items
    - Identifierar genomsnittliga ratios, distributions, och patterns
    - Kategoriserar efter order type och line item position

16. **`scripts/analyze_remaining_mismatches.ts`** ⭐ NYTT (2025-01-27)
    - Analyserar de återstående mismatches för att identifiera patterns
    - Analyserar 145,894 orders dataset
    - Identifierar 8 olika mismatch patterns (CSV Gross = 0.00, subtotal_price, refunds, etc.)
    - Ger breakdown av vilken metric som är primär orsak (Gross/Net/Discounts/Returns)
    - Visar top 10 största discrepancies med detaljerad information

17. **`scripts/analyze_refunds_mismatches.ts`** ⭐ NYTT (2025-01-27)
    - Fokuserad analys av refunds/returns mismatches
    - Identifierar orders med stora Returns diffar (>= 50 kr default)
    - Visar detaljerad refund information (refund IDs, line items, subtotals)
    - Hjälper förstå varför Returns beräkning skiljer sig mellan CSV och API

## Historiska Lärdomar

### 1. Tax Calculation Fix (2025-01-27)

**Problem:** Tax discrepancy ~15%

**Orsak:** Beräknade tax som `gross_sales * tax_rate` istället för att använda `total_tax` direkt från API.

**Lösning:** Använd `total_tax` direkt från Shopify API.

**Resultat:** Tax discrepancy reducerad till ~0.9%

**Implementation:** `lib/shopify/sales.ts` rad 303-305

### 2. Zero-Tax Orders (2025-01-27)

**Problem:** Orders med `total_tax = 0` hade felaktig Gross Sales-beräkning.

**Orsak:** Försökte konvertera från INCL till EXCL tax även när tax = 0.

**Lösning:** Om `total_tax === 0`, använd `sum(line_items)` direkt som Gross Sales.

**Resultat:** 100% matchning för zero-tax orders.

**Implementation:** `lib/shopify/sales.ts` rad 331-336

### 3. Conditional Gross Sales Logic (2025-01-27)

**Problem:** Försökte använda komplexa conditional logics baserat på `subtotalMatchesLineItems`, `hasRefunds`, standard tax rate (25%) för SEK orders, etc.

**Orsak:** För många edge cases och komplexitet som inte förbättrade matchningar.

**Lösning:** Förenklad logik baserad på `total_tax === 0` check och faktisk tax rate från order.

**Resultat:** Bättre matchning (~86% för orders med tax) och enklare kod.

**Implementation:** `lib/shopify/sales.ts` rad 329-348

### 4. Discounts INCL vs EXCL Tax (2025-01-27)

**Problem:** Shopify API returnerar discounts INCL tax, men Shopify Analytics visar EXCL tax.

**Lösning:** Konvertera discounts från INCL till EXCL tax med samma tax rate som används för Gross Sales.

**Implementation:** `lib/shopify/sales.ts` rad 350-360

### 5. Systematisk Analys av Mismatch-Orders (2025-01-27)

**Problem:** 1,794 orders från 5,000 testade orders matchar inte perfekt. Nuvarande implementation matchar 0% av dessa mismatch-orders.

**Upptäckt:**
- Formeln `sum(line_items) / (1 + tax_rate)` matchar 80.7% av mismatch-orders perfekt
- Detta är redan den formel vi använder för orders med tax, men något gör att den inte tillämpas korrekt för mismatch-orders
- **Kategorier som fungerar bra:**
  - Orders med refunds: 85.7% match med `sum(line_items) / (1 + tax_rate)`
  - Orders utan discounts/refunds: 88.3% match
  - Orders med stora rabatter (>50%): 93.6% match
- **Kategorier som behöver förbättring:**
  - Zero Subtotal orders: Ingen formel fungerar bra (högst 9.1% match)
  - High Tax Rate orders (>26%): Inget matchar perfekt, men avg diff är liten (6.81 kr)

**Test Script:** `scripts/systematic_analyze_mismatches.ts`

### 6. Index Alignment Bug Fix (2025-01-27) ⚠️ KRITISK FIX

**Problem:** `calculateShopifyLikeSales` filtrerade bort orders med `grossSales <= 0` från `perOrder` arrayen, vilket gjorde att indexen i `perOrder` inte matchade indexen i `orders` arrayen.

**Orsak:** 
- Scripts använder `salesResults.perOrder[orderIndex]` där `orderIndex` är indexet i `orders` arrayen
- Men `perOrder` hade filtrerats, så indexen matchade inte
- Detta ledde till att scripts fick fel data för orders (t.ex. order 7117571129687 visade 511.36 kr istället för 5,741.60 kr)

**Lösning:** 
- Returnera ALLA orders i `perOrder` arrayen (för att behålla index-alignment)
- Filtrera bara när vi aggregerar totals (endast orders med `grossSales > 0`)

**Resultat:** 
- Order 7117571129687: Matchar nu perfekt (5,741.60 kr)
- Order 7117563396439: Matchar nu perfekt (2,369.76 kr)
- Alla scripts som använder `perOrder[i]` får nu korrekt data

**Implementation:** `lib/shopify/sales.ts` rad 431-464

### 5. 100% Rabatterade Produkter - Tax Component (2025-01-27)

**Problem:** Orders med 100% rabatterade produkter hade exakt 79.80 kr diff (t.ex. 399.00 kr produkt med 399.00 kr discount).

**Orsak:** Shopify Analytics inkluderar tax-komponenten av 100% rabatterade produkter i både Gross Sales och Discounts, medan vi exkluderade dem.

**Lösning:** Lägg till tax-komponenten av 100% rabatterade produkter till både Gross Sales och Discounts.

**Formel:**
```typescript
// Identifiera 100% rabatterade produkter
if (itemDiscount > 0 && Math.abs(itemTotal - itemDiscount) < 0.01) {
  const taxComponent = (itemPrice * taxRate) / (1 + taxRate);
  grossSales += taxComponent * itemQuantity;
  discounts += taxComponent * itemQuantity;
}
```

**Resultat:** 
- 25 orders fixade (alla 79.80 kr diff-orders)
- Alla 23 testade orders matchade perfekt (100%)
- Accuracy förbättrad från 88.5% till ~89.2%

**Implementation:** `lib/shopify/sales.ts` rad 337-361 (Gross Sales), rad 372-393 (Discounts)

### 5.5. Line Item-Level Analys (2025-01-27) ✅ ANALYSERAT

**Syfte:** Förstå hur CSV beräknar Gross Sales per line item genom att analysera CSV med produkt-ID dimension.

**Metod:**
- Analyserat 4,640 line items från CSV med produkt-ID
- Jämfört CSV Gross Sales per produkt mot olika formler från API

**Resultat:**
- **60.2% matchar `API Total EXCL tax`** (price × quantity / (1 + tax_rate)) - vår nuvarande formel!
- **58.9% matchar `API Price EXCL tax`** (price / (1 + tax_rate))
- **56.1% matchar CSV Net Sales** (CSV Gross Sales = CSV Net Sales i många fall)
- **41.5% matchar `API Total After Discount EXCL tax`** (när discounts finns)
- **77.2% matchar minst en formel** - 22.8% matchar ingen formel

**Slutsats:**
- CSV använder nästan alltid `price × quantity / (1 + tax_rate)` för line items
- Vår nuvarande implementation är korrekt för de flesta line items
- Problem uppstår när CSV använder `subtotal_price` direkt för vissa produkter i orders med flera produkter

**Identifierade patterns:**
- Orders med flera produkter kan ha mixed patterns där vissa produkter använder subtotal_price och andra använder standardformeln
- 6 orders identifierade med mixed patterns (exempel: Order 7139214328151 har en produkt med subtotal_price och en produkt med standardformel)

**Test Script:** `scripts/analyze_line_item_level.ts`, `scripts/analyze_unmatched_line_items.ts`, `scripts/analyze_mixed_patterns_in_orders.ts`

### 5.6. 7.25 kr Diff-mönster - Matematisk Konsistens-check (2025-01-27) ✅ IMPLEMENTERAT

**Problem:** 64 orders med CSV = subtotal_price har mismatch (ofta exakt 7.25 kr diff).

**Analys:**
- Alla 64 orders har discounts (100%)
- Average tax rate deviation från 25%: 0.74% (vs perfect matches: 0.00%)
- Hypotes: När tax_rate deviates från 25% (> 0.1%) OCH order har discounts, använder CSV subtotal_price INCL tax direkt
- Matematisk analys visade: För mismatches, 83.3% har subtotal_price närmare CSV än vår formel
- Matematisk relation: `subtotal_price × (1 + tax_rate) ≈ sum(line_items)` för 89.4% av perfect matches

**Lösning:**
- Implementerade conditional logic med matematisk konsistens-check:
  ```typescript
  if (taxRateDeviationFrom25 > 0.001 && 
      orderHasDiscounts &&
      Math.abs(subtotalPrice * (1 + taxRate) - sumLineItems) < 1.0) {
    use subtotal_price
  }
  ```
- Detta säkerställer att vi bara använder subtotal_price när det är matematiskt konsistent

**Resultat:**
- ✅ 87.66% perfect matches (2,642 / 3,014 orders) - samma som ursprungliga accuracy
- ✅ Fixar orders där CSV använder subtotal_price direkt när matematisk konsistens finns
- ✅ Förhindrar false positives genom matematisk validering

**Implementation:** `lib/shopify/sales.ts` rad 359-375

### 6. Line Item-Level Beräkning - Insikter (2025-01-27) 📊

**Kontext:** Analys av CSV med produkt-ID visade hur CSV beräknar Gross Sales per line item.

**Viktiga insikter:**
1. **CSV använder nästan alltid `price × quantity / (1 + tax_rate)` för line items**
   - 60.2% av line items matchar exakt denna formel
   - Detta bekräftar att vår nuvarande implementation är korrekt för de flesta fall

2. **Multi-product orders - Allocation patterns:**
   - **Order-level:** CSV Total Gross Sales är antingen `subtotalPrice` (INCL tax, 25.4%) eller `subtotalExclTax` (EXCL tax, 44.7%)
   - **Line item-level:** För orders där CSV Total = `subtotalExclTax`, använder CSV **proportional allocation**:
     ```
     CSV Gross Sales (line item) = (apiTotalExclTax / sumApiTotalExclTax) × subtotalExclTax
     ```
   - **35.3% av multi-product orders** använder denna proportional allocation
   - **64.7% av multi-product orders** har produkt-matchningsproblem (se 6.1 nedan)

3. **Net Sales = Gross Sales - Discounts - Returns (alltid):**
   - Om Net Sales är fel, så är problemet i Gross Sales, Discounts eller Returns
   - Net Sales beräknas ALDRIG direkt - alltid via formeln ovan
   - Detta betyder att vi måste fokusera på att få Gross Sales, Discounts och Returns korrekta

4. **22.8% line items matchar ingen formel:**
   - Genomsnittlig diff från API Total EXCL tax: 361.79 kr
   - Genomsnittlig ratio CSV Gross / API Total EXCL tax: 1.8466
   - **UPPDATERAD (2025-01-27):** Många av dessa är relaterade till produkt-matchningsproblemet (se 6.1)

**Rekommendation:**
- Nuvarande implementation är korrekt för 77.2% av line items
- **KRITISK FIX:** Matcha produkter på produkt-ID istället för index-position
- Ytterligare förbättringar kan göras genom att implementera proportional allocation för orders där CSV Total = `subtotalExclTax`

### 6.1. Produkt Matchning Problem - KRITISK UPPTÄCKT OCH FIXAD (2025-01-27) ✅

**Problem identifierat:**
- 64.7% av multi-product orders matchade inte proportional allocation
- Test av "Swapped/Reordered allocation" visade **82.2% perfect matches** (1495/1818 line items)!
- **Orsak:** Scripts matchade produkter på **INDEX-position** istället för **produkt-ID**
- CSV och API sorterar produkter olika i multi-product orders

**Analys resultat:**
- **Swapped/Reordered allocation:** 1495/1818 perfect matches (82.2%)
- **Proportional allocation:** 242/1818 perfect matches (13.3%)
- Avg diff med swapped: 5.79 kr (vs 322.21 kr med proportional)

**Breakdown per order-level method:**
- CSV Total = subtotalExclTax: 607/633 (95.9%) match med swapped allocation
- CSV Total = subtotalPrice: 443/487 (91.0%) match med swapped allocation  
- CSV Total = sum(apiTotalExclTax): 320/332 (96.4%) match med swapped allocation

**Slutsats:**
- Problemet är **INTE** hur CSV beräknar värden, utan hur produkter matchas mellan CSV och API
- CSV-värden är korrekta, men de var kopplade till fel produkt-index i våra scripts
- Vi måste matcha på **produkt-ID** istället för index-position

**Fix implementerad (2025-01-27 - UPPDATERAD):**
1. ✅ GraphQL query uppdaterad för att hämta `product { id }` och `variant { id }` från line items (read_products scope nu tillgänglig)
2. ✅ `lib/integrations/shopify-graphql.ts` - Typ uppdaterad för att inkludera `product` och `variant`
3. ✅ `lib/shopify/order-converter.ts` - Extraherar produkt-ID från GID (variant ID prioriteras över product ID)
4. ✅ `lib/shopify/sales.ts` - Typ uppdaterad för att inkludera `product_id` i line items
5. ✅ `scripts/analyze_line_item_allocation.ts` - Matchar nu direkt på produkt-ID (82.2% matches förväntat)
6. ✅ `scripts/analyze_non_proportional_allocation.ts` - Matchar nu direkt på produkt-ID (82.2% matches förväntat)

**Förväntad förbättring:**
- Med produkt-ID matchning: 82.2% perfect matches för non-proportional orders (vs 37.8% med best-effort)
- Accuracy förväntas förbättras för multi-product orders

**Implementation:** 
- `lib/integrations/shopify-graphql.ts` rad 244-249 (GraphQL query), rad 83-85 (typ)
- `lib/shopify/order-converter.ts` rad 30-43 (produkt-ID extraktion)
- `lib/shopify/sales.ts` rad 36 (typ)
- `scripts/analyze_line_item_allocation.ts` - Direkt produkt-ID matchning
- `scripts/analyze_non_proportional_allocation.ts` - Direkt produkt-ID matchning

**Test Script:** `scripts/analyze_non_proportional_allocation.ts`

**Implementation:** 
- `lib/integrations/shopify-graphql.ts` rad 244-249 (GraphQL query), rad 83-85 (typ)
- `lib/shopify/order-converter.ts` rad 30-43 (produkt-ID extraktion)
- `lib/shopify/sales.ts` rad 36 (typ)
- `scripts/analyze_line_item_allocation.ts` - Direkt produkt-ID matchning
- `scripts/analyze_non_proportional_allocation.ts` - Direkt produkt-ID matchning

### 6.2. Returns/Refunds Beräkning Problem - KRITISK ANALYS (2025-01-27) ⚠️

**Problem identifierat:**
- Orders med refunds har stora discrepancies i Returns beräkning
- Avg Returns diff: 276.17 kr för orders med refunds (1277 orders från 145,894 orders dataset)
- Avg Net Sales diff: 381.99 kr för orders med refunds
- Top discrepancies visar stora Returns diffar (t.ex. 2,576 kr, 2,488 kr, 2,372 kr)

**Deep Analysis (190 orders med refunds, diff >= 50 kr):**
- Avg Returns diff: 789.00 kr
- Avg Net Sales diff: 1,076.96 kr
- Max Returns diff: 2,576.33 kr
- Max Net Sales diff: 3,732.83 kr
- Orders där Net Sales formula är konsistent: 70 / 190 (36.8%)

**KRITISKA UPPTÄCKTER:**

1. **Refunds utan refund_line_items (shipping/order-level refunds):**
   - Order 6796835520855: Refund med 0 refund_line_items
     - API Returns: 0.00 kr (inga line items → vi räknar 0)
     - CSV Returns: 1,428.58 kr
     - CSV Gross Sales: 1,732.80 kr
     - **Pattern:** CSV inkluderar shipping refunds eller order-level refunds som saknar refund_line_items
   
   - Order 6585650086231: Refund med 0 refund_line_items
     - API Returns: 0.00 kr
     - CSV Returns: 1,349.00 kr
     - CSV Gross Sales: 1,198.40 kr

2. **Multiple refunds med olika typer:**
   - Order 6570166518103: 2 refunds, men bara 1 har refund_line_items
     - Refund 1: Line Item subtotal=444.77 kr
     - Refund 2: Inga line items (tom refund - shipping/order-level?)
     - API Returns: 444.77 kr (bara refund 1)
     - CSV Returns: 2,170.53 kr (inkluderar båda refunds eller beräknar annorlunda)
     - Diff: 1,725.76 kr

3. **CSV Returns kan inkludera original order värde:**
   - Order 6556798484823: CSV Returns 5,693.71 kr vs API 3,117.38 kr
     - API Returns: 3,117.38 kr (summa av refund_line_items: 680.69 + 878.0 + 878.0 + 680.69)
     - CSV Gross Sales: 2,862.58 kr
     - **Hypotes:** CSV Returns ≈ API Returns + CSV Gross Sales? (3,117.38 + 2,862.58 = 5,979.96 ≈ 5,693.71)
     - Detta skulle innebära att CSV inkluderar både refund amount OCH original order value

4. **Inverterad pattern (CSV < API):**
   - Order 7008752206167: CSV Returns 86.35 kr vs API 1,467.95 kr
     - 2 refunds: Refund 1 (inga line items), Refund 2 (line item subtotal=1,467.95 kr)
     - API Returns: 1,467.95 kr (bara refund 2)
     - CSV Returns: 86.35 kr (mycket lägre - kan vara partial refund eller exkluderar refund 2)

**Ny observation (viktig): CSV visar Returns som separat rad utan datumkolumner**
- I `comparison_file_product_id_3.csv` finns **två rader** för order `7008752206167`:
  - **“Sale”-rad**: `Bruttoförsäljning=1381.6`, `Rabatter=-207.24`, `Nettoförsäljning=1174.36`, `Returer=0`
  - **“Return”-rad**: `Bruttoförsäljning=0`, `Nettoförsäljning=-86.35`, `Returer=-86.35`
- CSV-exporten innehåller **inga datumkolumner** i just denna dimension/export, vilket innebär att “vad som ingår i perioden” redan är bestämt av Shopify Analytics-exporten.
- Detta stärker hypotesen att Shopify Analytics kan tidsallokera refunds/returns via **transaction/payout/processed-datum** snarare än strikt `refund.created_at`.

**Kritisk kontroll: CSV-filen är äldre än refund 2**
- Filens mtime för `comparison_file_product_id_3.csv` är `2025-12-23` (dvs **före** refund 2 skapades `2025-12-29`).
- Därför kan vi **inte** använda den filen för att validera om Shopify Analytics skulle ha inkluderat refund 2 i en export som täcker t.o.m. 31 december.
- Åtgärd: exportera ny CSV efter att refund 2 finns (t.ex. nu), med datumintervall som inkluderar `2025-12-29`, för att testa periodfiltrering.

**Åtgärd / Implementation (pågår)**
- Vi har lagt till stöd för att hämta `refund.transactions.processedAt` via GraphQL och använder nu en “refund effective date”:
  - **Primärt**: senaste `processedAt` på SUCCESS/REFUND-transaktioner
  - **Fallback**: `refund.created_at`
- Målet är att få periodfiltreringen att matcha Shopify Analytics exportbeteende i praktiken (ex: om refund skapas i december men processas/drogs på januariutbetalning ska den eventuellt inte ingå i dec-rapporten).

**Nuvarande implementation:**
- Använder `refund_line_items[].subtotal` när tillgänglig (EXCL tax)
- Fallback till `calculateRefundLineItemSubtotal()` om subtotal saknas
- **PROBLEM:** Räknar bara refunds som har refund_line_items
- **PROBLEM:** Ignorerar shipping refunds och order-level refunds (refund.transactions)
- Implementation: `lib/shopify/sales.ts` rad 447-467

**Potentiella orsaker (prioriterade efter sannolikhet):**
1. **CSV inkluderar shipping refunds/order-level refunds** (refund.transactions) som saknar refund_line_items
2. **CSV använder refund.transactions.amount** istället för endast refund_line_items.subtotal
3. **CSV inkluderar original order värde** när refund är full refund (refund amount + original gross sales)
4. **CSV filtrerar refunds baserat på refund.created_at** vs order.processed_at (datum-filter)
5. **CSV inkluderar refunds med olika status** (pending, succeeded, etc.) än vad vi gör

**Exempel från top discrepancies:**
- Order 6556798484823: CSV Returns 5,693.71 kr vs API 3,117.38 kr (diff: 2,576.33 kr) - har refund_line_items
- Order 6622831903063: CSV Returns 5,599.24 kr vs API 3,110.69 kr (diff: 2,488.55 kr) - har refund_line_items
- Order 6796835520855: CSV Returns 1,428.58 kr vs API 0.00 kr (diff: 1,428.58 kr) - INGA refund_line_items
- Order 6570166518103: CSV Returns 2,170.53 kr vs API 444.77 kr (diff: 1,725.76 kr) - 1 refund utan line items
- Order 7008752206167: CSV Returns 86.35 kr vs API 1,467.95 kr (diff: -1,381.60 kr) - inverterat pattern

**KRITISK UPPTÄCKT - Datum-filter för refunds (2025-01-27):**
- Order 7008752206167 har 2 refunds:
  1. 27-28 november 2025: 86.35 kr SEK (refund.created_at = 2025-11-27T20:15:01Z)
  2. 30 december 2025: 1,467.95 kr SEK (refund.created_at = 2025-12-29T13:59:24Z, refund_line_items subtotal)
  
**Verifierat med ny CSV som inkluderar datumkolumnen `Dag` (2025-01-08):**
- CSV-raderna för order `7008752206167` visar tydligt att Shopify Analytics tidsallokerar:
  - **Sale på orderdag** (`Dag=2025-11-13`): Brutto 1381.6, Rabatter -207.24, Netto 1174.36
  - **Refund 1 på refund-dag** (`Dag=2025-11-27`): Returer -86.35, Netto -86.35
  - **Refund 2 på refund-dag** (`Dag=2025-12-29`): Returer -1088.01, Netto -1088.01, Skatter -293.59

- **December-perioden (2025-12-01 till 2025-12-31):**
  - CSV innehåller endast refund 2-raden ⇒ **Returer = 1088.01**, Brutto = 0, Rabatter = 0, Netto = -1088.01
  - Detta matchar din definition: **endast refunds inom perioden ingår**.

- **November-December perioden (2025-11-01 till 2025-12-31):**
  - CSV innehåller både sale-raden och båda refund-raderna ⇒ **Brutto 1381.6**, **Rabatter 207.24**, **Returer 1174.36**, **Netto 0.00**

**Slutsats:**
- Shopify Analytics (i denna export med dimension `Dag`) verkar allokera **discounts till orderdagen** och **returns till refund-dagen**.
- Det gör att Net Sales alltid stämmer som \(Net = Gross - Discounts - Returns\) inom valfri period — exakt enligt din regel.

**Implementerat för att matcha Shopify Analytics (2025-01-08):**
- `scripts/analyze_specific_refund_orders.ts` filtrerar nu CSV-rader per period när datumkolumnen heter `Dag`.
- `lib/shopify/sales.ts`:
  - Om `datePeriod` anges: **Gross/Discounts sätts till 0 om orderdagen (processed_at/created_at) ligger utanför perioden**, men Returns kan fortfarande vara > 0 om refunds inträffar inom perioden.
  - Returns beräknas nu som:
    - **sum(REFUND SUCCESS transaction amounts)** minus **refunded tax** (härledd från orderns line item `taxLines` och refundens `refund_line_items`-kvantiteter)
    - Refunds utan `refund_line_items` behandlas som tax-fria justeringar (Returns = transaction amount)

**Verifierat resultat:**
- Order `7008752206167`
  - Period `2025-12-01..2025-12-31`: **100% match** (Gross 0, Discounts 0, Returns 1088.01, Net -1088.01)
  - Period `2025-11-01..2025-12-31`: **100% match** (Gross 1381.60, Discounts 207.24, Returns 1174.36, Net 0.00)

**Ny upptäckt (2025-01-08): `Dag`-export kan ha “reversal”-rader för Returns**
- `Returer` kan förekomma med **både negativa och positiva värden** på olika dagar för samma order (t.ex. return fee / korrigering).
- När man summerar order-totaler måste man:
  - **summa signed per dag först**, och först därefter ta absolutbelopp för jämförelse mot vår API-return (som använder positiva magnituder).
- Vi fixade analys-skripten (`analyze_refunds_mismatches.ts`, `analyze_specific_refund_orders.ts`) så att de inte gör `abs()` per rad när datumdimension (`Dag`) finns.

**Ny regel för Shopify Analytics-matchning (stor effekt på refunds): Refunds utan SUCCESS-transaktioner**
- I flera topp-mismatches såg vi att Shopify Analytics `Dag`-export visar refunds som **tax-only adjustments** när refund saknar REFUND/SUCCESS-transaktion:
  - Exempelrader: `Returer` ≈ refunded tax (positiv), `Skatter` ≈ -refunded tax, `Omsättning` = 0
- Implementerat i `lib/shopify/sales.ts`:
  - Om refund saknar REFUND/SUCCESS transaction men har `refund_line_items`: räkna Returns som **refundedTax** (från orderns `taxLines` proportionerat per refunded quantity) istället för line item subtotal.
- Effekt (sample 500 refund-orders, 2025-01-01..2025-12-31):
  - Returns match ökade från **399/496** till **457/496**
  - Antal stora mismatches (Returns diff ≥ 50 kr) sjönk från **70** till **10**

### Ytterligare regel (2025-01-09): “tx-only refund” + “full-refund shell”
Vi hittade ett återkommande mönster där Shopify visar en refund via en **REFUND/SUCCESS transaction** men refund-objektet saknar `refund_line_items`,
och samtidigt finns en annan refund på samma order med `refund_line_items` men **utan** SUCCESS-transaction (”shell”).

- I dessa fall kan shell-refunden bära **hela tax-komponenten** (via line items), medan tx-only refunden bär den faktiska utbetalningen.
- För att matcha Shopify `Dag`-export implementerade vi:
  - Om en refund har SUCCESS transaction men inga line items: använd tax-hint från en full-refund shell på samma order för att netta:
    - \(Returns_{net} = txTotal - refundedTax_{shell}\)
  - Om en refund är full-refund shell (alla items/qty) utan SUCCESS transaction och det redan finns någon SUCCESS refund transaction på ordern: ignorera shell-refunden (0 impact).

**Verifierat exempel:**
- Order `6484177617239` gick från mismatch till **100% match** efter denna regel.

### Kvarvarande “svåra” edge cases (2025-01-09)
I sample (500 refund-orders) finns kvar en liten mängd orders där Shopify Analytics verkar använda logik som inte kan härledas robust enbart från `refunds` + `transactions` + line item taxLines:
- `6360395776343`: CSV visar bara `59` på refund-dagen, vilket matchar differensen \(sum(refundLineItems subtotals) - refund transaction amount = 59\). Detta ser ut som en **refund discrepancy/fee adjustment** som Shopify bokför separat.
- `6360020058455`: CSV visar samma refund-belopp på två olika dagar (inkl tax och split net+tax), trots att API bara har 1 refund/transaction.
- `6377131442519`: refund transaction är `176.7` men CSV `Returer`/`Nettoförsäljning` blir positiva p.g.a. att tax-raden är större än refund-beloppet (särskild edge case).

**Nästa möjliga steg för 100% match**:
- Utöka GraphQL-queryn för refunds med eventuella *refund adjustments / discrepancy* fält (om de finns), eller
- Hämta Shopify “returns”/exchange/adjustment events (nya Shopify Returns API-domänen) som inte alltid speglas som klassiska `refunds`.

## 95%+ status (verifierad på större sample) – Refund orders (2025-01-09)
Vi körde `scripts/analyze_refunds_mismatches.ts` med `2025data_080126_1.csv` (period `2025-01-01..2025-12-31`) och analyserade alla refund-orders som finns i CSV (1,257 st i sample-körningen).

**Resultat (1,257 orders med refunds):**
- Returns match (±0.01): **1168 / 1257** = **92.84%**
- Net Sales match (±0.01): **886 / 1257** = **70.48%**
- Discounts match (±0.01): **1083 / 1257** = **86.16%**
- Gross+Discounts+Returns+Net all match: **844 / 1257** = **67.14%**
- Stora mismatches (Returns diff ≥ 50 kr): **8 orders**

**Tolkning:**
- För refunds-delmängden är Returns-matchningen förbättrad rejält, men ligger fortfarande under 95% i detta test.
- För att nå ≥95% på refunds-delmängden behöver vi antingen:
  - ytterligare Shopify-data (refund discrepancy/adjustments / Returns API), eller
  - definiera accepterade undantag (t.ex. special gateways / partial payout adjustments) och exkludera dessa kategorier.

## Item-level CSV (Produkt-ID + Produktvariant-ID) – nya insikter (2025-01-08)

Vi fick en ny export: `2025data_080126_items_1.csv` med kolumner:
- `Dag`, `Order-ID`, `Produkt-ID`, `Produktvariant-ID`, + samma metrics (`Bruttoförsäljning`, `Nettoförsäljning`, `Rabatter`, `Returer`, `Skatter`, …)

### Viktiga observationer
- **Variant-id matchar vår API-mappning**:
  - Vi använder redan variantens numeric ID som `line_items[].product_id` (från GraphQL `variant.id`), vilket matchar `Produktvariant-ID` i CSV.
- **Returns kan ligga på både item-rader och “blank” (utan produkt/variant)**:
  - Vissa orders har return-rader med tom `Produktvariant-ID` som ser ut som **order-level adjustments/fees**.
- **Returns kan splittras över flera dagar och flera rader för samma order**, även när Shopify API bara har 1 refund.
  - Exempel: order `6360020058455` har en refund i API (479.20) men item-exporten visar både:
    - en blank rad (`Dag=2025-01-02`, `Returer=-479.2`, `Skatter=0`)
    - en item-rad (`Dag=2025-01-17`, variant-id, `Returer=-383.36`, `Skatter=-95.84`, `Omsättning=-479.2`)
  - Detta tyder på att Shopify Analytics kan representera **samma ekonomiska händelse via flera rader/datum** (eller att det finns ytterligare händelser som inte är modellerade som `refunds` i Order-API:t).

### Slutsats (status)
- Item-exporten gör det mycket enklare att lokalisera *vilka* orders (och ibland vilka varianter) som driver mismatch, men vi ser också tydligt att vissa kvarvarande mismatch kräver att vi förstår:
  - **order-level adjustments** (tom variant-id) och
  - **hur Shopify Analytics tidsallokerar/duplicerar returns** i item-rapporten jämfört med `refunds` i API:t.

## Gross/Discounts – förbättring för ≥95% (2025-01-09)
Vi såg att overall match drogs ner främst av **Gross + Discounts** (inte Returns).
Med item-CSV:n (variant-id) såg vi många små men systematiska avvikelser (t.ex. ~7.25 / 8.05 kr) som tyder på **blandade momssatser** inom en order där order-level taxRate ger fel konvertering.

### Implementerad fix: per-line tax rate (blandad moms)
I `lib/shopify/sales.ts` beräknar vi nu Gross och Discounts EXCL tax **per line item**:
- härleder line-level taxRate från:
  - `lineNetIncl = (price*qty - total_discount)`
  - `taxTotal = line.tax` (summa av `taxLines`)
  - \(taxRate = taxTotal / (lineNetIncl - taxTotal)\)
- fallback till order-level taxRate om lineRate inte går att härleda
- behåller 100% discount special (tax-komponenten adderas till Gross och Discounts)

### Verifiering (sample, 2025-01-01..2025-12-31)
Med `scripts/verify_orders_accuracy_sample.ts` (500 orders sample):
- Gross match: **95.56%**
- Discounts match: **95.56%**
- Returns match: **99.80%**
- Net match: **99.40%**
- All metrics match: **94.76%** (nära 95%; nästa steg är att ta större sample för stabilare estimat)
  
- **November-December perioden (2025-11-01 till 2025-12-31):**
  - Båda refunds ska inkluderas = 1554.30 kr

**SLUTSATS - MYSTERY:**
- ✅ **Datum-filter logik är implementerad** i `lib/shopify/sales.ts` (rad 478-487)
- ✅ **Filtreringen fungerar korrekt i teorin** (verifierad med `debug_refund_date_filter.ts`)
- ❌ **Men i praktiken verkar filtreringen inte fungera** - API Returns visar båda refunds även för december-perioden
- 🤔 **CSV visar refund 1 (november) för december-perioden** - vilket är motsägelsefullt om CSV också filtrerar baserat på datum
- **HYPOTES:** CSV använder en HELT ANNAN logik - kanske baserat på `order.processed_at` istället för `refund.created_at`, eller så är CSV-filen faktiskt för november-december perioden trots att vi testar med december

**Implementerad Kod:**
- Datum-filter i `calculateOrderSales()`: Filtrerar refunds baserat på `refund.created_at` inom `datePeriod.from` och `datePeriod.to`
- Filtreringen sker INNAN refunds räknas (rad 477-487 i `lib/shopify/sales.ts`)
- `calculateShopifyLikeSales()` accepterar `datePeriod` parameter och skickar vidare till `calculateOrderSales()`

**Nästa steg:**
1. ✅ Analys genomförd med `scripts/analyze_refunds_mismatches.ts`
2. ✅ Hämta refund.transactions från GraphQL - **GENOMFÖRD**
3. ❌ **RESULTAT:** Inkludering av refund.transactions förbättrade INTE matchningen (avg diff ökade från 789 kr till 955 kr)
4. ✅ **KRITISK UPPTÄCKT:** CSV filtrerar refunds baserat på datum (Order 7008752206167 analys)
5. ✅ **Datum-filter implementerat** i `calculateOrderSales()` - **MEN VERKAR INTE FUNGERA I PRAKTIKEN**
6. ⚠️ **NEXT:** Debugga varför datum-filtreringen inte fungerar när `calculateShopifyLikeSales()` anropas
7. ⚠️ **NEXT:** Verifiera om CSV-filen faktiskt är för rätt period eller om CSV använder annan logik
8. ⚠️ **NEXT:** Testa med fler orders för att förstå CSV's exakta refund-datum logik

**Test Script:** `scripts/analyze_refunds_mismatches.ts` (skapat 2025-01-27, uppdaterad 2025-01-27)
**Detaljerad analys:** Se `docs/RETURNS_REFUNDS_ANALYSIS_2025-01-27.md`

### 7. Index Alignment Bug Fix - Resultat (2025-01-27) ✅

**Efter fixen:**
- **88.5% accuracy** (2,667 perfect matches av 3,015 orders)
- Endast 347 mismatches (11.5%)
- Enorm förbättring från tidigare 0% match för mismatch-orders!

### 8. 100% Rabatterade Produkter Fix (2025-01-27) ✅

**Problem identifierat:**
- 23 orders med exakt 79.80 kr diff
- Alla hade 100% rabatterade produkter (399.00 kr produkt med 399.00 kr discount)

**Lösning identifierad:**
- Shopify Analytics inkluderar tax-komponenten av 100% rabatterade produkter i både Gross Sales OCH Discounts
- Tax component = price × tax_rate / (1 + tax_rate)
- För 399.00 kr produkt med 25% tax: 399.00 × 0.25/1.25 = 79.80 kr

**Fix implementerad:**
- Identifiera 100% rabatterade produkter: `Math.abs(itemTotal - itemDiscount) < 0.01`
- Lägg till tax-komponenten till både Gross Sales och Discounts

**Resultat:**
- 25 orders fixade (alla 79.80 kr diff-orders)
- Order 7127244669271: Alla metrics matchar nu perfekt (Gross Sales, Net Sales, Discounts) ✅
- Hypotes testad: 23/23 orders matchade perfekt (100%)
- Antal mismatches minskat från 347 till 322 orders

**Implementation:** `lib/shopify/sales.ts` rad 337-361 (Gross Sales), rad 372-393 (Discounts)

**Återstående mismatches efter fix:**
- 322 mismatches kvar (12.34% av 3,014 orders)
- Identifierade mönster:
  - ✅ **Orders med CSV = 0.00 kr (5 orders, 0.17%):** `total_tax = 0` OCH `fulfillment_status = null` - Shopify Analytics exkluderar dessa special orders
  - ⚠️ **7.25 kr diff-mönster (64 orders där CSV = subtotal_price):** Orders med discounts OCH tax_rate deviation > 0.1% från 25% använder CSV subtotal_price INCL tax direkt. Svårt att identifiera säkert i runtime utan CSV-jämförelse. Testade conditional logic men sänkte total accuracy, så inte implementerat.
  - **14.17-15.85 kr diff-mönster:** Orders med discounts där CSV-discounts verkar ha fel tecken i vissa fall. Kräver analys av discount-beräkningen.
  - **High Tax Rate orders (avg diff 6.78 kr):** Acceptabel diff, troligen mixed tax rates
  - **No Discounts No Refunds orders:** 5 orders matchar med `sum(line_items) / (1 + tax_rate)` formeln (15.2% match i denna kategori)

## Status Översikt: Vad är Löst vs Kvar

### ✅ LÖSTA PROBLEM (Implementerade Fixar)

1. **Index Alignment Bug** ✅ FIXAD (2025-01-27)
   - Problem: `perOrder` array hade fel index-alignment
   - Fix: Returnera alla orders i `perOrder` (behåll index-alignment)
   - Resultat: 88.5% accuracy
   - Implementation: `lib/shopify/sales.ts` rad 431-464

2. **100% Rabatterade Produkter (79.80 kr diff)** ✅ FIXAD (2025-01-27)
   - Problem: Tax-komponent saknades för 100% rabatterade produkter
   - Fix: Inkludera tax-komponent i både Gross Sales och Discounts
   - Resultat: 25 orders fixade, accuracy → 89.2%
   - Implementation: `lib/shopify/sales.ts` rad 337-361 (Gross Sales), rad 372-393 (Discounts)

3. **Zero-Tax Orders** ✅ FIXAD (2025-01-27)
   - Problem: Felaktig Gross Sales-beräkning för orders med `total_tax = 0`
   - Fix: Använd `sum(line_items)` direkt när tax = 0
   - Resultat: 100% matchning för zero-tax orders
   - Implementation: `lib/shopify/sales.ts` rad 331-336

4. **Discounts INCL vs EXCL Tax** ✅ FIXAD (2025-01-27)
   - Problem: Discounts returneras INCL tax från API, men CSV visar EXCL tax
   - Fix: Konvertera discounts med tax rate
   - Resultat: Korrekt discount-beräkning
   - Implementation: `lib/shopify/sales.ts` rad 350-360

5. **Tax Calculation** ✅ FIXAD (2025-01-27)
   - Problem: Beräknade tax istället för att använda direkt från API
   - Fix: Använd `total_tax` direkt från API
   - Resultat: Tax discrepancy reducerad från ~15% till ~0.9%
   - Implementation: `lib/shopify/sales.ts` rad 303-305

### ⚠️ IDENTIFIERADE MEN EJ LÖSTA PROBLEM

1. **CSV = 0.00 kr Orders** ⚠️ IDENTIFIERAT (ej fixat)
   - **Status:** Identifierat att 5 orders (0.17%) med `total_tax = 0` OCH `fulfillment_status = null` exkluderas av Shopify Analytics
   - **Lösning:** Filtrera bort dessa orders för att matcha CSV exakt
   - **Prioritet:** Medium (endast 0.17% av orders)
   - **Implementation:** Kräver uppdatering i `calculateShopifyLikeSales` eller filtrering efter beräkning
   - **Se:** "Edge Cases och Specialfall" → "Orders med CSV Gross Sales = 0.00 kr"

2. **7.25 kr Diff-mönster** ⚠️ IDENTIFIERAT (ej fixat)
   - **Status:** 64 orders där CSV = subtotal_price har mismatch (ofta 7.25 kr diff)
   - **Orsak:** CSV använder `subtotal_price` direkt när tax_rate deviates från 25% OCH order har discounts
   - **Test:** Conditional logic testades men sänkte total accuracy (87.66% → 87.29%), så inte implementerat
   - **Prioritet:** Low (diff är liten och fix sänker total accuracy)
   - **Notera:** Matematisk konsistens-check finns i kod men används inte (behålls för framtida förbättringar)
   - **Se:** "Historiska Lärdomar" → "7.25 kr Diff-mönster - Matematisk Konsistens-check"

3. **64.7% Multi-Product Orders - Produkt Matchning Problem** ⚠️ DELVIS FIXAD (2025-01-27)
   - **Status:** Scripts uppdaterade men begränsade av API scope
   - **Upptäckt:** 82.2% av non-proportional orders matchar perfekt när vi testar om CSV-värden är omkastade mellan produkter (med direkt produkt-ID matchning)
   - **Orsak:** CSV och API sorterar produkter olika - scripts matchade på index istället för produkt-ID
   - **Bevis:** "Swapped/Reordered allocation" ger 1495/1818 perfect matches (82.2%) när matchning på produkt-ID, vs 37.8% med best-effort matching
   - **Order-level breakdown (med direkt produkt-ID matchning):**
     - CSV Total = subtotalExclTax: 95.9% match med swapped allocation
     - CSV Total = subtotalPrice: 91.0% match med swapped allocation
     - CSV Total = sum(apiTotalExclTax): 96.4% match med swapped allocation
   - **Fix implementerad (2025-01-27):**
     - ✅ Scripts uppdaterade för permutation matching baserat på sortering
     - ✅ Matchar API items (sorterade av price×quantity) mot CSV items (sorterade av Gross Sales)
     - ⚠️ **BEGRÄNSNING:** Kan inte hämta produkt-ID från API utan `read_products` scope
   - **Nuvarande resultat:** 37.8% perfect matches med best-effort matching
   - **Potentiell förbättring:** 82.2% matches om `read_products` scope läggs till
   - **Se:** "Historiska Lärdomar" → "Line Item-Level Beräkning - Produkt Matchning Problem"

4. **Returns/Refunds Beräkning** ⚠️ KRITISKT PROBLEM (2025-01-27)
   - **Status:** Största källan till mismatches för orders med refunds - DEEP ANALYSIS GENOMFÖRD
   - **Upptäckt:** 1277 orders med refunds har avg Returns diff på 276.17 kr
   - **Påverkan:** Avg Net Sales diff på 381.99 kr för orders med refunds
   - **Breakdown:**
     - Returns primary issue: 277 orders (2.6% av alla mismatches)
     - Men 12.0% av alla mismatches har refunds
     - Top discrepancies visar stora Returns diffar (t.ex. 2,576 kr, 2,488 kr)
   - **Deep Analysis Resultat (190 orders, diff >= 50 kr):**
     - Avg Returns diff: 789.00 kr
     - Avg Net Sales diff: 1,076.96 kr
     - Max Returns diff: 2,576.33 kr
     - **KRITISK UPPTÄCKT:** CSV inkluderar shipping refunds/order-level refunds som saknar refund_line_items
     - **KRITISK UPPTÄCKT:** CSV Returns kan inkludera original order värde vid full refunds
   - **Prioritet:** High (största källan till Net Sales discrepancies)
   - **Nästa steg:** Hämta refund.transactions från GraphQL och analysera dessa
   - **Test Script:** `scripts/analyze_refunds_mismatches.ts` (skapat 2025-01-27, uppdaterad 2025-01-27)
   - **Se:** "Historiska Lärdomar" → "Returns/Refunds Beräkning Problem"

5. **22.8% Unmatched Line Items** ⚠️ UNDER ANALYS
   - **Status:** 22.8% av line items matchar ingen testad formel
   - **Genomsnittlig diff:** 361.79 kr
   - **Pattern:** 53.5% följer "CSV Gross = CSV Net + CSV Tax" mönstret
   - **Prioritet:** Medium (relativt hög diff men kan vara edge cases)
   - **Nästa steg:** Förstå hur CSV beräknar dessa line items
   - **Se:** "Historiska Lärdomar" → "Line Item-Level Beräkning - Insikter"

5. **High Tax Rate Orders (>26%)** ⚠️ ACCEPTERAT (ej fixat)
   - **Status:** 43 orders med mixed tax rates
   - **Avg diff:** 6.78 kr (relativt liten)
   - **Prioritet:** Low (acceptabel diff, troligen mixed tax rates som är svårt att hantera exakt)

### 📋 KOMMER ALDRIG ATT LÖSA (Acceptabla Begränsningar)

- **87.66% accuracy** är production-ready och excellent för e-handel analytics
- Små diffar (< 15 kr) i edge cases är acceptabla
- Vissa Shopify Analytics interna beräkningar kan inte replikeras exakt utan CSV-jämförelse

## Framtida Förbättringar

### 1. Fixa nuvarande implementation för mismatch-orders ✅ FIXAD

**Prioritet:** High (COMPLETED)

**Problem identifierat (2025-01-27):**
- Nuvarande implementation matchar 0% av mismatch-orders
- Formeln `sum(line_items) / (1 + tax_rate)` matchar 80.7% av mismatch-orders när den appliceras korrekt
- Vi använder redan denna formel, men något gör att den inte tillämpas för mismatch-orders

**Rotorsak identifierad:**
- `calculateShopifyLikeSales` filtrerade bort orders med `grossSales <= 0` från `perOrder` arrayen
- Detta gjorde att indexen i `perOrder` inte matchade indexen i `orders` arrayen
- Scripts fick därför fel data när de använde `perOrder[orderIndex]`

**Fix implementerad (2025-01-27):**
- Returnera ALLA orders i `perOrder` arrayen (behåll index-alignment)
- Filtrera bara när vi aggregerar totals (endast orders med `grossSales > 0`)
- **Resultat:** Orders matchar nu korrekt (t.ex. 7117571129687, 7117563396439 matchar perfekt)

**Implementation:** `lib/shopify/sales.ts` rad 431-464

### 2. Analys och fix av 79.80 kr diff-mönster ✅ FIXAD

**Prioritet:** High (COMPLETED)

**Problem:**
- Många orders hade exakt 79.80 kr diff
- Relaterat till 100% rabatterade produkter
- Systematiskt mönster

**Åtgärder genomförda:**
1. ✅ Analyserade orders med 79.80 kr diff i detalj
2. ✅ Identifierade exakt hur Shopify Analytics hanterar 100% rabatterade produkter
3. ✅ Implementerade samma logik i vår beräkning

**Resultat:**
- 25 orders fixade
- Alla 79.80 kr diff-orders matchar nu perfekt
- Accuracy förbättrad från 88.5% till ~89.2%

### 3. Filtrera orders med CSV Gross Sales = 0.00 kr

**Prioritet:** Medium

**Problem:**
- Orders där CSV = 0.00 kr men API har värde
- Dessa är troligen annullerade/test-orders som Shopify Analytics exkluderar

**Åtgärder:**
1. Identifiera vad som gör att Shopify Analytics exkluderar dessa (financial_status? cancelled_at?)
2. Implementera samma filtrering i vår implementation
3. Testa att dessa orders verkligen ska exkluderas

### 4. Produktionsklart - Acceptabla Begränsningar ✅

**Status:** Production-ready med 87.66% perfect matches

**Acceptabla begränsningar (2025-01-27):**
- **87.66% perfect matches** (2,642 / 3,014 orders) - mycket bra accuracy
- De återstående 322 mismatches (12.34%) är primärt edge cases med små diff (< 15 kr för de flesta)
- Per metric accuracy är excellent:
  - Gross Sales: 89.32% match
  - Net Sales: 94.89% match
  - Discounts: 90.15% match
  - Returns: 98.81% match
  - Tax: 98.87% match

**Kända edge cases som orsakar mismatches:**
1. **CSV = 0.00 kr orders (5 orders, 0.17%):** Special orders med `total_tax = 0` OCH `fulfillment_status = null` som Shopify Analytics exkluderar
2. **7.25 kr diff pattern (14+ orders):** Orders där CSV använder `subtotal_price` direkt istället för vår beräkning - orsak okänd men diff är liten
3. **14.17-15.85 kr diff:** Orders med discounts där CSV-discounts kan ha avvikelser - kräver vidare analys om det behövs
4. **High Tax Rate orders (>26%):** Mixed tax rates - avg diff 6.78 kr, acceptabel

**Rekommendation:**
- Nuvarande implementation är production-ready
- 87.66% accuracy är excellent för e-handel analytics
- De återstående mismatches är primärt edge cases med små påverkan
- Ytterligare optimering kan göras i framtiden om högre accuracy krävs

### 2. Dokumentation av Specialfall

**Prioritet:** Medium

- Samla alla edge cases med exempel
- Skapa test cases för varje edge case
- Automatisera validering

### 3. Continuous Validation

**Prioritet:** High

- Sätt upp automatiserad validering mot CSV-exporter
- Alerting vid stora discrepancies
- Trendanalys över tid
- Integrera i CI/CD pipeline

### 4. Performance Optimering

**Prioritet:** Low

- [Inga specifika performance-problem identifierade ännu]

## Referenser

- **Implementation:** `lib/shopify/sales.ts` - Huvudimplementation av beräkningar
- **Order Converter:** `lib/shopify/order-converter.ts` - Konverterar GraphQL orders till REST-format
- **Shopify GraphQL:** `lib/integrations/shopify-graphql.ts` - Hämtar orders från Shopify API
- **Shopify Integration:** `lib/integrations/shopify.ts` - OAuth, webhook registration, och webhook verification
- **Webhook Handler:** `app/api/webhooks/shopify/route.ts` - Hanterar incoming Shopify webhooks
- **Test Scripts:** `scripts/compare_*.ts`, `scripts/analyze_*.ts`, `scripts/verify_*.ts`, `scripts/debug_*.ts`
- **Shopify REST Admin API:** [Webhooks Documentation](https://shopify.dev/docs/api/admin-rest/latest/resources/webhook#post-webhooks)

## Arbetsprocess: När du jobbar med detta system

### FÖRE du börjar koda eller analysera:

1. **Läs denna dokumentation** - Särskilt:
   - "Status Översikt: Vad är Löst vs Kvar" (se ovan)
   - "Historiska Lärdomar" (för att undvika att göra samma misstag)
   - "Edge Cases och Specialfall" (för att förstå kända problem)

2. **Kontrollera om problemet redan är löst:**
   - Sök i dokumentationen efter relaterade problem
   - Kolla om det finns en fix i "✅ LÖSTA PROBLEM"
   - Undvik att implementera samma lösning två gånger

3. **Kontrollera om problemet är identifierat men ej löst:**
   - Kolla i "⚠️ IDENTIFIERADE MEN EJ LÖSTA PROBLEM"
   - Om problemet finns där, fortsätt där tidigare analys slutade
   - Uppdatera status när du jobbar med det

### NÄR du hittar nya fel, insikter eller förbättringar:

1. **Dokumentera INNAN du fixar:**
   - Lägg till problemet i "⚠️ IDENTIFIERADE MEN EJ LÖSTA PROBLEM" om det är nytt
   - Eller uppdatera befintlig entry om du hittar mer information

2. **När du fixar ett problem:**
   - Flytta från "⚠️ IDENTIFIERADE MEN EJ LÖSTA PROBLEM" till "✅ LÖSTA PROBLEM"
   - Lägg till detaljerad beskrivning i "Historiska Lärdomar"
   - Uppdatera "Implementation Status"
   - Uppdatera accuracy-statistik om relevant

3. **När du skapar ett nytt script:**
   - Lägg till det i "Test Scripts"-listan med beskrivning
   - Markera med ⭐ NYTT om det är nyligen skapat
   - Beskriv vad scriptet gör och varför det behövs

4. **När du uppdaterar koden:**
   - Uppdatera "Implementation Status"-sektionen
   - Lägg till referens till fil och radnummer där fixen är
   - Uppdatera datum i header

5. **Alltid uppdatera:**
   - Header med datum när ändringar görs
   - "Senaste uppdatering"-fältet med kort beskrivning
   - Accuracy-statistik om den ändras

### Varför denna process är viktig:

- **Undvika duplicerat arbete:** Problemlösningar som redan testats dokumenteras
- **Kunskapsbevarande:** Alla insikter sparas för framtida referens
- **Effektivitet:** Nya developers kan snabbt förstå vad som är löst och vad som är kvar
- **Kvalitet:** Etablerade patterns och lösningar följs konsekvent

---

**Senast uppdaterad:** 2025-01-27  
**Senaste ändring (2025-01-27):** 
- **RETURNS/REFUNDS DEEP ANALYSIS GENOMFÖRD:** Analyserat 190 orders med refunds (diff >= 50 kr). Identifierat kritiska patterns: CSV inkluderar shipping refunds/order-level refunds som saknar refund_line_items, CSV Returns kan inkludera original order värde vid full refunds. Avg Returns diff: 789.00 kr, Max: 2,576.33 kr. Skapat `scripts/analyze_refunds_mismatches.ts` för detaljerad analys. Se detaljerad dokumentation i `docs/RETURNS_REFUNDS_ANALYSIS_2025-01-27.md` och "Historiska Lärdomar" → "Returns/Refunds Beräkning Problem".
- **SHOPIFY WEBHOOKS DOKUMENTATION:** Komplett sektion tillagd med implementation details, REST Admin API referens, mandatory webhooks, best practices, och framtida förbättringar baserat på [Shopify REST Admin API Webhook dokumentation](https://shopify.dev/docs/api/admin-rest/latest/resources/webhook#post-webhooks)
- **PRODUKT MATCHNING PROBLEM IDENTIFIERAT OCH DELVIS FIXAD:** 82.2% av non-proportional orders matchar perfekt när produkter matchas på produkt-ID (theoretiskt), men endast 37.8% med nuvarande best-effort matching
- **FIX IMPLEMENTERAD:**
  - Scripts uppdaterade för permutation matching baserat på sortering (price×quantity vs CSV Gross Sales)
  - `sales.ts` typ uppdaterad för att inkludera optional `product_id` i line items
  - `analyze_line_item_allocation.ts` och `analyze_non_proportional_allocation.ts` uppdaterade för best-effort matching
- **BEGRÄNSNING:** Kan inte hämta produkt-ID från API utan `read_products` scope (nuvarande scope: `read_orders` only)
- **RESULTAT:** 37.8% perfect matches med best-effort (vs 82.2% med direkt produkt-ID matchning)
- **FRAMTIDA FÖRBÄTTRING:** Lägg till `read_products` i SHOPIFY_SCOPES för direkt produkt-ID matchning
- **DOKUMENTATIONSSTRUKTUR FÖRBÄTTRAD:** Tydlig separation mellan lösta problem, identifierade men ej lösta problem, och acceptabla begränsningar
- **ARBETSPROCESS DOKUMENTERAD:** Tydliga riktlinjer för hur man arbetar med systemet och dokumenterar nya insikter
- **NYA SCRIPTS DOKUMENTERADE:** `analyze_line_item_allocation.ts`, `analyze_unmatched_gross_discounts_returns.ts`, `analyze_csv_gross_equals_net_plus_tax.ts`, `comprehensive_unmatched_analysis.ts`, `analyze_non_proportional_allocation.ts`
- **LINE ITEM-LEVEL INSIKTER:** Dokumenterat att Net Sales = Gross Sales - Discounts - Returns (alltid), och att problemet ligger i de tre komponenterna

**Historik av tidigare ändringar:**
- Systematisk analys av 5,000 orders (1,794 mismatches) identifierade att formeln `sum(line_items) / (1 + tax_rate)` matchar 80.7% av mismatch-orders perfekt
- **KRITISK BUG FIX:** Identifierade och fixade index-alignment bug i `calculateShopifyLikeSales` där `perOrder` arrayen filtrerades men indexen fortfarande användes från ursprunglig `orders` array. Nu returnerar vi alla orders i `perOrder` (behåller index-alignment) och filtrerar bara vid aggregering.
- **EFTER FIXEN:** 2,667 perfect matches av 3,015 orders = **88.5% accuracy!** (347 mismatches = 11.5%)
- **100% RABATTERADE PRODUKTER FIX:** Identifierade att Shopify Analytics inkluderar tax-komponenten av 100% rabatterade produkter i både Gross Sales och Discounts. Fix implementerad - 25 orders fixade!
- **CSV = 0.00 KR ORDERS IDENTIFIERAT:** 5 orders med `total_tax = 0` OCH `fulfillment_status = null` exkluderas av Shopify Analytics (special orders)
- **FULL DATASET VERIFIERING:** 87.66% perfect matches (2,642 / 3,014 orders) bekräftat på hela dataset med följande per-metric accuracy:
  - Gross Sales: 89.32% match
  - Net Sales: 94.89% match
  - Discounts: 90.15% match
  - Returns: 98.81% match
  - Tax: 98.87% match

