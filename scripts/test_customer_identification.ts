/**
 * Simple test script - Identifierar nya vs återkommande kunder för 30 november 2025
 */

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrdersGraphQL } from '@/lib/integrations/shopify-graphql';

// Load environment variables
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
} catch (e) {
  console.warn('Could not load env file, using existing environment variables');
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function toLocalDate(dateString: string, timezone: string = 'Europe/Stockholm'): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

function determineCustomerType(order: { customer?: { numberOfOrders?: string | null } | null }): 'NEW' | 'RETURNING' | 'GUEST' {
  if (order.customer?.numberOfOrders !== undefined && order.customer.numberOfOrders !== null) {
    const numOrders = parseInt(order.customer.numberOfOrders, 10);
    if (!isNaN(numOrders)) {
      return numOrders === 1 ? 'NEW' : 'RETURNING';
    }
  }
  return 'GUEST';
}

async function main() {
  const dateArg = '2025-11-30';
  const STORE_TIMEZONE = 'Europe/Stockholm';

  console.log('='.repeat(80));
  console.log('KUNDIDENTIFIERING FÖR 30 NOVEMBER 2025');
  console.log('='.repeat(80));
  console.log('');

  // Get tenant and connection
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, slug')
    .eq('slug', 'skinome')
    .maybeSingle();

  if (!tenant) {
    console.error('❌ Tenant not found');
    process.exit(1);
  }

  const { data: connection } = await supabase
    .from('connections')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('source', 'shopify')
    .maybeSingle();

  if (!connection) {
    console.error('❌ Connection not found');
    process.exit(1);
  }

  const shopDomain = connection.meta?.store_domain || connection.meta?.shop;

  // Fetch orders in wider range
  const startDateObj = new Date(dateArg + 'T00:00:00Z');
  const fetchStartDate = new Date(startDateObj);
  fetchStartDate.setDate(fetchStartDate.getDate() - 1);
  const fetchEndDate = new Date(startDateObj);
  fetchEndDate.setDate(fetchEndDate.getDate() + 2);

  const fetchStartDateStr = fetchStartDate.toISOString().slice(0, 10);
  const fetchEndDateStr = fetchEndDate.toISOString().slice(0, 10);

  console.log(`📥 Hämtar ordrar från ${fetchStartDateStr} till ${fetchEndDateStr}...\n`);

  const orders = await fetchShopifyOrdersGraphQL({
    tenantId: tenant.id,
    shopDomain,
    since: fetchStartDateStr,
    until: fetchEndDateStr,
    excludeTest: true,
  });

  console.log(`✅ Hämtade ${orders.length} ordrar totalt\n`);

  // Process orders and filter for target date
  const ordersForDate: Array<{
    orderName: string;
    customerType: 'NEW' | 'RETURNING' | 'GUEST';
    customerId: string | null;
    numberOfOrders: string | null;
  }> = [];

  for (const order of orders) {
    // Filter for successful transactions
    const successfulTransactions = (order.transactions || []).filter(
      (txn) =>
        (txn.kind === 'SALE' || txn.kind === 'CAPTURE') &&
        txn.status === 'SUCCESS' &&
        txn.processedAt,
    );

    if (successfulTransactions.length === 0) {
      continue;
    }

    // Use transaction.processedAt for event date
    const transactionTimestamp = successfulTransactions[0].processedAt!;
    const eventDate = toLocalDate(transactionTimestamp, STORE_TIMEZONE);

    if (eventDate === dateArg) {
      const customerType = determineCustomerType(order);
      ordersForDate.push({
        orderName: order.name,
        customerType,
        customerId: order.customer?.id || null,
        numberOfOrders: order.customer?.numberOfOrders || null,
      });
    }
  }

  console.log(`✅ Hittade ${ordersForDate.length} ordrar för ${dateArg}\n`);

  // Debug: Check customer data in ALL fetched orders
  console.log('='.repeat(80));
  console.log('DEBUG: CUSTOMER DATA CHECK I HÄMTADE ORDRAR');
  console.log('='.repeat(80));
  console.log('');
  
  let totalOrdersWithCustomerId = 0;
  let totalOrdersWithNumberOfOrders = 0;
  const sampleWithCustomer: Array<{ name: string; customerId: string; numberOfOrders: string; eventDate: string }> = [];
  
  for (const order of orders) {
    const successfulTransactions = (order.transactions || []).filter(
      (txn) =>
        (txn.kind === 'SALE' || txn.kind === 'CAPTURE') &&
        txn.status === 'SUCCESS' &&
        txn.processedAt,
    );

    if (successfulTransactions.length === 0) continue;

    const transactionTimestamp = successfulTransactions[0].processedAt!;
    const eventDate = toLocalDate(transactionTimestamp, STORE_TIMEZONE);

    if (order.customer?.id) {
      totalOrdersWithCustomerId++;
      if (order.customer?.numberOfOrders) {
        totalOrdersWithNumberOfOrders++;
        if (sampleWithCustomer.length < 5) {
          sampleWithCustomer.push({
            name: order.name,
            customerId: order.customer.id.substring(0, 30) + '...',
            numberOfOrders: order.customer.numberOfOrders,
            eventDate,
          });
        }
      }
    }
  }

  console.log(`Totalt hämtade ordrar: ${orders.length}`);
  console.log(`  - Ordrar med customer.id: ${totalOrdersWithCustomerId}`);
  console.log(`  - Ordrar med numberOfOrders: ${totalOrdersWithNumberOfOrders}`);
  console.log('');

  if (sampleWithCustomer.length > 0) {
    console.log('Exempel på ordrar med customer-data:');
    for (const sample of sampleWithCustomer) {
      console.log(`  - ${sample.name} (${sample.eventDate}): customerId=${sample.customerId}, numberOfOrders="${sample.numberOfOrders}"`);
    }
    console.log('');
  }

  console.log('='.repeat(80));
  console.log('');

  // Count by customer type
  let newCustomers = 0;
  let returningCustomers = 0;
  let guestCheckouts = 0;

  for (const order of ordersForDate) {
    if (order.customerType === 'NEW') {
      newCustomers++;
    } else if (order.customerType === 'RETURNING') {
      returningCustomers++;
    } else {
      guestCheckouts++;
    }
  }

  // Results
  console.log('='.repeat(80));
  console.log('RESULTAT');
  console.log('='.repeat(80));
  console.log('');
  console.log(`Total ordrar: ${ordersForDate.length}`);
  console.log('');
  console.log(`📊 Uppdelning:`);
  console.log(`  🆕 Nya kunder (NEW):     ${newCustomers} ordrar`);
  console.log(`  🔄 Återkommande (RETURNING): ${returningCustomers} ordrar`);
  console.log(`  👤 Gäster (GUEST):      ${guestCheckouts} ordrar`);
  console.log('');

  // Show examples
  if (newCustomers > 0) {
    console.log('Exempel på nya kunder:');
    let shown = 0;
    for (const order of ordersForDate) {
      if (order.customerType === 'NEW') {
        console.log(`  - ${order.orderName}: numberOfOrders="${order.numberOfOrders}"`);
        shown++;
        if (shown >= 5) break;
      }
    }
    console.log('');
  }

  if (returningCustomers > 0) {
    console.log('Exempel på återkommande kunder:');
    let shown = 0;
    for (const order of ordersForDate) {
      if (order.customerType === 'RETURNING') {
        console.log(`  - ${order.orderName}: numberOfOrders="${order.numberOfOrders}"`);
        shown++;
        if (shown >= 5) break;
      }
    }
    console.log('');
  }

  // Verification
  console.log('='.repeat(80));
  console.log('VERIFIERING');
  console.log('='.repeat(80));
  console.log('');

  const totalWithCustomerData = newCustomers + returningCustomers;
  
  if (totalWithCustomerData > 0) {
    console.log(`✅ SUCCESS: Kan identifiera ${totalWithCustomerData} ordrar med kunddata`);
    console.log(`   ${newCustomers} nya kunder och ${returningCustomers} återkommande kunder`);
  } else {
    console.log(`⚠️  INFO: Alla ${ordersForDate.length} ordrar är gästcheckouts`);
    console.log('   Detta kan vara korrekt - alla ordrar för detta datum kanske inte har kunddata');
  }
  console.log('');

  // Show breakdown
  const ordersWithCustomerId = ordersForDate.filter(o => o.customerId).length;
  const ordersWithNumberOfOrders = ordersForDate.filter(o => o.numberOfOrders).length;

  console.log(`📋 Detaljer:`);
  console.log(`   - Ordrar med customer.id: ${ordersWithCustomerId}`);
  console.log(`   - Ordrar med numberOfOrders: ${ordersWithNumberOfOrders}`);
  console.log('');
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});

