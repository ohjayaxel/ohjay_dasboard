# Varför dessa orders exkluderas av oss men inkluderas av Shopify Analytics

## Orders som frågas om

1. **7056661905751** - Order #139795
2. **7052073599319** - Order #139721

---

## Order #139795 (7056661905751)

### Varför Shopify inkluderar:
- ✅ Order skapad: **2025-11-28** (Shopify använder `order.createdAt` för datumgruppering)
- ✅ Shopify Analytics räknar alla orders som skapades på datumet, oavsett om de är cancelled eller inte

### Varför vi exkluderar:

**Kod i `scripts/research_shopify_data.ts` (rad 189):**
```typescript
if (order.cancelledAt) {
  return null; // Skip cancelled orders
}
```

**Anledning:**
- Order är **cancelled** (cancelled_at: 2025-12-01)
- Vi exkluderar alla cancelled orders för datakvalitet
- Finansiellt korrekt: En cancelled order ger ingen intäkt

**Order detaljer:**
- Created: 2025-11-28
- Cancelled: 2025-12-01
- Net Sales: -148.48 SEK (negativ pga full refund)
- Had 1 successful transaction on 2025-11-28, but cancelled and refunded later

---

## Order #139721 (7052073599319)

### Varför Shopify inkluderar:
- ✅ Order skapad: **2025-11-28** (Shopify använder `order.createdAt` för datumgruppering)
- ✅ Shopify Analytics räknar alla orders som skapades på datumet, även om de inte har någon betalning

### Varför vi exkluderar:

**Kod i `scripts/research_shopify_data.ts` (rad 194-203):**
```typescript
const successfulTransactions = (order.transactions || []).filter(
  (txn) =>
    (txn.kind === 'SALE' || txn.kind === 'CAPTURE') &&
    txn.status === 'SUCCESS' &&
    txn.processedAt,
);

if (successfulTransactions.length === 0) {
  return null; // Skip orders without successful transactions
}
```

**Anledning:**
- Order har **inga successful transactions**
- Vi kräver att en order måste ha minst 1 successful SALE/CAPTURE transaction
- Finansiellt korrekt: En order utan betalning ger ingen intäkt

**Order detaljer:**
- Created: 2025-11-28
- Transactions: 0 (inga transactions alls)
- Net Sales: 0.00 SEK (ingen värde)
- Not confirmed

---

## Skillnaden: Datumlogik

### Shopify Analytics:
- **Använder:** `order.createdAt` för datumgruppering
- **Inkluderar:** Alla orders skapade på datumet, oavsett:
  - Om de är cancelled
  - Om de har transactions
  - Om de är confirmed

### Vårt system:
- **Använder:** `transaction.processedAt` för datumgruppering (när betalningen processades)
- **Exkluderar:**
  - Cancelled orders
  - Orders utan successful transactions
  - Orders som inte är confirmed (i vissa fall)

---

## Varför vi gör så här

### Finansiellt korrekt BI:
1. **Cancelled orders:** Ger ingen intäkt → Exkludera
2. **Orders utan betalning:** Ger ingen intäkt → Exkludera
3. **Transaction.processedAt:** När pengarna faktiskt kom in → Bättre för kassaflöde

### Shopify Analytics:
- Fokuserar på när ordern **skapades** (marknadsföringsperspektiv)
- Inkluderar cancelled orders för att visa "förlorad försäljning"
- Inkluderar orders utan betalning för att visa "missade konverteringar"

---

## Sammanfattning

| Order ID | Shopify Inkluderar | Vi Exkluderar | Anledning |
|----------|-------------------|---------------|-----------|
| 7056661905751 | ✅ Ja (created 2025-11-28) | ❌ Nej | Cancelled order |
| 7052073599319 | ✅ Ja (created 2025-11-28) | ❌ Nej | Inga successful transactions |

**Total Impact:** -148.48 SEK (från order #139795, order #139721 har 0.00 SEK)

---

## Rekommendation

**Behåll vår nuvarande logik** eftersom:
- ✅ Finansiellt korrekt för BI
- ✅ Bättre för kassaflödesanalys
- ✅ Bättre för marketing attribution (ROAS, LTV, CoS)

**För Shopify-matchning:**
- Implementera en separat "Shopify Mode" som använder `order.createdAt` och inkluderar cancelled orders
- Detta kan vara en optional view för direkt jämförelse



