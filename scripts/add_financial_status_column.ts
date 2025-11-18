#!/usr/bin/env -S tsx

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

async function addColumn() {
  const { error } = await supabase.rpc('exec_sql', {
    sql: 'ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS financial_status text;',
  });

  if (error) {
    // Try direct SQL execution
    const { data, error: directError } = await supabase
      .from('shopify_orders')
      .select('financial_status')
      .limit(1);

    if (directError && directError.message.includes('column') && directError.message.includes('financial_status')) {
      console.log('Column does not exist, but cannot add it via Supabase client.');
      console.log('Please run this SQL manually:');
      console.log('ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS financial_status text;');
      process.exit(1);
    } else {
      console.log('Column already exists or table structure is correct.');
    }
  } else {
    console.log('✅ Added financial_status column to shopify_orders table');
  }
}

addColumn();

