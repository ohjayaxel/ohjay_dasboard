#!/usr/bin/env bash

# Script för att generera och köra SQL för meta-sync scheduling
# Läser värden från env/local.prod.sh eller .env.local

set -euo pipefail

if ! command -v supabase >/dev/null 2>&1; then
  echo "❌ Supabase CLI saknas. Installera via https://supabase.com/docs/guides/cli." >&2
  exit 1
fi

# Hämta project ref och service role key från env-filer
PROJECT_URL=""
SERVICE_ROLE_KEY=""

# Försök hämta från local.prod.sh först
if [ -f env/local.prod.sh ]; then
  source env/local.prod.sh
  PROJECT_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
  SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"
fi

# Fallback till .env.local om local.prod.sh saknade värden
if [ -z "$PROJECT_URL" ] && [ -f .env.local ]; then
  PROJECT_URL=$(grep -E "^NEXT_PUBLIC_SUPABASE_URL=" .env.local | cut -d '=' -f 2- | tr -d '"' || echo "")
  SERVICE_ROLE_KEY=$(grep -E "^SUPABASE_SERVICE_ROLE_KEY=" .env.local | cut -d '=' -f 2- | tr -d '"' || echo "")
fi

if [ -z "$PROJECT_URL" ]; then
  echo "❌ Kunde inte hitta NEXT_PUBLIC_SUPABASE_URL i env/local.prod.sh eller .env.local" >&2
  exit 1
fi

if [ -z "$SERVICE_ROLE_KEY" ]; then
  echo "❌ Kunde inte hitta SUPABASE_SERVICE_ROLE_KEY i env/local.prod.sh eller .env.local" >&2
  exit 1
fi

echo "📋 Genererar SQL med följande värden:"
echo "   Project URL: $PROJECT_URL"
echo "   Service Role Key: ${SERVICE_ROLE_KEY:0:20}..."
echo ""

# Skapa temporär SQL-fil
SQL_FILE=$(mktemp)
trap "rm -f $SQL_FILE" EXIT

cat > "$SQL_FILE" <<EOF
-- Meta sync scheduling script (auto-generated)
-- Generated from env/local.prod.sh or .env.local

-- Enable required extensions
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store secrets in Supabase Vault (idempotent - will update if exists)
-- If secrets already exist, this will update them. If not, they'll be created.
do \$\$
begin
  -- Try to update first (if exists)
  perform vault.update_secret('meta_sync_project_url', '$PROJECT_URL');
exception
  when others then
    -- If update fails, create new
    perform vault.create_secret('$PROJECT_URL', 'meta_sync_project_url');
end
\$\$;

do \$\$
begin
  -- Try to update first (if exists)
  perform vault.update_secret('meta_sync_function_key', '$SERVICE_ROLE_KEY');
exception
  when others then
    -- If update fails, create new
    perform vault.create_secret('$SERVICE_ROLE_KEY', 'meta_sync_function_key');
end
\$\$;

-- Remove previous job if it exists
do \$\$
begin
  perform cron.unschedule('meta-sync-hourly');
exception
  when others then
    null;
end
\$\$;

-- Schedule sync-meta every hour (five minutes past) with incremental payload
select
  cron.schedule(
    'meta-sync-hourly',
    '5 * * * *',
    \$\$
    select
      net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'meta_sync_project_url') || '/functions/v1/sync-meta',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'meta_sync_function_key')
        ),
        body := jsonb_build_object('mode', 'incremental')
      ) as request_id;
    \$\$
  );
EOF

echo "✅ SQL genererad i temporär fil: $SQL_FILE"
echo ""

# Fråga om användaren vill köra SQL:en
read -p "Vill du köra SQL:en direkt i Supabase? (j/n): " -r
echo ""

if [[ $REPLY =~ ^[Jj]$ ]]; then
  # Hämta project ref från URL
  PROJECT_REF=$(echo "$PROJECT_URL" | sed -E 's|https://([^.]+)\.supabase\.co.*|\1|')
  
  if [ -z "$PROJECT_REF" ]; then
    echo "❌ Kunde inte extrahera project ref från URL: $PROJECT_URL" >&2
    exit 1
  fi
  
  echo "📤 Kör SQL mot Supabase projekt: $PROJECT_REF"
  echo ""
  
  # Kör SQL via supabase db execute
  if supabase db execute --file "$SQL_FILE" --linked 2>/dev/null || \
     supabase db execute --file "$SQL_FILE" --project-ref "$PROJECT_REF" 2>/dev/null; then
    echo ""
    echo "✅ SQL kördes framgångsrikt!"
    echo ""
    echo "📋 Verifiera:"
    echo "   - Gå till Supabase Dashboard → Database → Cron jobs"
    echo "   - Kontrollera att 'meta-sync-hourly' finns och är aktiv"
    echo "   - Efter första timmen, kolla logs i Edge Functions → Logs"
  else
    echo ""
    echo "⚠️  Kunde inte köra SQL automatiskt. Kör SQL:en manuellt:"
    echo ""
    echo "   1. Kopiera innehållet från $SQL_FILE"
    echo "   2. Gå till Supabase Dashboard → SQL Editor"
    echo "   3. Klistra in och kör SQL:en"
    echo ""
    echo "   Alternativt via CLI:"
    echo "   supabase db execute --file $SQL_FILE --project-ref $PROJECT_REF"
  fi
else
  echo "💾 SQL sparad i: $SQL_FILE"
  echo ""
  echo "Kör SQL:en manuellt:"
  echo "  1. Kopiera innehållet från filen ovan"
  echo "  2. Gå till Supabase Dashboard → SQL Editor"
  echo "  3. Klistra in och kör SQL:en"
  echo ""
  echo "Eller via CLI:"
  PROJECT_REF=$(echo "$PROJECT_URL" | sed -E 's|https://([^.]+)\.supabase\.co.*|\1|')
  echo "  supabase db execute --file $SQL_FILE --project-ref $PROJECT_REF"
fi

