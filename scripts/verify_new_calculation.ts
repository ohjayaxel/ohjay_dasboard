/**
 * Quick verification script to check order 7064943231319
 */

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrderGraphQL } from '../lib/integrations/shopify-graphql';
import { processOrder } from './research_shopify_data';

// Load environment
const envPath = require('path').resolve(process.cwd(), 'env', 'local.prod.sh');
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
} catch (e) {}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const tenantSlug = 'skinome';
  const orderId = '7064943231319';
  
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', tenantSlug)
    .maybeSingle();
  
  const { data: connection } = await supabase
    .from('connections')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('source', 'shopify')
    .maybeSingle();
  
  const shopDomain = connection.meta?.store_domain || connection.meta?.shop;
  
  const order = await fetchShopifyOrderGraphQL({
    tenantId: tenant.id,
    shopDomain,
    orderId: `gid://shopify/Order/${orderId}`,
  });
  
  if (!order) {
    console.error('Order not found');
    return;
  }
  
  const orderData = processOrder(order);
  
  if (!orderData) {
    console.error('Order processing failed');
    return;
  }
  
  console.log('Order:', orderData.orderName);
  console.log('');
  console.log('NEW CALCULATION:');
  console.log(`  subtotalPriceSet: ${order.subtotalPriceSet?.shopMoney.amount || 'N/A'}`);
  console.log(`  totalTaxSet: ${order.totalTaxSet?.shopMoney.amount || 'N/A'}`);
  console.log(`  Net Sales (EXCL tax, BEFORE refunds): ${(parseFloat(order.subtotalPriceSet?.shopMoney.amount || '0') - parseFloat(order.totalTaxSet?.shopMoney.amount || '0')).toFixed(2)} SEK`);
  console.log(`  Total Returns (EXCL tax): ${orderData.totalReturns.toFixed(2)} SEK`);
  console.log(`  Net Sales (EXCL tax, AFTER refunds): ${orderData.totalNetSales.toFixed(2)} SEK`);
  console.log('');
  console.log('EXPECTED (from Shopify Analytics):');
  console.log(`  Net Sales (EXCL tax): 1296.65 SEK`);
  console.log('');
  console.log('DIFFERENCE:', (orderData.totalNetSales - 1296.65).toFixed(2), 'SEK');
}

main().catch(console.error);


