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

async function check() {
  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0';
  
  // We need to fetch from Shopify API directly to get created_at
  // For now, let's check if we have created_at in our database
  // Actually, we're storing processed_at which comes from order.processed_at
  
  // The issue is: Shopify Finance might use created_at (when order was created)
  // while we're using processed_at (when order was completed/paid)
  
  console.log('⚠️  To properly analyze, we need to compare created_at vs processed_at');
  console.log('    from Shopify API directly. This would show if there are orders');
  console.log('    created on Nov 17 but processed on a different date.\n');
  
  console.log('Current analysis shows:');
  console.log('- Web orders: Clear cutoff at 479.20 kr');
  console.log('- Subscription orders: 6 excluded orders have same value as smallest included');
  console.log('\nNext steps:');
  console.log('1. Fetch orders directly from Shopify API to get created_at');
  console.log('2. Compare created_at vs processed_at for excluded subscription orders');
  console.log('3. Check if Shopify Finance uses created_at for date filtering\n');
}

check();

