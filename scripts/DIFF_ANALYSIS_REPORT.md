# Shopify Net Sales - Diff Analysis Report

## Sammanfattning

Vi jämför våra beräknade Net Sales-värden mot Shopify Analytics för tre datum i november 2025.

## Resultat

| Datum | Shopify Net Sales | Vårt Net Sales | Diff | Shopify Orders | Våra Orders | Order Diff | Diff % |
|-------|-------------------|----------------|------|----------------|-------------|------------|--------|
| **2025-11-28** | 111,773.01 SEK | 112,670.70 SEK | **-897.69 SEK** | 143 | 141 | -2 | -0.80% |
| **2025-11-29** | 83,658.14 SEK | 83,629.14 SEK | **29.00 SEK** | 110 | 110 | 0 | 0.03% |
| **2025-11-30** | 122,710.34 SEK | 122,675.54 SEK | **34.80 SEK** | 161 | 161 | 0 | 0.03% |

## Detaljerad Analys

### 2025-11-28 (-897.69 SEK, -2 orders)

**Problemet:**
- Vi har 2 ordrar färre än Shopify (141 vs 143)
- Men vårt Net Sales är högre (112,670.70 vs 111,773.01)
- Detta är motsägelsefullt: färre ordrar borde ge lägre total Net Sales om vi exkluderar liknande orders

**Vad vi exkluderar:**
- 1 cancelled order (#139795, cancelled_at=2025-12-01, created_at=2025-11-28)
- 3 orders utan successful transactions:
  - #139522
  - #139590
  - #139721

**Möjliga förklaringar:**
1. Shopify inkluderar 2 av dessa 4 orders (eller andra orders vi inte ser)
2. Dessa 2 orders har negativ Net Sales (t.ex. refunds som överstiger subtotalen), vilket skulle förklara varför Shopify har lägre total trots fler orders
3. Shopify använder ett annat datum för gruppering (t.ex. `order.createdAt` istället för `transaction.processedAt`)

**Åtgärd behövs:**
- Identifiera exakt vilka 2 orders Shopify inkluderar som vi exkluderar
- Verifiera Net Sales för dessa orders
- Kontrollera om Shopify använder ett annat datum för gruppering

### 2025-11-29 (29.00 SEK diff, 0.03%)

**Status:** ✅ Mycket liten diff, praktiskt taget identiskt

**Diff:** 29.00 SEK (0.03%)
**Orders:** Identiskt antal (110)

**Möjliga orsaker:**
- Öresavrundning vid aggregering
- Skillnad i hur Shopify räknar om några orders saknar `totalTaxSet` och vi måste falla tillbaka på taxLines
- Mycket liten skillnad som kan bero på hur Shopify räknar totals

**Bedömning:** Inom acceptabelt intervall för praktiska ändamål.

### 2025-11-30 (34.80 SEK diff, 0.03%)

**Status:** ✅ Mycket liten diff, praktiskt taget identiskt

**Diff:** 34.80 SEK (0.03%)
**Orders:** Identiskt antal (161)

**Möjliga orsaker:**
- Öresavrundning vid aggregering
- Skillnad i hur Shopify räknar om några orders saknar `totalTaxSet` och vi måste falla tillbaka på taxLines
- Mycket liten skillnad som kan bero på hur Shopify räknar totals

**Bedömning:** Inom acceptabelt intervall för praktiska ändamål.

## Slutsats

### För 2025-11-29 och 2025-11-30:
- ✅ **Diffarna är mycket små (0.03%)** och är inom acceptabelt intervall
- ✅ **Samma antal orders** indikerar att vi filtrerar korrekt
- ✅ Små diffar kan bero på öresavrundning eller edge cases i beräkningen

### För 2025-11-28:
- ⚠️ **Större diff (-897.69 SEK, -0.80%)** kräver ytterligare undersökning
- ⚠️ **2 ordrar färre** men högre Net Sales är motsägelsefullt
- 🔍 **Behöver identifiera** vilka orders Shopify inkluderar som vi exkluderar

## Rekommendationer

### Omedelbara åtgärder:

1. **För 2025-11-28:**
   - Identifiera de 2 orders som Shopify inkluderar men vi exkluderar
   - Kontrollera om Shopify använder `order.createdAt` eller `order.processedAt` istället för `transaction.processedAt`
   - Verifiera Net Sales-beräkningen för dessa orders

2. **För 2025-11-29 och 2025-11-30:**
   - Diffarna (0.03%) är inom acceptabelt intervall
   - Kan vara öresavrundning eller edge cases
   - Överväg att acceptera dessa små diffar om de inte påverkar affärsbeslut

### Långsiktiga förbättringar:

1. **Överväg att logga exakta diffar** för varje dag för att identifiera patterns
2. **Implementera validering** som varnar om diffar > 1% eller > 100 SEK
3. **Dokumentera edge cases** (t.ex. orders utan `totalTaxSet`, refunds utan `subtotalSet`)

## Tekniska Detaljer

### Vår beräkningsmetod:
```
Net Sales (EXCL tax) = subtotalPriceSet - totalTaxSet - refunds (EXCL tax)
```

### Filtrering:
- ✅ Exkluderar cancelled orders (`cancelledAt != null`)
- ✅ Exkluderar test orders (`test === true`)
- ✅ Endast orders med successful transactions (`status === 'SUCCESS'` och `kind === 'SALE' || 'CAPTURE'`)
- ✅ Använder `transaction.processedAt` för datumgruppering

### Shopify Analytics (antagande):
- Kan inkludera orders med andra transaction statusar
- Kan använda `order.createdAt` eller `order.processedAt` för datumgruppering
- Kan hantera cancelled orders annorlunda (t.ex. inkludera dem om de har refunds)


