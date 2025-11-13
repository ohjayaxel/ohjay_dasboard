# Meta-automation (timvis drift)

Den här guiden beskriver hur vi automatiserar insamlingen av Meta Marketing API-data varje timme och låter workern ta hand om backfills/KPI-uppdateringar.

## 1. Timvis incremental sync (Supabase Scheduler)

Supabase har inbyggt stöd för schemalagda Edge Function-körningar. Vi skapar ett cron-jobb som ropar `sync-meta` varje timme:

1. Säkerställ att du har Supabase CLI ≥ v1.181 installerad och att `SUPABASE_ACCESS_TOKEN` är satt.
2. Kör skriptet i repot:

   ```bash
   SUPABASE_PROJECT_REF=punicovacaktaszqcckp \
   META_SYNC_CRON="5 * * * *" \
   scripts/setup_meta_sync_schedule.sh
   ```

   - `SUPABASE_PROJECT_REF` kan sättas via env eller matas in när skriptet körs.
   - `META_SYNC_CRON` är valfri; default är `5 * * * *` (fem över varje heltimme).
3. Bekräfta i Supabase Dashboard → Edge Functions → Schedules att `meta-sync-hourly` finns och är aktiv.

Cron-jobbet skickar payloaden `{"mode":"incremental"}`, vilket gör att `sync-meta` kör sin 30-dagars inkrementella synk med D+3 overlap varje timme.

> Fallback: om Supabase Scheduler inte skulle räcka (t.ex. vid behov av second-level intervall) kan man använda GitHub Actions eller Vercel Cron. Supabase-lösningen är dock enklast att underhålla eftersom den körs i samma infrastruktur som Edge Functions.

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

- Supabase Dashboard → Edge Functions → Logs visar svaren från `sync-meta`. Vid återkommande 504, överväg att minska fönstret eller sprida konton över flera körningar.
- Workern loggar rate limits/fel. Om processen dör startar din host (Fly/Railway/VM) om den – kontrollera autoscaling/policy.
- Behöver du pausa: ta bort/pause cron-jobbet via `supabase functions schedule delete meta-sync-hourly` eller skala ner workern till 0 instanser.


