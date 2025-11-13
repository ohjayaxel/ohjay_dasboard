# Meta-automation (timvis drift)

Den här guiden beskriver hur vi automatiserar insamlingen av Meta Marketing API-data varje timme och låter workern ta hand om backfills/KPI-uppdateringar.

## 1. Timvis incremental sync

Vi använder en GitHub Actions-workflow (`.github/workflows/meta-sync-hourly.yml`) som körs varje timme (`cron: '5 * * * *'`). Workflowen POST:ar mot Supabase Edge-funktionen `sync-meta` med `{"mode":"incremental"}`. Konfigurera följande GitHub-hemligheter innan du aktiverar workflowen:

- `SUPABASE_URL` – `https://<project>.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` – service role key för projektet

Workflowen kan även köras manuellt via “Run workflow”.

> Om du hellre vill använda Supabase CLI’s schemaläggning kan du exekvera `supabase functions schedule create` mot `sync-meta` med samma payload. Workflowen är ett enkelt sätt att komma igång utan extra infrastruktur.

## 2. Meta-backfill-worker i drift

`scripts/meta_backfill_worker.ts` måste vara igång dygnet runt för att:

1. Köra `scripts/meta_backfill.ts` för varje jobb i `meta_backfill_jobs`.
2. Direkt efteråt köra `scripts/meta_kpi_upsert.ts` så KPI-tabellerna uppdateras (inkl. valutakolumnen).

Under `infra/meta-worker/` finns färdiga filer för att deploya containern (Dockerfile, Fly.io-konfig och README). Se `infra/meta-worker/README.md` för detaljer.

Minsta set av miljövariabler:

```
SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
ENCRYPTION_KEY=<32-byte-nyckel>
APP_ENV=production
LOG_LEVEL=info
```

## 3. Kontrollera att allt snurrar

- Efter första timmen: `select max(date) from meta_insights_daily where tenant_id = '...';` ska visa dagens datum.
- `meta_backfill_jobs` ska få `status='completed'` och `aggregate_currency=true` på nya jobb.
- Dashboards (`/t/<slug>/meta`) visar färsk data inom någon minut (ISR 60s).

## 4. Hantera fel

- GitHub Actions-loggar visar om `sync-meta` svarade 4xx/5xx. Vid återkommande 504 → öka timeout (kör incremental i mindre fönster) eller flytta schemat till Supabase.
- Workern loggar rate limits/fel. Om processen dör startar Fly/hosten om den (se hostens autoscaling).
- Vid behov kan du pausa workflowen (Disable) eller workern (scale to 0) utan att påverka UI:t.


