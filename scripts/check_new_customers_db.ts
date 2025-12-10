import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { resolve } from 'path';

// Load environment variables
const envPath = resolve(process.cwd(), 'env', 'local.prod.sh');
try {
  const envFile = require('fs').readFileSync(envPath, 'utf-8');
  envFile.split('\n').forEach((line: string) => {
    if (line && !line.startsWith('#') && line.includes('=')) {
      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=').replace(/^["']|["']$/g, '').trim();
      if (key && value) {
        process.env[key.trim()] = value;
      }
    }
  });
} catch (e) {
  console.warn('Could not load env file');
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  const { data: tenant } = await supabase.from('tenants').select('id, name').eq('slug', 'skinome').maybeSingle();
  
  if (!tenant) {
    console.error('Tenant not found');
    return;
  }
  
  console.log(`\n=== KONTROLLERAR DATABASEN FÖR ${tenant.name} ===\n`);
  
  // Kolla totala ordrar för 2025-11-30
  const { count: total, error: totalError } = await supabase
    .from('shopify_orders')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenant.id)
    .eq('created_at', '2025-11-30');
  
  if (totalError) {
    console.error('Error counting orders:', totalError);
    return;
  }
  
  console.log(`📊 Totalt antal ordrar (created_at = 2025-11-30): ${total}`);
  
  // Kolla med customer_id
  const { count: withCustomer, error: withCustomerError } = await supabase
    .from('shopify_orders')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenant.id)
    .eq('created_at', '2025-11-30')
    .not('customer_id', 'is', null);
  
  console.log(`📊 Ordrar med customer_id: ${withCustomer || 0}`);
  
  // Kolla nya kunder
  const { count: newCustomers, error: newError } = await supabase
    .from('shopify_orders')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenant.id)
    .eq('created_at', '2025-11-30')
    .eq('is_new_customer', true);
  
  console.log(`📊 Nya kunder (is_new_customer = true): ${newCustomers || 0}`);
  
  // Kolla återkommande kunder
  const { count: returningCustomers, error: returnError } = await supabase
    .from('shopify_orders')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenant.id)
    .eq('created_at', '2025-11-30')
    .eq('is_new_customer', false);
  
  console.log(`📊 Återkommande kunder (is_new_customer = false): ${returningCustomers || 0}`);
  
  // Kolla NULL is_new_customer
  const { count: nullNewCustomer, error: nullError } = await supabase
    .from('shopify_orders')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenant.id)
    .eq('created_at', '2025-11-30')
    .is('is_new_customer', null);
  
  console.log(`📊 NULL is_new_customer: ${nullNewCustomer || 0}`);
  
  // Sammanställning av totals
  const { data: totals, error: totalsError } = await supabase
    .from('shopify_orders')
    .select('is_new_customer, gross_sales, net_sales')
    .eq('tenant_id', tenant.id)
    .eq('created_at', '2025-11-30');
  
  if (totalsError) {
    console.error('Error fetching totals:', totalsError);
    return;
  }
  
  let newCustomerGross = 0;
  let newCustomerNet = 0;
  let newCustomerCount = 0;
  let returningCustomerGross = 0;
  let returningCustomerNet = 0;
  let returningCustomerCount = 0;
  
  totals?.forEach((order) => {
    if (order.is_new_customer === true) {
      newCustomerCount++;
      newCustomerGross += parseFloat(order.gross_sales || '0');
      newCustomerNet += parseFloat(order.net_sales || '0');
    } else {
      returningCustomerCount++;
      returningCustomerGross += parseFloat(order.gross_sales || '0');
      returningCustomerNet += parseFloat(order.net_sales || '0');
    }
  });
  
  console.log(`\n=== SAMMANSTÄLLNING ===\n`);
  console.log(`Nya kunder:`);
  console.log(`  Orders: ${newCustomerCount}`);
  console.log(`  Gross Sales: ${newCustomerGross.toFixed(2)} SEK`);
  console.log(`  Net Sales: ${newCustomerNet.toFixed(2)} SEK`);
  console.log(`\nÅterkommande kunder:`);
  console.log(`  Orders: ${returningCustomerCount}`);
  console.log(`  Gross Sales: ${returningCustomerGross.toFixed(2)} SEK`);
  console.log(`  Net Sales: ${returningCustomerNet.toFixed(2)} SEK`);
  console.log(`\n=== FÖRVÄNTAT (från användaren) ===`);
  console.log(`Nya kunder: 42 orders, 52,581.02 SEK brutto, 41,030.57 SEK netto`);
  console.log(`Återkommande kunder: 119 orders, 93,026.80 SEK brutto, 81,679.77 SEK netto`);
}

check().catch(console.error);
