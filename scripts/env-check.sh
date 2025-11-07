#!/usr/bin/env bash
# Usage: bash scripts/env-check.sh <example-file> <actual-env-file>
# Validates that critical environment variables are present and non-empty.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <example-file> [actual-env-file]"
  exit 1
fi

EXAMPLE_FILE=$1
TARGET_FILE=${2:-$1}

if [[ ! -f "$EXAMPLE_FILE" ]]; then
  echo "✖ Example env file not found: $EXAMPLE_FILE"
  exit 1
fi

if [[ ! -f "$TARGET_FILE" ]]; then
  echo "✖ Target env file not found: $TARGET_FILE"
  echo "  Copy $EXAMPLE_FILE and fill in required values."
  exit 1
fi

REQUIRED_VARS=(
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY
  APP_BASE_URL
  ENCRYPTION_KEY
)

declare -A VALUES

load_file() {
  local file=$1
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    key="$(echo "$key" | xargs)"
    value="${value%%#*}"
    value="$(echo "${value}" | xargs)"
    VALUES["$key"]="$value"
  done <"$file"
}

load_file "$TARGET_FILE"

missing=0
for var in "${REQUIRED_VARS[@]}"; do
  val="${VALUES[$var]:-}"
  if [[ -z "$val" ]]; then
    echo "✖ $var is missing or empty in $TARGET_FILE"
    missing=1
  else
    echo "✓ $var is set"
  fi
 done

if [[ $missing -ne 0 ]]; then
  echo "Environment check failed."
  exit 1
fi

echo "Environment check passed."
