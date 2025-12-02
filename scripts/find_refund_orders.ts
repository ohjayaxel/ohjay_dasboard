#!/usr/bin/env tsx

/**
 * Find orders with refunds created on a specific date
 * This helps identify why refund orders appear in files for dates different from processed_at
 */

import { ArgumentParser } from 'argparse';
import { createClient } from '@supabase/supabase-js';
import { decryptSecret } from '@/lib/integrations/crypto';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const parser = new ArgumentParser({
    description: 'Find orders with refunds for a specific date',
  });
  parser.add_argument('--tenant', { required: true, help: 'Tenant slug' });
  parser.add_argument('--date', { required: true, help: 'Date to check (YYYY-MM-DD)' });

  const args = parser.parse_args();
  const tenantSlug = args.tenant;
  const targetDate = args.date;

  console.log(`[find_refund_orders] Finding refunds for tenant: ${tenantSlug}`);
  console.log(`[find_refund_orders] Target date: ${targetDate}\n`);

  // Get tenant
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, name')
    .eq('slug', tenantSlug)
    .single();

  if (tenantError || !tenant) {
    throw new Error(`Tenant not found: ${tenantSlug}`);
  }

  console.log(`[find_refund_orders] Found tenant: ${tenant.name} (${tenant.id})\n`);

  // Get connection
  const { data: connData, error: connError } = await supabase
    .from('connections')
    .select('access_token_enc, meta')
    .eq('tenant_id', tenant.id)
    .eq('source', 'shopify')
    .single();

  if (connError || !connData) {
    throw new Error('Shopify connection not found');
  }

  const shopDomain = (connData.meta as any)?.store_domain || (connData.meta as any)?.shop;
  if (!shopDomain || shopDomain === 'Not set') {
    throw new Error('Shop domain not found in connection');
  }

  let accessToken: string;
  try {
    accessToken = decryptSecret(connData.access_token_enc as Buffer);
  } catch (error) {
    throw new Error(`Failed to decrypt access token: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Fetch orders with refunds from a wider date range
  // Refunds might be on original orders with different processed_at
  const startDate = new Date(targetDate);
  startDate.setDate(startDate.getDate() - 60); // Check 60 days before
  
  const endDate = new Date(targetDate);
  endDate.setDate(endDate.getDate() + 1);

  const startDateStr = startDate.toISOString().slice(0, 10);
  const endDateStr = endDate.toISOString().slice(0, 10);

  console.log(`[find_refund_orders] Fetching orders from ${startDateStr} to ${endDateStr}...\n`);

  let allOrders: any[] = [];
  let pageInfo: string | null = null;
  let page = 1;

  while (true) {
    const url = new URL(`https://${shopDomain}/admin/api/2023-10/orders.json`);
    url.searchParams.set('limit', '250');
    url.searchParams.set('fields', 'id,processed_at,created_at,refunds');

    if (pageInfo) {
      url.searchParams.set('page_info', pageInfo);
      // Don't set status or date filters when using page_info
    } else {
      url.searchParams.set('status', 'any');
      url.searchParams.set('created_at_min', startDateStr);
      url.searchParams.set('created_at_max', endDateStr);
    }

    const res = await fetch(url.toString(), {
      headers: {
        'X-Shopify-Access-Token': accessToken,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify API error: ${res.status} ${body}`);
    }

    const body = await res.json();
    const orders = body.orders || [];

    if (orders.length === 0) {
      break;
    }

    allOrders.push(...orders);

    // Check for next page
    const linkHeader = res.headers.get('link');
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const nextMatch = linkHeader.match(/<([^>]+)>; rel="next"/);
      if (nextMatch) {
        const nextUrl = new URL(nextMatch[1]);
        pageInfo = nextUrl.searchParams.get('page_info');
      } else {
        break;
      }
    } else {
      break;
    }

    page++;
    if (page > 100) break; // Safety limit
  }

  console.log(`[find_refund_orders] Fetched ${allOrders.length} orders\n`);

  // Find orders with refunds created on target date
  const ordersWithRefundsOnTargetDate: Array<{
    orderId: string;
    processedAt: string | null;
    refundCreatedAt: string;
    refundId: number;
  }> = [];

  for (const order of allOrders) {
    if (order.refunds && Array.isArray(order.refunds) && order.refunds.length > 0) {
      for (const refund of order.refunds) {
        const refundDate = refund.created_at ? new Date(refund.created_at).toISOString().slice(0, 10) : null;
        if (refundDate === targetDate) {
          ordersWithRefundsOnTargetDate.push({
            orderId: order.id.toString(),
            processedAt: order.processed_at ? new Date(order.processed_at).toISOString().slice(0, 10) : null,
            refundCreatedAt: refundDate,
            refundId: refund.id,
          });
        }
      }
    }
  }

  console.log(`\n📊 Orders med refunds skapade ${targetDate}:`);
  console.log(`  Antal: ${ordersWithRefundsOnTargetDate.length}\n`);

  if (ordersWithRefundsOnTargetDate.length > 0) {
    console.log('  Detaljer:');
    ordersWithRefundsOnTargetDate.forEach((item, i) => {
      console.log(`    ${i + 1}. Order ${item.orderId}: processed_at=${item.processedAt || 'null'}, refund.created_at=${item.refundCreatedAt}, refund.id=${item.refundId}`);
    });
  }

  // Also check orders in file that have gross=0 (refunds)
  const fs = require('fs');
  const filePath = '/Users/axelsamuelson/Downloads/Bruttoförsäljning efter order-id - 2025-11-28 - 2025-11-28 (1).csv';
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((line: string) => line.trim());
    const dataLines = lines.slice(1).filter((line: string) => {
      const parts = line.split(',');
      return parts[0] && parts[0].trim() && !parts[0].startsWith('"Order-ID"');
    });

    const refundOrderIds = dataLines
      .filter((line: string) => {
        const parts = line.split(',');
        const gross = parseFloat(parts[1] || '0');
        return gross === 0;
      })
      .map((line: string) => line.split(',')[0].replace(/^"|"$/g, '').trim());

    console.log(`\n📄 Orders i filen med gross=0 (refunds): ${refundOrderIds.length}`);
    console.log(`  Order IDs: ${refundOrderIds.join(', ')}`);
  }
}

main().catch((error) => {
  console.error('\n[find_refund_orders] ❌ Error:', error);
  process.exit(1);
});

