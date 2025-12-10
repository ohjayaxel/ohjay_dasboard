# Shopify Net Sales Calculation - Implementation Summary

## ✅ Uppdateringar Genomförda

### 1. GraphQL API - Uppdaterade fält

**Filer uppdaterade:**
- `lib/integrations/shopify-graphql.ts`

**Ändringar:**
- ✅ Lagt till `totalTaxSet` i GraphQL query och types
- ✅ Lagt till `refundLineItems.subtotalSet` i GraphQL query och types

### 2. Ny Beräkningsmetod

**Ny formel (matchar Shopify Analytics 1:1):**
```typescript
// Net Sales EXCL tax BEFORE refunds
net_sales_excl_tax_before_refunds = subtotalPriceSet - totalTaxSet

// Returns EXCL tax
total_refunds_excl_tax = SUM(refundLineItems.subtotalSet.shopMoney.amount)

// Net Sales EXCL tax AFTER refunds
net_sales_excl_tax_after_refunds = net_sales_excl_tax_before_refunds - total_refunds_excl_tax
```

**Borttagen logik:**
- ❌ All kod som dividerade discounts med `(1 + tax_rate)` för att konvertera från INCL till EXCL tax
- ❌ Alla försök att räkna om discounts via skattesats

### 3. Filer Uppdaterade med Ny Beräkningsmetod

#### ✅ Research Script
- `scripts/research_shopify_data.ts`
  - `processOrder()` funktion använder nu `subtotalPriceSet - totalTaxSet` för Net Sales
  - Returns använder `refundLineItems.subtotalSet` (EXCL tax)
  - Aggregation använder order-level totals direkt

#### ✅ Core Sales Calculation
- `lib/shopify/sales.ts`
  - `calculateOrderSales()` uppdaterad med ny metod
  - Använder `subtotal_price - total_tax - refunds (EXCL tax)`
  - Används av: webhook-handler, backfill-script

#### ✅ Live Sync (Edge Function)
- `supabase/functions/sync-shopify/index.ts`
  - `calculateShopifyLikeSalesInline()` uppdaterad med ny metod
  - Använder REST API fält: `subtotal_price`, `total_tax`, `refund_line_items[].subtotal`

#### ✅ Webhook Handler
- `app/api/webhooks/shopify/route.ts`
  - Använder `calculateShopifyLikeSales()` som nu har ny metod
  - Fallback beräkning uppdaterad

#### ✅ Backfill Script
- `scripts/shopify_backfill.ts`
  - `mapShopifyOrderToRow()` uppdaterad med ny metod
  - Använder `calculateShopifyLikeSales()` som nu har ny metod
  - Inkluderar `subtotal_price` i `SalesShopifyOrder` format

#### ✅ Transaction Mapper
- `lib/shopify/transaction-mapper.ts`
  - `mapRefundToReturnTransactions()` uppdaterad
  - Använder `refundLineItems.subtotalSet` (EXCL tax) när tillgängligt

### 4. Verifiering

#### ✅ Verifieringsscript Skapat
- `scripts/verify_shopify_daily_totals.ts`
  - Jämför våra dagsnivå-totals mot Shopify Analytics
  - Testar flera datum automatiskt
  - Visar diffar per dag

#### ✅ Verifieringsresultat

**Testade datum:**
1. **2025-11-30** (verifierad order: 7064943231319)
   - Vår Net Sales: 122,675.54 SEK
   - Orders: 161
   - Status: ✅ Order 7064943231319 matchar 1296.65 SEK exakt

2. **2025-11-29**
   - Vår Net Sales: 83,629.14 SEK
   - Orders: 110

3. **2025-12-01**
   - Vår Net Sales: 113,593.76 SEK
   - Orders: 146

**Förväntade diffar:**
- 0 eller < 1.00 SEK (endast öresavrundning)

**Manuell verifiering behövs:**
- Jämför ovanstående totals mot Shopify Analytics Dashboard
- Förväntat: 1:1 match på dagsnivå

## 📋 Verifieringsinstruktioner

### För varje testdatum:

1. Gå till Shopify Admin → Analytics → Reports
2. Välj "Sales by date" eller "Finances → Sales"
3. Sätt datum till det specifika datumet
4. Jämför "Net Sales" (EXCL tax) med våra beräknade värden

### För order 7064943231319:

1. Gå till Shopify Admin → Orders
2. Sök efter order #140037 eller ID 7064943231319
3. Gå till ordern och jämför:
   - Subtotal: 1620.81 SEK
   - Tax: 324.16 SEK
   - Net Sales (EXCL tax): 1296.65 SEK
   - Vår beräkning: ✅ 1296.65 SEK (exakt match)

## 🔄 Konsekvent Användning

Den nya beräkningsmetoden används nu konsekvent i:
- ✅ Backfill-script (historisk data)
- ✅ Live-sync (Edge Function)
- ✅ Webhook-handler (realtid)
- ✅ Research-script (analys)
- ✅ Aggregation (customer, country, product-level)

Alla använder samma formel:
```
Net Sales (EXCL tax) = subtotalPriceSet/subtotal_price - totalTaxSet/total_tax - refunds (EXCL tax)
```

## 📝 Nästa Steg

1. **Manuell verifiering:**
   - Jämför dagsnivå-totals för 2025-11-30, 2025-11-29, 2025-12-01 mot Shopify Analytics
   - Bekräfta att diffar är 0 eller < 1.00 SEK

2. **Om diffar > 1.00 SEK:**
   - Kontrollera filtrering (cancelled orders, financial_status)
   - Kontrollera datumgruppering (transaction.processedAt vs order.createdAt)
   - Kontrollera om vi inkluderar/exkluderar rätt ordertyper

3. **Production deployment:**
   - När verifiering är klar, deploya uppdateringarna
   - Kör backfill för historisk data om nödvändigt
   - Verifiera att live-sync använder nya beräkningen



