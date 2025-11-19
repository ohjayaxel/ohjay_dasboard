#!/usr/bin/env -S tsx

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function check() {
  console.log('=== Meta Sync Status Check ===\n');

  // 1. Check if Meta connection exists
  const { data: connections, error: connError } = await supabase
    .from('connections')
    .select('tenant_id, status, updated_at, meta')
    .eq('source', 'meta');

  if (connError) {
    console.error('Error fetching connections:', connError);
    return;
  }

  console.log(`Total Meta connections: ${connections?.length || 0}`);
  if (connections && connections.length > 0) {
    connections.forEach((conn) => {
      console.log(`  - Tenant: ${conn.tenant_id}`);
      console.log(`    Status: ${conn.status}`);
      console.log(`    Updated: ${conn.updated_at}`);
      const meta = conn.meta as Record<string, unknown> | null;
      if (meta) {
        console.log(`    Last synced: ${meta.last_synced_at || 'never'}`);
        console.log(`    Sync range: ${JSON.stringify(meta.last_synced_range || 'none')}`);
      }
      console.log('');
    });
  }

  // 2. Check jobs_log for recent Meta sync attempts
  const { data: jobs, error: jobsError } = await supabase
    .from('jobs_log')
    .select('*')
    .eq('source', 'meta')
    .order('started_at', { ascending: false })
    .limit(10);

  if (jobsError) {
    console.error('Error fetching jobs_log:', jobsError);
  } else {
    console.log('=== Recent Meta Sync Jobs (last 10) ===\n');
    if (!jobs || jobs.length === 0) {
      console.log('No sync jobs found in jobs_log\n');
    } else {
      jobs.forEach((job, idx) => {
        console.log(`Job ${idx + 1}:`);
        console.log(`  Tenant: ${job.tenant_id}`);
        console.log(`  Status: ${job.status}`);
        console.log(`  Started: ${job.started_at}`);
        console.log(`  Finished: ${job.finished_at || 'N/A'}`);
        if (job.error) {
          console.log(`  Error: ${job.error}`);
        }
        console.log('');
      });
    }
  }

  // 3. Check latest Meta data date
  const { data: latestData, error: dataError } = await supabase
    .from('meta_insights_daily')
    .select('date')
    .order('date', { ascending: false })
    .limit(1)
    .single();

  if (dataError) {
    console.error('Error fetching latest Meta data:', dataError);
  } else {
    console.log('=== Latest Meta Data ===');
    console.log(`Latest date: ${latestData?.date || 'No data found'}`);
    
    if (latestData?.date) {
      const latestDate = new Date(latestData.date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const daysDiff = Math.floor((today.getTime() - latestDate.getTime()) / (1000 * 60 * 60 * 24));
      console.log(`Days behind: ${daysDiff}`);
    }
    console.log('');
  }

  // 4. Check pg_cron jobs (if accessible)
  console.log('=== pg_cron Status ===');
  console.log('To check pg_cron jobs, run this SQL in Supabase SQL Editor:');
  console.log('  SELECT * FROM cron.job WHERE jobname = \'meta-sync-hourly\';');
  console.log('  SELECT * FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = \'meta-sync-hourly\') ORDER BY start_time DESC LIMIT 10;');
  console.log('');
  
  console.log('=== Recommendations ===');
  if (!jobs || jobs.length === 0) {
    console.log('⚠️  No sync jobs found. Meta sync may not be running automatically.');
    console.log('   - Check if pg_cron is configured (see SQL above)');
    console.log('   - Or run: curl -X GET "https://your-domain.com/api/jobs/sync?source=meta"');
  } else {
    const lastJob = jobs[0];
    const lastJobDate = new Date(lastJob.started_at);
    const now = new Date();
    const hoursSinceLastJob = (now.getTime() - lastJobDate.getTime()) / (1000 * 60 * 60);
    
    if (hoursSinceLastJob > 2) {
      console.log(`⚠️  Last sync was ${hoursSinceLastJob.toFixed(1)} hours ago.`);
      console.log('   - Meta sync may not be running automatically');
      console.log('   - Check pg_cron configuration');
    } else {
      console.log(`✅ Last sync was ${hoursSinceLastJob.toFixed(1)} hours ago.`);
    }
    
    if (lastJob.status === 'failed') {
      console.log('❌ Last sync job failed. Check error message above.');
    } else if (lastJob.status === 'running') {
      console.log('⚠️  Last sync job is still running. This may indicate a timeout or hang.');
    } else if (lastJob.status === 'succeeded') {
      console.log('✅ Last sync job succeeded.');
    }
  }
}

check().catch(console.error);

