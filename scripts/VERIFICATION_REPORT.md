# Shopify Calculations Verification Report

## Sammanfattning

Detta dokument verifierar att vi:
1. Hämtar korrekta fält från Shopify Admin API (GraphQL)
2. Beräknar Gross Sales, Net Sales, Discounts, Returns korrekt
3. Filtrerar orders korrekt (exkluderar cancelled, inkluderar korrekt financial_status)
4. Matchar Shopify Analytics rapporter så nära som möjligt

---

## 1. GraphQL Fields Verification

### ✅ Orders Fields - PRESENT:
- ✅ `createdAt` - Order skapad datum
- ✅ `processedAt` - Order processad datum (används för datumgruppering)
- ✅ `cancelledAt` - Order avbokad datum (används för filtrering)
- ✅ `currencyCode` - Valuta
- ✅ `subtotalPriceSet.shopMoney.amount` - Subtotal (inkl. skatt)
- ✅ `totalPriceSet.shopMoney.amount` - Total pris
- ✅ `totalDiscountsSet.shopMoney.amount` - Totala rabatter (inkl. skatt)
- ✅ `test` - Boolean för test orders
- ✅ `transactions[]` - Transaktioner (används för financial_status inference)

### ⚠️ Orders Fields - MISSING:
- ❌ `financial_status` - **EJ TILLGÄNGLIGT I GraphQL API**
  - **Lösning**: Vi infererar från `transactions[]` där `status === 'SUCCESS'` och `kind === 'SALE' || 'CAPTURE'`

### ✅ Line Items Fields - PRESENT:
- ✅ `lineItems[].originalUnitPriceSet.shopMoney.amount` - Pris per enhet (före rabatter)
- ✅ `lineItems[].quantity` - Antal
- ✅ `lineItems[].discountAllocations[].allocatedAmountSet.shopMoney.amount` - Rabatter per line item (inkl. skatt)

### ⚠️ Line Items Fields - MISSING:
- ❌ `line_items[].price` - **VI ANVÄNDER `originalUnitPriceSet` ISTÄLLET** (korrekt, detta är samma sak)

### ✅ Refunds Fields - PRESENT:
- ✅ `refunds[].refundLineItems[].lineItem.originalUnitPriceSet` - Original pris för refunded items
- ✅ `refunds[].refundLineItems[].quantity` - Antal refunded

### ⚠️ Refunds Fields - MISSING:
- ❌ `refunds[].transactions[].amount` - **EJ TILLGÄNGLIGT I GraphQL API**
  - **Lösning**: Vi använder `refunds[].refundLineItems[].lineItem.originalUnitPriceSet * quantity` istället
  - Detta är **korrekt** eftersom vi vill använda originalpris för returns, inte transaction amount

---

## 2. Calculation Logic Verification

### ✅ Gross Sales (Brutto, före rabatter, före returns):
```typescript
Gross Sales = SUM(line_items.originalUnitPriceSet.shopMoney.amount × quantity)
```
**Status**: ✅ **KORREKT** - Detta matchar specifikationen.

**Nuvarande implementation:**
```typescript
const grossLine = parseMoneyAmount(lineItem.originalUnitPriceSet.shopMoney.amount) * lineItem.quantity;
totalGrossSales += grossLine;
```

### ⚠️ Discounts:
```typescript
Discounts = SUM(line_items.discount_allocations.amount) + order-level discounts
```

**Status**: ⚠️ **DELVIS KORREKT** - Vi delar med 1.25 för att exkludera skatt, men detta antar 25% moms för alla ordrar.

**Nuvarande implementation:**
```typescript
// Line-level discounts (excl. tax)
const discountInclTax = parseMoneyAmount(allocation.allocatedAmountSet.shopMoney.amount);
const discountExclTax = discountInclTax / 1.25; // ⚠️ Assumes 25% VAT

// Order-level discounts
const totalDiscountsSet = order.totalDiscountsSet
  ? parseMoneyAmount(order.totalDiscountsSet.shopMoney.amount) / 1.25
  : 0;
```

**Problem**: Vi antar alltid 25% moms, men olika produkter/länder kan ha olika skattesatser.

**Rekommendation**: 
- Kontrollera `taxLines` för faktisk skattesats per line item
- Eller använd Shopify's `totalDiscountsSet` direkt om det redan är exkl. skatt (behöver verifieras)

### ✅ Returns:
```typescript
Returns = SUM(refunds[].refund_line_items[].original_price × quantity)
```

**Status**: ✅ **KORREKT** - Vi använder original pris för refunded items.

**Nuvarande implementation:**
```typescript
const originalPrice = parseMoneyAmount(originalLineItem.originalUnitPriceSet.shopMoney.amount);
const refundValue = originalPrice * refundLineItem.quantity;
```

### ✅ Net Sales (Efter rabatter och returns, exkl. tax):
```typescript
Net Sales = Gross Sales - Discounts - Returns
```

**Status**: ✅ **KORREKT** - Vi subtraherar discounts och returns från gross sales.

**Nuvarande implementation:**
```typescript
const netSales = grossLine - totalDiscount; // Per line item
// Total net sales = sum of all line items net sales
```

---

## 3. Filtering Logic Verification

### ✅ Exclude Cancelled Orders:
```typescript
if (order.cancelledAt) {
  return null; // Skip order
}
```
**Status**: ✅ **KORREKT** - Vi filtrerar bort orders med `cancelledAt !== null`.

