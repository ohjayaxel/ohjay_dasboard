# Shopify Backfill - Lokal Körning

Detta script kör Shopify backfill direkt mot Supabase-databasen lokalt, vilket är bättre än att köra via Supabase Functions online.

## Fördelar med lokal backfill

- **Snabbare**: Direkt anslutning till databasen utan Edge Function overhead
- **Mer kontroll**: Ser exakt vad som händer, bättre för debugging
- **Inga API-gränser**: Inga Supabase Function timeout-gränser
- **Bättre felhantering**: Kan se alla fel direkt i terminalen
- **Dry-run möjlighet**: Testa utan att spara data

## Förutsättningar

1. Environment variables måste vara satta. Använd antingen:
   - En `.env.local` fil med alla variabler
   - Eller source en environment-fil: `source env/local.prod.sh`

2. Nödvändiga environment variables:
   - `SUPABASE_URL` eller `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ENCRYPTION_KEY`

## Användning

### Grundläggande användning

```bash
# Se till att environment variables är satta
source env/local.prod.sh  # eller använd .env.local

# Kör backfill för hela året 2025
pnpm tsx scripts/shopify_backfill.ts \
  --tenant skinome \
  --since 2025-01-01 \
  --until 2025-12-31
```

### Exempel: Backfill för ett specifikt datum

```bash
pnpm tsx scripts/shopify_backfill.ts \
  --tenant skinome \
  --since 2025-01-01 \
  --until 2025-01-31
```

### Dry-run (testa utan att spara)

```bash
pnpm tsx scripts/shopify_backfill.ts \
  --tenant skinome \
  --since 2025-01-01 \
  --until 2025-01-31 \
  --dry-run
```

### Till idag (default)

```bash
# Om --until inte anges, används idag som default
pnpm tsx scripts/shopify_backfill.ts \
  --tenant skinome \
  --since 2025-01-01
```

## Argument

- `--tenant <slug>` (obligatoriskt) - Tenant slug (t.ex. `skinome`, `orange-juice-demo`)
- `--since <YYYY-MM-DD>` (obligatoriskt) - Startdatum för backfill
- `--until <YYYY-MM-DD>` (valfritt) - Slutdatum (default: idag)
- `--dry-run` (valfritt) - Hämta data men spara inte till databasen

## Vad scriptet gör

1. **Hämtar tenant och connection**: Verifierar att tenant och Shopify-connection finns
2. **Dekrypterar access token**: Dekrypterar Shopify access token från databasen
3. **Hämtar orders från Shopify**: 
   - Använder pagination för att hämta alla orders i datumintervallet
   - Hanterar Shopify API-gränser (max ~12,500 orders per query)
   - Delar upp i månadsvisa chunks om nödvändigt
4. **Mappar orders**: Konverterar Shopify orders till databasformat
5. **Bestämmer nya kunder**: Kollar vilka kunder som är nya vs returning
6. **Sparar till databas**:
   - Upsertar orders till `shopify_orders` tabellen
   - Aggregerar KPIs och sparar till `kpi_daily` tabellen
7. **Rensar backfill flag**: Tar bort `backfill_since` från connection metadata

## Exempel på output

```
[shopify_backfill] Starting backfill for tenant: skinome
[shopify_backfill] Period: 2025-01-01 to 2025-12-31
[shopify_backfill] Dry run: NO

[shopify_backfill] Found tenant: Skinome (abc123...)
[shopify_backfill] Shop domain: skinome-project.myshopify.com
[shopify_backfill] Access token decrypted successfully

[shopify_backfill] Fetching orders from 2025-01-01 to 2025-12-31...
[shopify_backfill] Fetching page 1...
[shopify_backfill] Fetched 250 orders (250 in date range, total: 250)
[shopify_backfill] Fetching page 2...
[shopify_backfill] Fetched 250 orders (250 in date range, total: 500)
...

[shopify_backfill] Mapped 1250 orders to database rows

[shopify_backfill] Upserting orders to shopify_orders table...
[shopify_backfill] Successfully saved 1250 orders

[shopify_backfill] Aggregated 365 KPI rows
[shopify_backfill] Upserting KPIs to kpi_daily table...
[shopify_backfill] Successfully saved 365 KPI rows

[shopify_backfill] ✅ Backfill completed successfully!

[shopify_backfill] Summary:
  - Orders processed: 1250
  - KPI rows created: 365
  - Date range: 2025-01-01 to 2025-12-31
```

## Felsökning

### "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"

Kontrollera att environment variables är satta:
```bash
echo $SUPABASE_URL
echo $SUPABASE_SERVICE_ROLE_KEY
```

### "Tenant not found"

Kontrollera tenant slug:
```bash
# I Supabase SQL Editor:
SELECT slug, name FROM tenants;
```

### "Failed to decrypt access token"

Kontrollera att `ENCRYPTION_KEY` är samma som när token krypterades.

### Shopify API Rate Limits

Scriptet hanterar automatiskt rate limits med:
- Pagination med `page_info`
- Delar upp i månadsvisa chunks om nödvändigt
- 1.5 sekunders delay mellan chunks

## Skillnader från online backfill

Online backfill (via Supabase Functions):
- Körs via `triggerShopifyBackfill` action
- Sätter `backfill_since` flag i connection metadata
- Triggar Supabase Function som kör asynkront
- Begränsad av Edge Function timeout (50 sekunder)
- Svårare att debugga

Lokal backfill (detta script):
- Körs direkt från din dator
- Ansluter direkt till Supabase databas
- Ingen timeout-gräns
- Full kontroll och bättre debugging
- Kan köra dry-run först

## Rekommendation

**Använd alltid lokal backfill för stora dataset (>1000 orders eller >1 månad).**

För små backfills (<100 orders, <1 vecka) kan online backfill fungera, men lokal backfill är alltid säkrare och mer pålitlig.

