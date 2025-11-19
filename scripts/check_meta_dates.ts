#!/usr/bin/env -S tsx

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function check() {
  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0';

  const { data } = await supabase
    .from('meta_insights_daily')
    .select('date')
    .eq('tenant_id', tenantId)
    .order('date', { ascending: false })
    .limit(15);

  if (data) {
    console.log('Latest 15 Meta data dates:');
    data.forEach((row, idx) => {
      console.log(`${idx + 1}. ${row.date}`);
    });
    
    const today = new Date().toISOString().split('T')[0];
    const hasToday = data.some(row => row.date === today);
    console.log(`\nHas data for today (${today}): ${hasToday ? 'YES' : 'NO'}`);
  }
}

check().catch(console.error);

