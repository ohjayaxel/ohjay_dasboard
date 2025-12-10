#!/usr/bin/env tsx
/**
 * Verification script for /api/shopify/daily-sales endpoint
 * 
 * Verifies that the API returns all required fields:
 * - new_customer_net_sales
 * - returning_customer_net_sales
 * - guest_net_sales
 * 
 * Also verifies that the data is correct for both Shopify and Financial modes
 */

// Load environment variables from .env.local
import { readFileSync } from 'fs';
import { resolve } from 'path';

try {
  const envFile = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const match = line.match(/^([^=:#]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
} catch (error) {
  console.warn('[verify_daily_sales_api] Could not load .env.local, using existing env vars');
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Error: Missing environment variables');
  console.error('   NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL');
  console.error('   SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

async function verifyApiEndpoint() {
  const tenantSlug = process.argv[2] || 'skinome';
  const from = process.argv[3] || '2025-01-01';
  const to = process.argv[4] || '2025-01-31';

  // Resolve tenant slug to tenant ID
  const { resolveTenantId } = await import('../lib/tenants/resolve-tenant');
  const tenantId = await resolveTenantId(tenantSlug);

  console.log('🔍 Verifying /api/shopify/daily-sales API endpoint');
  console.log(`   Tenant: ${tenantSlug} (${tenantId})`);
  console.log(`   Period: ${from} to ${to}\n`);

  // Import fetchShopifyDailySales directly (simulates API call)
  const { fetchShopifyDailySales } = await import('../lib/data/fetchers');

  // Test Shopify Mode
  console.log('📊 Testing Shopify Mode...');
  const shopifyRows = await fetchShopifyDailySales({
    tenantId,
    from,
    to,
    mode: 'shopify',
  });

  if (shopifyRows.length === 0) {
    console.log('   ⚠️  No data found for Shopify Mode');
  } else {
    console.log(`   ✅ Found ${shopifyRows.length} rows`);
    
    // Check first row for all required fields
    const firstRow = shopifyRows[0];
    const requiredFields = [
      'tenant_id',
      'date',
      'mode',
      'net_sales_excl_tax',
      'new_customer_net_sales',
      'returning_customer_net_sales',
      'guest_net_sales',
    ];

    const missingFields: string[] = [];
    const nullFields: string[] = [];

    for (const field of requiredFields) {
      if (!(field in firstRow)) {
        missingFields.push(field);
      } else if (firstRow[field as keyof typeof firstRow] === null && field !== 'tenant_id') {
        nullFields.push(field);
      }
    }

    if (missingFields.length > 0) {
      console.log(`   ❌ Missing fields: ${missingFields.join(', ')}`);
    } else {
      console.log('   ✅ All required fields present');
    }

    if (nullFields.length > 0) {
      console.log(`   ⚠️  Null fields (may be expected): ${nullFields.join(', ')}`);
    }

    // Verify data integrity: new + returning + guest = net_sales
    let totalMismatches = 0;
    let totalRowsChecked = 0;
    const mismatchDetails: Array<{ date: string; sum: number; netSales: number; diff: number; breakdown: string }> = [];

    for (const row of shopifyRows) {
      if (row.net_sales_excl_tax !== null) {
        totalRowsChecked++;
        const newSales = row.new_customer_net_sales ?? 0;
        const returningSales = row.returning_customer_net_sales ?? 0;
        const guestSales = row.guest_net_sales ?? 0;
        const sum = newSales + returningSales + guestSales;
        const netSales = row.net_sales_excl_tax || 0;
        const diff = Math.abs(sum - netSales);

        // Check for NULL values (not yet classified)
        const hasNulls = 
          row.new_customer_net_sales === null ||
          row.returning_customer_net_sales === null ||
          row.guest_net_sales === null;

        // Allow small rounding differences (0.01)
        if (diff > 0.01) {
          totalMismatches++;
          mismatchDetails.push({
            date: row.date,
            sum,
            netSales,
            diff,
            breakdown: hasNulls ? 'Has NULL values (not yet classified)' : 'Data mismatch',
          });
        }
      }
    }

    if (totalMismatches === 0) {
      console.log(`   ✅ Data integrity check passed (${totalRowsChecked} rows)`);
    } else {
      console.log(`   ⚠️  Data integrity check: ${totalMismatches} mismatches out of ${totalRowsChecked} rows`);
    }

    // Show sample data
    console.log('\n   Sample row (Shopify Mode):');
    const sample = shopifyRows[0];
    console.log(`      Date: ${sample.date}`);
    console.log(`      Net Sales: ${sample.net_sales_excl_tax?.toFixed(2) || 'null'}`);
    console.log(`      New Customer Net Sales: ${sample.new_customer_net_sales?.toFixed(2) || 'null'}`);
    console.log(`      Returning Customer Net Sales: ${sample.returning_customer_net_sales?.toFixed(2) || 'null'}`);
    console.log(`      Guest Net Sales: ${sample.guest_net_sales?.toFixed(2) || 'null'}`);
    console.log(`      Orders: ${sample.orders_count || 0}`);
  }

  // Test Financial Mode
  console.log('\n📊 Testing Financial Mode...');
  const financialRows = await fetchShopifyDailySales({
    tenantId,
    from,
    to,
    mode: 'financial',
  });

  if (financialRows.length === 0) {
    console.log('   ⚠️  No data found for Financial Mode');
  } else {
    console.log(`   ✅ Found ${financialRows.length} rows`);
    
    // Check first row for all required fields
    const firstRow = financialRows[0];
    const requiredFields = [
      'tenant_id',
      'date',
      'mode',
      'net_sales_excl_tax',
      'new_customer_net_sales',
      'returning_customer_net_sales',
      'guest_net_sales',
    ];

    const missingFields: string[] = [];
    const nullFields: string[] = [];

    for (const field of requiredFields) {
      if (!(field in firstRow)) {
        missingFields.push(field);
      } else if (firstRow[field as keyof typeof firstRow] === null && field !== 'tenant_id') {
        nullFields.push(field);
      }
    }

    if (missingFields.length > 0) {
      console.log(`   ❌ Missing fields: ${missingFields.join(', ')}`);
    } else {
      console.log('   ✅ All required fields present');
    }

    if (nullFields.length > 0) {
      console.log(`   ⚠️  Null fields (may be expected): ${nullFields.join(', ')}`);
    }

    // Verify data integrity
    let totalMismatches = 0;
    let totalRowsChecked = 0;
    const mismatchDetails: Array<{ date: string; sum: number; netSales: number; diff: number; breakdown: string }> = [];

    for (const row of financialRows) {
      if (row.net_sales_excl_tax !== null) {
        totalRowsChecked++;
        const newSales = row.new_customer_net_sales ?? 0;
        const returningSales = row.returning_customer_net_sales ?? 0;
        const guestSales = row.guest_net_sales ?? 0;
        const sum = newSales + returningSales + guestSales;
        const netSales = row.net_sales_excl_tax || 0;
        const diff = Math.abs(sum - netSales);

        // Check for NULL values (not yet classified)
        const hasNulls = 
          row.new_customer_net_sales === null ||
          row.returning_customer_net_sales === null ||
          row.guest_net_sales === null;

        if (diff > 0.01) {
          totalMismatches++;
          mismatchDetails.push({
            date: row.date,
            sum,
            netSales,
            diff,
            breakdown: hasNulls ? 'Has NULL values (not yet classified)' : 'Data mismatch',
          });
        }
      }
    }

    if (totalMismatches === 0) {
      console.log(`   ✅ Data integrity check passed (${totalRowsChecked} rows)`);
    } else {
      console.log(`   ⚠️  Data integrity check: ${totalMismatches} mismatches out of ${totalRowsChecked} rows`);
      console.log('\n   Mismatch details:');
      for (const detail of mismatchDetails.slice(0, 5)) {
        const row = financialRows.find(r => r.date === detail.date);
        console.log(`      ${detail.date}: ${detail.breakdown}`);
        console.log(`        Sum (new+returning+guest): ${detail.sum.toFixed(2)}`);
        console.log(`        Net Sales: ${detail.netSales.toFixed(2)}`);
        console.log(`        Difference: ${detail.diff.toFixed(2)}`);
        if (row) {
          console.log(`        New: ${(row.new_customer_net_sales ?? 0).toFixed(2)}, Returning: ${(row.returning_customer_net_sales ?? 0).toFixed(2)}, Guest: ${(row.guest_net_sales ?? 0).toFixed(2)}`);
        }
      }
      if (mismatchDetails.length > 5) {
        console.log(`      ... and ${mismatchDetails.length - 5} more`);
      }
    }

    // Show sample data
    console.log('\n   Sample row (Financial Mode):');
    const sample = financialRows[0];
    console.log(`      Date: ${sample.date}`);
    console.log(`      Net Sales: ${sample.net_sales_excl_tax?.toFixed(2) || 'null'}`);
    console.log(`      New Customer Net Sales: ${sample.new_customer_net_sales?.toFixed(2) || 'null'}`);
    console.log(`      Returning Customer Net Sales: ${sample.returning_customer_net_sales?.toFixed(2) || 'null'}`);
    console.log(`      Guest Net Sales: ${sample.guest_net_sales?.toFixed(2) || 'null'}`);
    console.log(`      Orders: ${sample.orders_count || 0}`);
  }

  // Summary
  console.log('\n✅ Verification complete!');
  console.log('\nSummary:');
  console.log(`   Shopify Mode: ${shopifyRows.length} rows`);
  console.log(`   Financial Mode: ${financialRows.length} rows`);
}

verifyApiEndpoint().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});

