# Analys: Hur vi bestämmer vilket datum en order tillhör

## Aktuell Implementering

### 1. Transaction Mapper (`lib/shopify/transaction-mapper.ts`)

**För SALE transactions:**
```typescript
event_date: toLocalDateString(order.createdAt, timezone)  // Rad 115
```
✅ Använder `order.createdAt` (när ordern skapades)

**För RETURN transactions:**
```typescript
event_date: toLocalDateString(refund.createdAt, timezone)  // Rad 153
```
✅ Använder `refund.createdAt` (när refunden skapades)

### 2. Research Script (`scripts/research_shopify_data.ts`)

**Kommentar (rad 58-61):**
```
We use transaction.processedAt instead of order.createdAt because:
- An order can be created on one date but the transaction processed on another
- For financial reporting, we care about when the payment was processed
```

⚠️ **INKONSISTENS:** Kommentaren säger att vi använder `transaction.processedAt`, men koden använder faktiskt `order.createdAt`.

### 3. Backfill Script (`scripts/shopify_backfill.ts`)

```typescript
const processedAt = order.processed_at
  ? new Date(order.processed_at).toISOString().slice(0, 10)
  : null;
```
✅ Använder `order.processed_at` (när ordern processades)

### 4. Live Sync / Webhook (`app/api/webhooks/shopify/route.ts`)

**Komplex prioritetslogik (rad 96-124):**
```typescript
// Priority 1: Check for refunds created today
if (refund.created_at === today) {
  processedAt = refundDate;
}
// Priority 2: If created_at is today, use created_at
if (orderCreatedAt === today) {
  processedAt = orderCreatedAt;
}
// Priority 3: Otherwise use processed_at
```

✅ Använder **prioritetslogik** (inte bara en tidstämpel)

### 5. Edge Function Sync (`supabase/functions/sync-shopify/index.ts`)

**Samma komplex prioritetslogik (rad 418-450):**
```typescript
// Priority 1: Check for refunds created today
// Priority 2: If created_at is today, use created_at  
// Priority 3: Otherwise use processed_at
```

✅ Använder **samma prioritetslogik** som webhook

---

## Problem: Inkonsekvent Datumlogik

Vi har **två olika metoder** som används på olika ställen:

### Metod A: `order.createdAt` (Transaction Mapper)
- När ordern **skapades** i Shopify
- Oavsett när betalningen processades
- Används i: `transaction-mapper.ts`

### Metod B: `transaction.processedAt` eller `order.processed_at` (Backfill)
- När **betalningen processades**
- Kan vara annorlunda datum än när ordern skapades
- Används i: `shopify_backfill.ts`

---

## Skillnaden

### Exempel:
- Order skapad: 2025-11-28 kl 23:30 (UTC)
- Transaction processad: 2025-11-29 kl 01:15 (UTC)

**Med `order.createdAt`:**
- Order tillhör: 2025-11-28 (i lokal tid: Stockholm)

**Med `transaction.processedAt`:**
- Order tillhör: 2025-11-29 (i lokal tid: Stockholm)

---

## Shopify's Metod

Enligt vår analys:
- **Shopify Analytics använder:** `order.createdAt` för datumgruppering
- Detta är anledningen till att vi har 2 orders som skiljer sig:
  - Order #139795: Skapad 2025-11-28, processad 2025-11-28, men vi exkluderar pga cancelled
  - Order #139721: Skapad 2025-11-28, men vi exkluderar pga ingen transaction

---

## Rekommendation

### För Matchning med Shopify Analytics:
✅ Använd `order.createdAt` (som vi gör i transaction-mapper)

### För Finansiellt Korrekt (Kassaflöde):
✅ Använd `transaction.processedAt` (när pengarna faktiskt kom in)

### Strategi:
1. **Primär metod:** `transaction.processedAt` för finansiellt korrekt BI
2. **Shopify Mode:** `order.createdAt` för direkt matchning med Shopify Analytics

---

## Nästa Steg

1. ✅ Verifiera hur webhooks hanterar datum
2. ✅ Verifiera hur incremental sync hanterar datum  
3. ✅ Identifiera alla platser där datum bestäms
4. ✅ Standardisera till en konsekvent metod (eller dokumentera olika "modes")

---

## Fråga från Användaren

> "Använder vi tidstämpel när datan registrerades för att avgöra vilket datum som ordern ska tillhöra?"

**Svar: INTE ENKELT - Vi har olika metoder:**

### 1. Transaction Mapper (för shopify_sales_transactions tabell)
- **SALE:** ✅ Använder `order.createdAt` (när ordern registrerades)
- **RETURN:** ✅ Använder `refund.createdAt` (när refunden registrerades)

### 2. Backfill / Sync / Webhook (för shopify_orders tabell)
- **Komplex prioritetslogik:**
  1. Om refund skapades idag → Använd `refund.created_at`
  2. Om order skapades idag → Använd `order.created_at`
  3. Annars → Använd `order.processed_at`

**Så:**
- ✅ **Transaction mapper:** Använder `createdAt` (registreringsdatum)
- ⚠️ **Backfill/Sync/Webhook:** Använder **prioritetslogik** som kan använda antingen `createdAt` eller `processedAt` beroende på kontext
- ⚠️ **Research Script Kommentar:** Säger att vi borde använda `transaction.processedAt`, men transaction-mapper gör inte det

**Detta är en inkonsekvens mellan transaction-mapper och övriga delar!**

