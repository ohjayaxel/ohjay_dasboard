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

missing=0

get_var() {
  local file=$1
  local key=$2
  local line
  line=$(grep -E "^${key}=" "$file" || true)
  if [[ -z "$line" ]]; then
    echo ""
    return
  fi
  echo "${line#${key}=}" | sed 's/[[:space:]]*$//' | sed 's/^"\|"$//g'
}

for var in "${REQUIRED_VARS[@]}"; do
  value=$(get_var "$TARGET_FILE" "$var")
  if [[ -z "$value" ]]; then
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
