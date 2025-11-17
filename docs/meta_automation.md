# Meta-automation (timvis drift)

Den här guiden beskriver hur vi automatiserar insamlingen av Meta Marketing API-data varje timme och låter workern ta hand om backfills/KPI-uppdateringar.

## 1. Timvis incremental sync (pg_cron + pg_net)

Supabase schemalägger Edge Functions via `pg_cron` + `pg_net`. Vi lagrar projekt-URL + Edge Function key i Supabase Vault och låter Postgres trigga `sync-meta` varje timme (payload `{"mode":"incremental"}`) enligt den officiella guiden (https://supabase.com/docs/guides/functions/schedule-functions).

### Snabb setup (prod)

#### Alternativ 1: Automatisk setup (rekommenderat)

1. **Deploya/uppdatera Edge Function:**
   ```bash
   bash scripts/setup_meta_automation.sh
   ```
   Detta script deployar `sync-meta` edge function.

2. **Kör automatiskt SQL-setup:**
   ```bash
   bash scripts/setup_meta_schedule_sql.sh
   ```
   Detta script:
   - Läser projekt-URL och service role key från `env/local.prod.sh` eller `.env.local`
   - Genererar SQL med rätt värden
   - Kan köra SQL:en direkt i Supabase (eller spara till fil för manuell körning)
   - Skapar/uppdaterar Vault-secrets automatiskt
   - Skapar cron-jobbet `meta-sync-hourly`

#### Alternativ 2: Manuell setup

1. **Deploya/uppdatera Edge Function:**
   ```bash
   supabase functions deploy sync-meta --project-ref <project-ref>
   ```

2. **Kör SQL-mallen** `supabase/sql/meta_sync_schedule.sql`:
   - Öppna filen och avkommentera/uncomment rätt rader (värdena är redan ifyllda från `env/local.prod.sh`)
   - Kör filen i Supabase SQL Editor eller via `psql` mot prod-databasen
   - Filen:
     - Säkerställer att `pg_cron` / `pg_net` finns
     - Skapar/uppdaterar Vault-secrets `meta_sync_project_url` och `meta_sync_function_key`
     - Unschedular eventuell gammal körning
     - Schemalägger `meta-sync-hourly` → `sync-meta` fem över varje heltimme

### Verifiera körningen

- Supabase Dashboard → Database → Cron jobs ska visa `meta-sync-hourly`
- Edge Functions → Logs ska få ett anrop ~5 min över hel timme

### Tips

- Vill du rotera secrets i framtiden? Kör bara `vault.update_secret(...)`-delen av SQL-filen och avsluta med `cron.schedule`.
- Om du behöver pausa jobbet kan du köra `select cron.unschedule('meta-sync-hourly');` i SQL Editorn.
- För dev-miljön kan du antingen använda samma SQL (med dev-ref) eller köra funktionen manuellt via `/api/jobs/sync?source=meta`.

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


