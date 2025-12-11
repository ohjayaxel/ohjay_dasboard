#!/bin/bash

# Setup Edge Function Secrets Script
# This script helps set up all required secrets for Edge Functions in Supabase

set -e

PROJECT_REF="punicovacaktaszqcckp"

echo "🔐 Edge Function Secrets Setup"
echo "════════════════════════════════════════════════════════════"
echo ""

# Check if supabase CLI is installed
if ! command -v supabase &> /dev/null; then
    echo "❌ Supabase CLI is not installed. Please install it first:"
    echo "   https://supabase.com/docs/guides/cli/getting-started"
    exit 1
fi

echo "📋 This script will help you set secrets for Edge Functions."
echo ""
echo "Required secrets:"
echo "  ✅ ENCRYPTION_KEY (should already be set)"
echo "  ✅ SUPABASE_URL (automatically set)"
echo "  ✅ SUPABASE_SERVICE_ROLE_KEY (automatically set)"
echo ""
echo "Google Ads secrets:"
echo "  ⚠️  GOOGLE_CLIENT_ID"
echo "  ⚠️  GOOGLE_CLIENT_SECRET"
echo "  ⚠️  GOOGLE_DEVELOPER_TOKEN"
echo ""
echo "Meta secrets:"
echo "  ⚠️  META_APP_ID"
echo "  ⚠️  META_APP_SECRET"
echo "  ⚠️  META_API_VERSION (optional, defaults to v18.0)"
echo ""
echo "Shopify secrets:"
echo "  ✅ None required (tokens are permanent)"
echo ""

# Function to set secret with confirmation
set_secret() {
    local secret_name=$1
    local description=$2
    local optional=${3:-false}
    
    echo ""
    if [ "$optional" = "true" ]; then
        echo "Optional: $description"
        read -p "Set $secret_name? (y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "⏭️  Skipping $secret_name"
            return
        fi
    else
        echo "Required: $description"
    fi
    
    read -sp "Enter $secret_name: " secret_value
    echo
    
    if [ -z "$secret_value" ]; then
        echo "❌ Empty value, skipping..."
        return
    fi
    
    echo "Setting $secret_name..."
    supabase secrets set "$secret_name=$secret_value" --project-ref "$PROJECT_REF"
    
    if [ $? -eq 0 ]; then
        echo "✅ $secret_name set successfully"
    else
        echo "❌ Failed to set $secret_name"
    fi
}

# Google Ads secrets
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📱 Google Ads Secrets"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
set_secret "GOOGLE_CLIENT_ID" "Google OAuth Client ID"
set_secret "GOOGLE_CLIENT_SECRET" "Google OAuth Client Secret"
set_secret "GOOGLE_DEVELOPER_TOKEN" "Google Ads Developer Token"

# Meta secrets
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📘 Meta/Facebook Secrets"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
set_secret "META_APP_ID" "Meta/Facebook App ID"
set_secret "META_APP_SECRET" "Meta/Facebook App Secret"
set_secret "META_API_VERSION" "Meta API version" "true"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Verification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Listing all secrets..."
supabase secrets list --project-ref "$PROJECT_REF"

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Deploy Edge Functions to apply secrets:"
echo "     supabase functions deploy sync-meta --project-ref $PROJECT_REF"
echo "     supabase functions deploy sync-googleads --project-ref $PROJECT_REF"
echo ""
echo "  2. Test token refresh by triggering a sync:"
echo "     pnpm tsx scripts/run_google_ads_sync_for_tenant.ts skinome"
echo ""
echo "  3. Verify in Supabase Dashboard → Edge Functions → Logs"

