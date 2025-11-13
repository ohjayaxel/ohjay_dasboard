#!/usr/bin/env bash

set -euo pipefail

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI saknas. Installera via https://supabase.com/docs/guides/cli." >&2
  exit 1
fi

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "Sätt SUPABASE_ACCESS_TOKEN (se https://supabase.com/dashboard/account/tokens) innan du kör scriptet." >&2
  exit 1
fi

PROJECT_REF="${SUPABASE_PROJECT_REF:-}"
if [ -z "$PROJECT_REF" ]; then
  echo -n "Ange Supabase project ref (t.ex. punicovacaktaszqcckp): "
  read -r PROJECT_REF
fi

if [ -z "$PROJECT_REF" ]; then
  echo "Project ref krävs." >&2
  exit 1
fi

CRON="${META_SYNC_CRON:-5 * * * *}"

echo "Skapar/uppdaterar schemalagd körning 'meta-sync-hourly' på projekt $PROJECT_REF med cron \"$CRON\"..."

supabase functions schedule upsert meta-sync-hourly \
  --project-ref "$PROJECT_REF" \
  --cron "$CRON" \
  --body '{"mode":"incremental"}' \
  sync-meta

echo "Klart! Kontrollera i Supabase Dashboard → Edge Functions → Schedules att cron-jobbet är aktivt."


