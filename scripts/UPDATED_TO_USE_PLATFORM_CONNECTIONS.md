# Uppdatering: Script använder nu Platform Connections

## Ändringar

Alla script använder nu samma connection lookup som resten av plattformen:

### Backfill Script (`scripts/shopify_backfill.ts`)
- ✅ Använder `resolveTenantId()` från `@/lib/data/tenant`
- ✅ Använder `getShopifyConnection()` från `@/lib/integrations/shopify`
- ✅ Använder `getShopifyAccessToken()` från `@/lib/integrations/shopify`
- ✅ Använder `getSupabaseServiceClient()` från `@/lib/supabase/server`

### Verify Script (`scripts/verify_shopify_mode.ts`)
- ✅ Använder `resolveTenantId()` 
- ✅ Använder `getShopifyConnection()`

### Compare Script (`scripts/compare_modes.ts`)
- ✅ Använder `resolveTenantId()`

## Miljövariabler

Script behöver fortfarande miljövariabler för Supabase (eftersom `getSupabaseServiceClient()` läser från `process.env`), men:
- ✅ Ingen manual lookup av connections i databasen
- ✅ Använder samma kryptering/dekryptering som resten av plattformen
- ✅ Samma connection metadata-hantering

## Körning

Script fungerar nu exakt som resten av plattformen:

```bash
# Miljövariabler behövs fortfarande för Supabase-anslutning
source env/local.prod.sh  # eller din env-fil

# Kör script - använder automatiskt connection från databasen
pnpm tsx scripts/shopify_backfill.ts --tenant=skinome --since=2025-01-01
pnpm tsx scripts/verify_shopify_mode.ts --tenant=skinome --dates=2025-11-28,2025-11-29,2025-11-30
pnpm tsx scripts/compare_modes.ts --tenant=skinome --from=2025-11-28 --to=2025-11-30
```

## Fördelar

1. **Konsistens**: Samma logik som API routes och webhooks
2. **Säkerhet**: Använder samma kryptering/dekryptering
3. **Enklare**: Ingen duplicerad connection lookup-kod
4. **Underhållbart**: Ändringar i connection-hantering påverkar automatiskt scripts också



