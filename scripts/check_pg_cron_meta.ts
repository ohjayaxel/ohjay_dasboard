#!/usr/bin/env -S tsx

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function check() {
  console.log('=== pg_cron Meta Sync Status ===\n');

  // Check if pg_cron job exists
  const { data: cronJob, error: cronError } = await supabase.rpc('exec_sql', {
    sql: `
      SELECT 
        jobid,
        jobname,
        schedule,
        active,
        nodename,
        nodeport,
        database,
        username,
        command
      FROM cron.job 
      WHERE jobname = 'meta-sync-hourly';
    `,
  }).then(result => {
    // RPC might not exist, try direct query if it fails
    if (result.error) {
      console.log('⚠️  Cannot query cron.job directly (RPC may not be available)');
      console.log('   Please run this SQL in Supabase SQL Editor:');
      console.log('   SELECT * FROM cron.job WHERE jobname = \'meta-sync-hourly\';\n');
      return { data: null, error: result.error };
    }
    return result;
  }).catch(() => {
    // If exec_sql doesn't exist, provide instructions
    return { data: null, error: null };
  });

  if (!cronError && cronJob) {
    console.log('pg_cron job found:');
    console.log(JSON.stringify(cronJob, null, 2));
  }

  // Check recent cron job runs
  console.log('\n=== Recent Meta Sync Jobs (from jobs_log) ===');
  const { data: jobs } = await supabase
    .from('jobs_log')
    .select('*')
    .eq('source', 'meta')
    .order('started_at', { ascending: false })
    .limit(20);

  if (jobs && jobs.length > 0) {
    // Group by hour to see pattern
    const byHour = new Map<string, number>();
    jobs.forEach(job => {
      const hour = new Date(job.started_at).toISOString().slice(0, 13); // YYYY-MM-DDTHH
      byHour.set(hour, (byHour.get(hour) || 0) + 1);
    });

    console.log('\nSync attempts per hour (last 20 jobs):');
    Array.from(byHour.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 10)
      .forEach(([hour, count]) => {
        console.log(`  ${hour}:00 - ${count} job(s)`);
      });

    console.log('\nStatus breakdown:');
    const statusCount = new Map<string, number>();
    jobs.forEach(job => {
      statusCount.set(job.status, (statusCount.get(job.status) || 0) + 1);
    });
    statusCount.forEach((count, status) => {
      console.log(`  ${status}: ${count}`);
    });

    // Check for hourly pattern (jobs starting at :05 minutes)
    const atHourly = jobs.filter(job => {
      const minutes = new Date(job.started_at).getMinutes();
      return minutes >= 5 && minutes <= 10; // Allow some variance
    });

    if (atHourly.length > 0) {
      console.log(`\n✅ Found ${atHourly.length} jobs starting around :05 minutes (hourly pattern detected)`);
    } else {
      console.log(`\n⚠️  No clear hourly pattern detected in job start times`);
    }
  }

  console.log('\n=== Recommendations ===');
  console.log('To verify pg_cron is active, run in Supabase SQL Editor:');
  console.log('  SELECT * FROM cron.job WHERE jobname = \'meta-sync-hourly\';');
  console.log('  SELECT * FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = \'meta-sync-hourly\') ORDER BY start_time DESC LIMIT 10;');
}

check().catch(console.error);

