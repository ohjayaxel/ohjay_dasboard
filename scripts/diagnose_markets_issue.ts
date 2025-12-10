/**
 * Diagnostic Script: Check why Markets returns no data
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
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const from = thirtyDaysAgo.toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);

  console.log(`\n=== Markets Issue Diagnosis ===\n`);
  console.log(`Date Range: ${from} → ${to}\n`);

  const supabase = getSupabaseServiceClient();

  // Check shopify_sales_transactions
  console.log('--- Check shopify_sales_transactions ---');
  const { data: transactions, error: txnError } = await supabase
    .from('shopify_sales_transactions')
    .select('event_date, shopify_order_id, event_type')
    .eq('tenant_id', tenantId)
    .gte('event_date', from)
    .lte('event_date', to)
    .limit(10);

  if (txnError) {
    console.error('❌ Error:', txnError.message);
  } else {
    console.log(`✅ Transactions found: ${transactions?.length ?? 0}`);
    if (transactions && transactions.length > 0) {
      const orderIds = new Set(transactions.map(t => t.shopify_order_id).filter(Boolean));
      console.log(`   Unique order IDs in sample: ${orderIds.size}`);
      console.log(`   Sample order IDs: ${Array.from(orderIds).slice(0, 3).join(', ')}`);
      
      // Check if these orders have country data
      if (orderIds.size > 0) {
        const orderIdArray = Array.from(orderIds).slice(0, 10);
        const { data: orders, error: ordersError } = await supabase
          .from('shopify_orders')
          .select('order_id, country, is_new_customer')
          .eq('tenant_id', tenantId)
          .in('order_id', orderIdArray);

        if (ordersError) {
          console.error('❌ Error fetching orders:', ordersError.message);
        } else {
          console.log(`   Orders found in shopify_orders: ${orders?.length ?? 0}`);
          if (orders && orders.length > 0) {
            const withCountry = orders.filter(o => o.country);
            const withoutCountry = orders.filter(o => !o.country);
            console.log(`     Orders WITH country: ${withCountry.length}`);
            console.log(`     Orders WITHOUT country: ${withoutCountry.length}`);
            if (withCountry.length > 0) {
              console.log(`     Sample countries: ${withCountry.slice(0, 3).map(o => o.country).join(', ')}`);
            }
          }
        }
      }
    }
  }

  // Check if shopify_daily_sales has country-level data we could use instead
  console.log('\n--- Check shopify_daily_sales ---');
  const { data: dailySales, error: dailySalesError } = await supabase
    .from('shopify_daily_sales')
    .select('date, net_sales_excl_tax, orders_count')
    .eq('tenant_id', tenantId)
    .eq('mode', 'shopify')
    .gte('date', from)
    .lte('date', to)
    .limit(10);

  if (dailySalesError) {
    console.error('❌ Error:', dailySalesError.message);
  } else {
    console.log(`✅ shopify_daily_sales rows: ${dailySales?.length ?? 0}`);
  }

  console.log('\n=== Diagnosis Complete ===\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

