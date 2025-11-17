#!/usr/bin/env bash

set -euo pipefail

# Script för att sätta upp Meta-automation: deploya edge function och skapa scheduled function

if ! command -v supabase >/dev/null 2>&1; then
  echo "❌ Supabase CLI saknas. Installera via https://supabase.com/docs/guides/cli." >&2
  exit 1
fi

# Hämta project ref från .env.local eller fråga användaren
PROJECT_REF="${SUPABASE_PROJECT_REF:-}"

if [ -z "$PROJECT_REF" ]; then
  # Försök hämta från .env.local
  if [ -f .env.local ]; then
    PROJECT_REF=$(grep -E "^NEXT_PUBLIC_SUPABASE_URL=" .env.local | sed -E 's|.*https://([^.]+)\.supabase\.co.*|\1|' || echo "")
  fi
fi

if [ -z "$PROJECT_REF" ]; then
  echo -n "Ange Supabase project ref (t.ex. etzemjsrczxnkaykijzl): "
  read -r PROJECT_REF
fi

if [ -z "$PROJECT_REF" ]; then
  echo "❌ Project ref krävs." >&2
  exit 1
fi

# Kontrollera SUPABASE_ACCESS_TOKEN
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "⚠️  SUPABASE_ACCESS_TOKEN är inte satt." >&2
  echo "   Du behöver hämta den från: https://supabase.com/dashboard/account/tokens" >&2
  echo "" >&2
  echo -n "Ange SUPABASE_ACCESS_TOKEN nu (eller tryck Enter för att avbryta): "
  read -r TOKEN
  if [ -z "$TOKEN" ]; then
    echo "❌ Avbrutet. Sätt SUPABASE_ACCESS_TOKEN och kör igen." >&2
    exit 1
  fi
  export SUPABASE_ACCESS_TOKEN="$TOKEN"
fi

echo "📦 Steg 1/2: Deployar sync-meta edge function..."
echo "   Project ref: $PROJECT_REF"
echo ""

# Kontrollera att ENCRYPTION_KEY är satt i Supabase secrets
echo "⚠️  Viktigt: Kontrollera att följande secrets är satta i Supabase:"
echo "   - ENCRYPTION_KEY (32 byte key för att dekryptera access tokens)"
echo "   - META_API_VERSION (valfri, default är 'v18.0')"
echo ""
echo "   Sätt secrets via:"
echo "   supabase secrets set ENCRYPTION_KEY=<value> --project-ref $PROJECT_REF"
echo ""

supabase functions deploy sync-meta --project-ref "$PROJECT_REF" || {
  echo "❌ Deploy av sync-meta misslyckades." >&2
  exit 1
}

echo ""
echo "✅ Edge function deployad!"
echo ""
echo "📅 Nästa steg: Schemalägg jobbet via pg_cron"
echo ""
echo "Kör automatiskt SQL-setup (rekommenderat):"
echo "  bash scripts/setup_meta_schedule_sql.sh"
echo ""
echo "Detta script:"
echo "  - Läser värden från env/local.prod.sh eller .env.local"
echo "  - Genererar och kör SQL automatiskt i Supabase"
echo "  - Skapar cron-jobbet 'meta-sync-hourly'"
echo ""
echo "Alternativ: Kör SQL-filen manuellt (se docs/meta_automation.md)"
echo ""

