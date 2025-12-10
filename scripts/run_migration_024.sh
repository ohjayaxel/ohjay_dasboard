#!/bin/bash
# Run migration 024 to add new_customer_net_sales column

echo "📋 Running migration 024: Add new_customer_net_sales to shopify_daily_sales"
echo ""

# Check if supabase CLI is available
if command -v supabase &> /dev/null; then
  echo "Using Supabase CLI..."
  supabase db push --db-url "$DATABASE_URL" packages/db/migrations/024_add_new_customer_net_sales_to_daily_sales.sql
else
  echo "⚠️  Supabase CLI not found. Please run the migration manually:"
  echo ""
  echo "Copy and paste this SQL into your Supabase SQL editor:"
  echo ""
  cat packages/db/migrations/024_add_new_customer_net_sales_to_daily_sales.sql
  echo ""
fi



