#!/usr/bin/env -S tsx

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function verify() {
  console.log('=== Verifierar Meta Cron Jobs ===\n');

  // Check cron jobs via RPC (if available) or direct query instructions
  console.log('För att verifiera att cron-jobb är skapade, kör detta SQL i Supabase SQL Editor:');
  console.log('');
  console.log('SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname LIKE \'meta-%\';');
  console.log('');
  console.log('Du bör se två jobb:');
  console.log('  1. meta-sync-hourly (schedule: "5 * * * *")');
  console.log('  2. meta-kpi-aggregate-hourly (schedule: "10 * * * *")');
  console.log('');
  console.log('=== Alternativ: Kontrollera senaste jobb-körningar ===');
  console.log('');
  console.log('SELECT * FROM jobs_log WHERE source = \'meta\' ORDER BY started_at DESC LIMIT 10;');
  console.log('');
}

verify().catch(console.error);

