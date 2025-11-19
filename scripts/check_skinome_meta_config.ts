#!/usr/bin/env -S tsx

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function check() {
  const skinomeTenantId = '642af254-0c2c-4274-86ca-507398ecf9a0';

  console.log('=== Skinome Meta Connection Configuration ===\n');

  const { data: connection, error } = await supabase
    .from('connections')
    .select('*')
    .eq('tenant_id', skinomeTenantId)
    .eq('source', 'meta')
    .single();

  if (error) {
    console.error('Error fetching connection:', error);
    return;
  }

  if (!connection) {
    console.log('No Meta connection found for Skinome');
    return;
  }

  console.log(`Status: ${connection.status}`);
  console.log(`Updated: ${connection.updated_at}\n`);

  const meta = connection.meta as Record<string, unknown> | null;
  if (meta) {
    console.log('Meta configuration:');
    console.log(`  sync_start_date: ${meta.sync_start_date || 'not set'}`);
    console.log(`  selected_account_id: ${meta.selected_account_id || 'not set'}`);
    console.log(`  last_synced_at: ${meta.last_synced_at || 'never'}`);
    console.log(`  last_synced_range: ${JSON.stringify(meta.last_synced_range || 'none')}`);
    console.log(`  last_synced_account_id: ${meta.last_synced_account_id || 'not set'}\n`);
  }

  // Check recent jobs for this tenant
  const { data: jobs } = await supabase
    .from('jobs_log')
    .select('*')
    .eq('tenant_id', skinomeTenantId)
    .eq('source', 'meta')
    .order('started_at', { ascending: false })
    .limit(5);

  if (jobs && jobs.length > 0) {
    console.log('Recent sync jobs for Skinome:');
    jobs.forEach((job, idx) => {
      console.log(`\nJob ${idx + 1}:`);
      console.log(`  Status: ${job.status}`);
      console.log(`  Started: ${job.started_at}`);
      console.log(`  Finished: ${job.finished_at || 'N/A'}`);
      if (job.error) {
        console.log(`  Error: ${job.error}`);
      }
    });
  }

  // Check latest Meta data date
  const { data: latestInsights } = await supabase
    .from('meta_insights_daily')
    .select('date')
    .eq('tenant_id', skinomeTenantId)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: latestKpi } = await supabase
    .from('kpi_daily')
    .select('date, spend, conversions, revenue')
    .eq('tenant_id', skinomeTenantId)
    .eq('source', 'meta')
    .order('date', { ascending: false })
    .limit(10);

  console.log(`\n=== Latest Meta Insights Data ===`);
  if (latestInsights?.date) {
    const latestDate = new Date(latestInsights.date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysDiff = Math.floor((today.getTime() - latestDate.getTime()) / (1000 * 60 * 60 * 24));
    
    console.log(`Latest date: ${latestInsights.date}`);
    console.log(`Days behind: ${daysDiff}`);
  } else {
    console.log('No insights data found');
  }

  console.log(`\n=== Latest Meta KPI Data (last 10 days) ===`);
  if (latestKpi && latestKpi.length > 0) {
    latestKpi.forEach((row, idx) => {
      console.log(`${idx + 1}. ${row.date} - spend: ${row.spend || 0}, conversions: ${row.conversions || 0}`);
    });
    
    const today = new Date().toISOString().split('T')[0];
    const hasToday = latestKpi.some(row => row.date === today);
    console.log(`\nHas KPI data for today (${today}): ${hasToday ? 'YES ✅' : 'NO ❌'}`);
  } else {
    console.log('No KPI data found');
  }
}

check().catch(console.error);

