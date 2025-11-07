#!/usr/bin/env bash
# Usage: bash scripts/sb-switch.sh [dev|prod]
# Dynamically configures Supabase CLI to point at the desired project ref

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="$PROJECT_DIR/.supabase"
CONFIG_FILE="$CONFIG_DIR/config.toml"

DEV_REF="etzemjsrczxnkaykijzl"
PROD_REF="punicovacaktaszqcckp"

function ensure_config_dir() {
  mkdir -p "$CONFIG_DIR"
}

function write_config() {
  local ref=$1
  cat >"$CONFIG_FILE" <<EOF
project_id = "$ref"
EOF
}

function export_env() {
  local ref=$1
  if [[ "$ref" == "$DEV_REF" ]]; then
    export SUPABASE_PROJECT_REF="$DEV_REF"
    echo "Switched Supabase CLI to DEV ($DEV_REF)"
  else
    export SUPABASE_PROJECT_REF="$PROD_REF"
    echo "Switched Supabase CLI to PROD ($PROD_REF)"
  fi
}

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 [dev|prod]"
  exit 1
fi

case "$1" in
  dev)
    ensure_config_dir
    write_config "$DEV_REF"
    export_env "$DEV_REF"
    ;;
  prod)
    ensure_config_dir
    write_config "$PROD_REF"
    export_env "$PROD_REF"
    ;;
  *)
    echo "Unknown environment: $1 (use dev or prod)"
    exit 1
    ;;
  esac
