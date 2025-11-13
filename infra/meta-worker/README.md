# Meta Backfill Worker Deployment

Det här paketet innehåller det som behövs för att köra `scripts/meta_backfill_worker.ts` kontinuerligt på en miljö utan tidsgräns (t.ex. Fly.io, Railway eller egen VM). Workern plockar upp rader från `meta_backfill_jobs`, kör `scripts/meta_backfill.ts` och aggregerar sedan KPI-datan via `scripts/meta_kpi_upsert.ts`.

## Miljövariabler

Följande variabler måste finnas i runtime-miljön:

| Variabel | Beskrivning |
| --- | --- |
| `SUPABASE_URL` | Din Supabase-projekt-URL (`https://<ref>.supabase.co`). |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (krävs för inskrivning till databasen). |
| `NEXT_PUBLIC_SUPABASE_URL` | Samma som `SUPABASE_URL` (behövs av supabase-klienten). |
| `SUPABASE_SERVICE_KEY` | Alias för service role key (om du vill, annars räcker `SUPABASE_SERVICE_ROLE_KEY`). |
| `ENCRYPTION_KEY` | 32-byte nyckeln som används för Meta-token. |
| `APP_ENV` | Sätt till `production` för prod-körningar. |
| `LOG_LEVEL` | (valfri) `info`, `debug`, etc. |

> Tips: Sätt både `SUPABASE_SERVICE_ROLE_KEY` och `SUPABASE_SERVICE_KEY` till samma secret om du har kod som läser olika namn.

## Fly.io-exempel

1. Installera Fly CLI och logga in.
2. Kör `fly launch --path infra/meta-worker --name ohjay-meta-worker --no-deploy`.
3. Sätt secrets:

   ```bash
   fly secrets set \
     SUPABASE_URL=https://punicovacaktaszqcckp.supabase.co \
     NEXT_PUBLIC_SUPABASE_URL=https://punicovacaktaszqcckp.supabase.co \
     SUPABASE_SERVICE_ROLE_KEY=... \
     ENCRYPTION_KEY=... \
     APP_ENV=production \
     LOG_LEVEL=info
   ```

4. Deploya: `fly deploy --path infra/meta-worker --ha=false`.
5. Verifiera att maskinen startar och loggar `Starting Meta backfill job` när köade jobb finns.

## Railway / annan container-host

1. Bygg med `docker build -f infra/meta-worker/Dockerfile -t meta-worker .`.
2. Kör lokalt för test:

   ```bash
   docker run --rm \
     -e SUPABASE_URL=... \
     -e NEXT_PUBLIC_SUPABASE_URL=... \
     -e SUPABASE_SERVICE_ROLE_KEY=... \
     -e ENCRYPTION_KEY=... \
     -e APP_ENV=production \
     meta-worker
   ```

3. Publicera containern till valfri host och konfigurera samma env-variabler.

Workern avslutar aldrig (loopar med `sleep`). När inga jobb finns väntar den 10 sekunder och försöker igen.