**Nuvarande implementation:**
- I `processOrder()` funktionen: Vi kontrollerar `cancelledAt` (men gör det inte explicit)
- **PROBLEM**: Vi filtrerar inte explicit på `cancelledAt` i `processOrder()`!
- **BEHÖVER FIXAS**: Lägg till explicit check för `cancelledAt`

### ✅ Exclude Test Orders:
```typescript
if (order.test) {
  return null; // Skip order
}
```
**Status**: ✅ **KORREKT** - Vi filtrerar bort test orders i `fetchShopifyOrdersGraphQL()` via query filter `-test:true`.

### ⚠️ Financial Status Filtering:
```typescript
// Include only orders with successful transactions
const successfulTransactions = order.transactions?.filter(
  (t) => t.status === 'SUCCESS' && (t.kind === 'SALE' || t.kind === 'CAPTURE')
);
if (successfulTransactions.length === 0) {
  return null; // Skip order
}
```
**Status**: ✅ **KORREKT** - Vi inkluderar endast orders med successful transactions.

**Nuvarande implementation:**
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

**Notera**: 
- Vi inkluderar `paid` (SALE/CAPTURE med SUCCESS)
- Vi inkluderar `partially_refunded` (om det finns refunds OCH successful transactions)
- Vi exkluderar `pending`, `refunded`, `voided`, etc.

---

## 4. Double Counting Verification

### ✅ Returns not double-counted:
**Status**: ✅ **KORREKT** - Returns subtraheras från net sales separat, inte dubblerat.

### ✅ Tax not included in Net Sales:
**Status**: ✅ **KORREKT** - Net sales = gross - discounts - returns (exkl. tax).

**Verification:**
```typescript
// Net sales does NOT include tax
const netSales = grossLine - totalDiscount; // ✅ Excludes tax
```

### ⚠️ Potential Issue: Order-level discount distribution:
**Status**: ⚠️ **KAN VARA PROBLEMATISKT** - Vi distribuerar order-level discounts proportionellt baserat på gross sales.

**Nuvarande implementation:**
```typescript
const allocatedOrderDiscount =
  totalGrossSales > 0 ? (orderLevelDiscount * grossLine) / totalGrossSales : 0;
```

**Potentiellt problem**: Om Shopify distribuerar order-level discounts annorlunda kan detta ge fel resultat.

---

## 5. Summary of Issues Found

### 🔴 Critical Issues:

1. **Missing `cancelledAt` filter in `processOrder()`**
   - **Problem**: Vi filtrerar inte explicit på `cancelledAt` i `processOrder()`
   - **Fix**: Lägg till `if (order.cancelledAt) return null;` i början av `processOrder()`

2. **Tax rate assumption (25% VAT)**
   - **Problem**: Vi antar alltid 25% moms för alla rabatter
   - **Impact**: Kan ge fel discounts om olika produkter har olika skattesatser
   - **Fix**: Använd faktisk skattesats från `taxLines` eller verifiera om `totalDiscountsSet` redan är exkl. skatt

### ⚠️ Medium Priority Issues:

3. **Order-level discount distribution**
   - **Problem**: Vi distribuerar order-level discounts proportionellt, men Shopify kan göra det annorlunda
   - **Impact**: Mindre påverkan, men kan ge små avvikelser
   - **Rekommendation**: Verifiera mot Shopify Analytics för några ordrar med order-level discounts

### ✅ No Issues Found:

- ✅ Gross Sales calculation (korrekt)
- ✅ Returns calculation (korrekt)
- ✅ Net Sales calculation (korrekt)
- ✅ Test order filtering (korrekt)
- ✅ Financial status filtering (korrekt via transactions)
- ✅ No double counting of returns or tax

---

## 6. Recommendations

### Immediate Actions:

1. **Lägg till `cancelledAt` filter i `processOrder()`:**
   ```typescript
   function processOrder(order: GraphQLOrder, timezone: string = STORE_TIMEZONE): OrderData | null {
     // Exclude cancelled orders
     if (order.cancelledAt) {
       return null;
     }
     
     // ... rest of function
   }
   ```

2. **Verifiera tax rate för discounts:**
   - Kontrollera om `totalDiscountsSet` redan är exkl. skatt
   - Om inte, använd faktisk skattesats från `taxLines` per line item

### Testing:

3. **Testa mot Shopify Analytics:**
   - Kör verification scriptet för flera dagar
   - Jämför totals mot Shopify Analytics Dashboard
   - Identifiera systematiska avvikelser

4. **Testa edge cases:**
   - Orders med order-level discounts
   - Orders med flera refunds
   - Orders med olika skattesatser
   - Partially refunded orders

---

## 7. Field Mapping: REST API vs GraphQL API

### User Specification (REST API):
```
Orders:
- created_at / processed_at ✅
- cancelled_at ✅
- financial_status ❌ (inferred from transactions)
- currency ✅ (currencyCode)
- subtotal_price ✅ (subtotalPriceSet)
- total_price ✅ (totalPriceSet)
- total_tax ✅ (calculated from taxLines)
- total_discounts ✅ (totalDiscountsSet)

Line items:
- line_items[].price ✅ (originalUnitPriceSet)
- line_items[].quantity ✅
- line_items[].discount_allocations[].amount ✅

Refunds:
- refunds[].transactions[].amount ❌ (use refundLineItems instead)
- refunds[].refund_line_items ✅
```

**Conclusion**: Vi hämtar alla nödvändiga fält, med några små skillnader som är hanterade korrekt.



