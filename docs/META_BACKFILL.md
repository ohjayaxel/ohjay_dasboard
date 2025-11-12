# Meta Backfill Playbook

Use this guide when a Meta Ads konto kopplas upp och historisk data behöver fyllas på.

## 1. Förutsättningar

- Meta-kontot är anslutet i admin och ett `selected_account_id` är sparat.
- Produktionsdatabasen har migreringen `007_meta_insights_daily_expand.sql` körd (kolumner som `action_report_time`, `breakdowns` osv. finns i `meta_insights_daily`).
- Lokalt skript körs med produktions-variabler: `source env/local.prod.sh`.

## 2. Kör backfill-skriptet

```bash
source env/local.prod.sh
pnpm tsx scripts/meta_backfill.ts \
  --tenant <tenant-uuid> \
  --account act_<account_id> \
  --since 2024-01-01 \
  --until 2024-12-31 \
  --chunk-size 1 \
  --concurrency 2
```

- `--tenant` är Supabase `tenants.id`.
- `--account` kan vara `act_123...` eller ID:t som visas i admin.
- `--since`/`--until` anges i `YYYY-MM-DD`. Kör gärna år för år (eller månad för månad) om datasetet är stort.
- `--chunk-size` anger hur många månader per async-jobb (1 månad ≈ säkrare, 3–6 månader går snabbare på mindre konton).
- `--concurrency` kan ökas till 3–4 när körningen sker i CI/server med gott om CPU.

Skriptet loggar schema-läge:
- `schemaMode: "extended"` ⇒ data skrivs till både `meta_insights_daily` (med attribution/breakdowns) och `meta_insights_levels`.
- `schemaMode: "legacy"` ⇒ databasen saknar förväntade kolumner; kör migreringen och starta om.

## 3. Verifiera utfallet

```sql
-- Ska visa rader med level = ad/campaign/adset och attribut
select date, level, action_report_time, attribution_window, breakdowns
from meta_insights_daily
where tenant_id = '<tenant-uuid>'
  and ad_account_id = 'act_<account_id>'
order by date desc
limit 20;

select count(*) as rows, min(date) as first_date, max(date) as last_date
from meta_insights_levels
where tenant_id = '<tenant-uuid>'
  and ad_account_id = 'act_<account_id>';
```

Dashboards ska visa kompletta dagliga datapunkter efter en lyckad körning.

## 4. Daglig inkrementell sync

- Admin-knappen **Trigger Meta sync** (och schemalagda körningar) anropar Supabase Edge Function `sync-meta`, vilket kör ~30 dagars inkrementell sync.
- Vid timeout (504) kör backfill-skriptet igen med `--since <30 dagar sedan> --until <idag>` för att fylla luckor.

## 5. Felsökning

- **504 / timeout** ⇒ Edge Function har en hård gräns (≈60–120 s). Dela upp intervallet och kör skriptet manuellt.
- **saknade kolumner** ⇒ se till att migreringen är körd. Skriptet loggar “Falling back to legacy schema” när kolumner saknas.
- **få/inga rader** ⇒ kontrollera att Meta access token är giltig och att rätt `selected_account_id` är valt i admin.

