/**
 * Diagnose Sync Issues for Skinome
 * 
 * Checks:
 * 1. shopify_orders vs shopify_daily_sales for 2025-12-10
 * 2. Google Ads connection status and encryption issues
 * 3. New customer classification data
 */

function loadEnvFile() {
  const fs = require('fs');
  const path = require('path');
  const envFiles = ['.env.local', 'env/local.prod.sh'];
  for (const envFile of envFiles) {
    const filePath = path.join(process.cwd(), envFile);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const match = trimmed.match(/^export\s+([^=]+)=(.*)$/) || trimmed.match(/^([^=]+)=(.*)$/);
          if (match) {
            const key = match[1].trim();
            const value = match[2].trim().replace(/^["']|["']$/g, '');
            if (!process.env[key]) process.env[key] = value;
          }
        }
      }
    }
  }
}

loadEnvFile();

async function main() {
  const { getSupabaseServiceClient } = await import('@/lib/supabase/server');

  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0';
  const date = '2025-12-10'; // Today
  const yesterday = '2025-12-09';

  console.log(`\n=== Sync Issues Diagnosis ===\n`);
  console.log(`Tenant ID: ${tenantId}`);
  console.log(`Checking date: ${date} (today) and ${yesterday} (yesterday)\n`);

  const supabase = getSupabaseServiceClient();

  // 1. Check shopify_orders for today
  console.log('--- 1. shopify_orders for 2025-12-10 ---');
  const { data: ordersToday, error: ordersError } = await supabase
    .from('shopify_orders')
    .select('order_id, processed_at, created_at, net_sales, is_new_customer, currency')
    .eq('tenant_id', tenantId)
    .or(`processed_at.eq.${date},created_at.eq.${date}`)
    .limit(20);

  if (ordersError) {
    console.error('❌ Error:', ordersError.message);
  } else {
    console.log(`✅ Orders found: ${ordersToday?.length ?? 0}`);
    if (ordersToday && ordersToday.length > 0) {
      const totalNetSales = ordersToday.reduce((sum, o) => sum + (parseFloat(o.net_sales?.toString() || '0') || 0), 0);
      const newCustomerOrders = ordersToday.filter(o => o.is_new_customer === true);
      const newCustomerNetSales = newCustomerOrders.reduce((sum, o) => sum + (parseFloat(o.net_sales?.toString() || '0') || 0), 0);
      
      console.log(`   Total net sales: ${totalNetSales.toFixed(2)}`);
      console.log(`   New customer orders: ${newCustomerOrders.length}`);
      console.log(`   New customer net sales: ${newCustomerNetSales.toFixed(2)}`);
      console.log(`   Sample order IDs: ${ordersToday.slice(0, 3).map(o => o.order_id).join(', ')}`);
    }
  }

  // 2. Check shopify_daily_sales for today
  console.log('\n--- 2. shopify_daily_sales for 2025-12-10 ---');
  const { data: dailySalesToday, error: dailySalesError } = await supabase
    .from('shopify_daily_sales')
    .select('date, net_sales_excl_tax, new_customer_net_sales, orders_count')
    .eq('tenant_id', tenantId)
    .eq('mode', 'shopify')
    .eq('date', date);

  if (dailySalesError) {
    console.error('❌ Error:', dailySalesError.message);
  } else {
    console.log(`✅ Daily sales rows: ${dailySalesToday?.length ?? 0}`);
    if (dailySalesToday && dailySalesToday.length > 0) {
      const row = dailySalesToday[0];
      console.log(`   net_sales_excl_tax: ${row.net_sales_excl_tax ?? 0}`);
      console.log(`   new_customer_net_sales: ${row.new_customer_net_sales ?? 0}`);
      console.log(`   orders_count: ${row.orders_count ?? 0}`);
    } else {
      console.log('   ⚠️  NO DATA for 2025-12-10 in shopify_daily_sales!');
      console.log('   This suggests webhooks did not trigger or aggregation failed.');
    }
  }

  // 3. Check yesterday's data
  console.log('\n--- 3. Yesterday (2025-12-09) Data ---');
  const { data: ordersYesterday } = await supabase
    .from('shopify_orders')
    .select('order_id, processed_at, net_sales, is_new_customer')
    .eq('tenant_id', tenantId)
    .or(`processed_at.eq.${yesterday},created_at.eq.${yesterday}`);

  const { data: dailySalesYesterday } = await supabase
    .from('shopify_daily_sales')
    .select('date, net_sales_excl_tax, new_customer_net_sales, orders_count')
    .eq('tenant_id', tenantId)
    .eq('mode', 'shopify')
    .eq('date', yesterday);

  console.log(`Orders yesterday: ${ordersYesterday?.length ?? 0}`);
  if (ordersYesterday && ordersYesterday.length > 0) {
    const newCustomerNetSales = ordersYesterday
      .filter(o => o.is_new_customer === true)
      .reduce((sum, o) => sum + (parseFloat(o.net_sales?.toString() || '0') || 0), 0);
    console.log(`   New customer net sales from orders: ${newCustomerNetSales.toFixed(2)}`);
  }

  if (dailySalesYesterday && dailySalesYesterday.length > 0) {
    const row = dailySalesYesterday[0];
    console.log(`Daily sales yesterday:`);
    console.log(`   net_sales_excl_tax: ${row.net_sales_excl_tax ?? 0}`);
    console.log(`   new_customer_net_sales: ${row.new_customer_net_sales ?? 0}`);
    console.log(`   orders_count: ${row.orders_count ?? 0}`);
  }

  // 4. Check Google Ads connection
  console.log('\n--- 4. Google Ads Connection Status ---');
  const { data: googleConnection, error: connError } = await supabase
    .from('connections')
    .select('id, status, access_token_enc, meta')
    .eq('tenant_id', tenantId)
    .eq('source', 'google_ads')
    .single();

  if (connError) {
    console.error('❌ Error:', connError.message);
  } else if (googleConnection) {
    console.log(`✅ Connection found:`);
    console.log(`   Status: ${googleConnection.status}`);
    console.log(`   Has access_token_enc: ${googleConnection.access_token_enc ? 'Yes' : 'No'}`);
    console.log(`   Meta: ${JSON.stringify(googleConnection.meta || {})}`);
    
    if (googleConnection.status === 'connected' && !googleConnection.access_token_enc) {
      console.log('   ⚠️  Connection is "connected" but has no access token!');
    }
  } else {
    console.log('   ⚠️  No Google Ads connection found!');
  }

  // 5. Check recent jobs_log for errors
  console.log('\n--- 5. Recent Sync Jobs ---');
  const { data: recentJobs } = await supabase
    .from('jobs_log')
    .select('source, status, started_at, finished_at, error')
    .eq('tenant_id', tenantId)
    .order('started_at', { ascending: false })
    .limit(10);

  if (recentJobs && recentJobs.length > 0) {
    console.log('Recent sync jobs:');
    recentJobs.forEach(job => {
      const started = new Date(job.started_at).toLocaleString('sv-SE');
      const status = job.status === 'succeeded' ? '✅' : job.status === 'failed' ? '❌' : '⏳';
      console.log(`   ${status} ${job.source} - ${started} - ${job.status}`);
      if (job.error) {
        console.log(`      Error: ${job.error.substring(0, 100)}`);
      }
    });
  }

  console.log('\n=== Diagnosis Complete ===\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

