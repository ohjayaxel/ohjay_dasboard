/**
 * Check why shopify_orders have net_sales = 0 for 2025-12-10
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
  const date = '2025-12-10';

  console.log(`\n=== Checking Orders with net_sales = 0 ===\n`);
  console.log(`Date: ${date}\n`);

  const supabase = getSupabaseServiceClient();

  // Check orders for today
  const { data: orders, error } = await supabase
    .from('shopify_orders')
    .select('order_id, processed_at, created_at, total_price, gross_sales, net_sales, discount_total, total_refunds, financial_status, is_refund')
    .eq('tenant_id', tenantId)
    .or(`processed_at.eq.${date},created_at.eq.${date}`)
    .limit(10);

  if (error) {
    console.error('❌ Error:', error.message);
    return;
  }

  console.log(`Found ${orders?.length ?? 0} orders\n`);

  if (orders && orders.length > 0) {
    orders.forEach(order => {
      console.log(`Order ID: ${order.order_id}`);
      console.log(`  processed_at: ${order.processed_at}`);
      console.log(`  created_at: ${order.created_at}`);
      console.log(`  total_price: ${order.total_price}`);
      console.log(`  gross_sales: ${order.gross_sales}`);
      console.log(`  net_sales: ${order.net_sales}`);
      console.log(`  discount_total: ${order.discount_total}`);
      console.log(`  total_refunds: ${order.total_refunds}`);
      console.log(`  financial_status: ${order.financial_status}`);
      console.log(`  is_refund: ${order.is_refund}`);
      console.log('');
    });

    const withNetSales = orders.filter(o => o.net_sales && parseFloat(o.net_sales.toString()) > 0);
    const withZeroNetSales = orders.filter(o => !o.net_sales || parseFloat(o.net_sales.toString()) === 0);
    
    console.log(`Orders with net_sales > 0: ${withNetSales.length}`);
    console.log(`Orders with net_sales = 0: ${withZeroNetSales.length}`);
    
    if (withZeroNetSales.length > 0) {
      console.log(`\nPossible reasons for net_sales = 0:`);
      console.log(`- Orders may be test orders`);
      console.log(`- Orders may be cancelled`);
      console.log(`- Orders may have total_price = 0`);
      console.log(`- Orders may be excluded by filtering logic`);
    }
  }

  console.log('\n=== Check Complete ===\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

