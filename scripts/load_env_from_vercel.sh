#!/bin/bash

# Script to load environment variables from Vercel
# Usage: source scripts/load_env_from_vercel.sh

echo "🔍 Attempting to load environment variables from Vercel..."

if ! command -v vercel >/dev/null 2>&1; then
    echo "❌ Vercel CLI not found. Install it with: npm i -g vercel"
    exit 1
fi

# Check if linked to a project
if ! vercel project ls &>/dev/null; then
    echo "⚠️  Not linked to a Vercel project. Linking..."
    vercel link
fi

# Pull environment variables from Vercel production
echo "📥 Pulling environment variables from Vercel Production..."
vercel env pull .env.local --environment=production --yes

if [ -f .env.local ]; then
    echo "✅ Successfully created .env.local from Vercel"
    echo "💡 To use these variables, run: export \$(grep -v '^#' .env.local | xargs)"
    echo ""
    echo "Or source them directly:"
    echo "  source .env.local"
else
    echo "❌ Failed to pull environment variables from Vercel"
    exit 1
fi


