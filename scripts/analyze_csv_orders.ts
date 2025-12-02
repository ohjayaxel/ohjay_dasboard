#!/usr/bin/env tsx

/**
 * Analyze CSV file with order data and compare with platform
 */

import { ArgumentParser } from 'argparse';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type CsvRow = {
  'Order-ID': string;
  'Produkt-ID': string;
  'Bruttoförsäljning': string;
  'Nettoförsäljning': string;
  'Rabatter': string;
  'Returer': string;
  'Skatter': string;
};

function parseCSV(filePath: string): CsvRow[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const headers = lines[0].replace(/"/g, '').split(',');
  
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    
    // Parse CSV line (handling quoted values)
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let j = 0; j < lines[i].length; j++) {
      const char = lines[i][j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    
    if (values.length >= headers.length) {
      const row: any = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx] || '';
      });
      rows.push(row as CsvRow);
    }
  }
  
  return rows;
}

function parseValue(value: string | null | undefined): number {
  if (!value || value === '') return 0;
  return parseFloat(String(value).replace(',', '.')) || 0;
}

async function main() {
  const parser = new ArgumentParser({
    description: 'Analyze CSV file with order data and compare with platform',
  });
  parser.add_argument('--tenant', {
    help: 'Tenant slug',
    required: true,
  });
  parser.add_argument('--file', {
    help: 'Path to CSV file',
    required: true,
  });
  parser.add_argument('--date', {
    help: 'Date for comparison (YYYY-MM-DD)',
    required: true,
  });

  const args = parser.parse_args();
  const tenantSlug = args.tenant;
  const filePath = args.file;
  const targetDate = args.date;

  console.log(`[analyze_csv] Analyzing CSV file: ${filePath}`);
  console.log(`[analyze_csv] Target date: ${targetDate}\n`);

  // Parse CSV
  const csvRows = parseCSV(filePath);
  console.log(`[analyze_csv] Found ${csvRows.length} rows in CSV file\n`);

  // Filter out rows with empty Product-ID (shipping rows)
  const productRows = csvRows.filter(r => r['Produkt-ID'] && r['Produkt-ID'].trim() !== '');
  console.log(`[analyze_csv] Found ${productRows.length} product rows (excluding shipping)\n`);

  // Group by Order-ID
  const csvByOrder = new Map<string, {
    orderId: string;
    bruttoförsäljning: number;
    nettoförsäljning: number;
    rabatter: number;
    skatter: number;
    returer: number;
  }>();

  productRows.forEach(row => {
    const orderId = row['Order-ID'];
    if (!csvByOrder.has(orderId)) {
      csvByOrder.set(orderId, {
        orderId,
        bruttoförsäljning: 0,
        nettoförsäljning: 0,
        rabatter: 0,
        skatter: 0,
        returer: 0,
      });
    }
    
    const order = csvByOrder.get(orderId)!;
    order.bruttoförsäljning += parseValue(row['Bruttoförsäljning']);
    order.nettoförsäljning += parseValue(row['Nettoförsäljning']);
    order.rabatter += parseValue(row['Rabatter']);
    order.skatter += parseValue(row['Skatter']);
    order.returer += parseValue(row['Returer']);
  });

  const csvOrders = Array.from(csvByOrder.values());
  
  // Calculate CSV totals
  const csvTotalBrutto = csvOrders.reduce((sum, o) => sum + o.bruttoförsäljning, 0);
  const csvTotalNetto = csvOrders.reduce((sum, o) => sum + o.nettoförsäljning, 0);
  const csvTotalRabatter = csvOrders.reduce((sum, o) => sum + o.rabatter, 0);
  const csvTotalSkatter = csvOrders.reduce((sum, o) => sum + o.skatter, 0);
  const csvTotalReturer = csvOrders.reduce((sum, o) => sum + o.returer, 0);

  console.log(`📊 CSV File Summary:`);
  console.log(`  Unique orders: ${csvOrders.length}`);
  console.log(`  Total Bruttoförsäljning: ${csvTotalBrutto.toFixed(2)}`);
  console.log(`  Total Nettoförsäljning: ${csvTotalNetto.toFixed(2)}`);
  console.log(`  Total Rabatter: ${csvTotalRabatter.toFixed(2)}`);
  console.log(`  Total Skatter: ${csvTotalSkatter.toFixed(2)}`);
  console.log(`  Total Returer: ${csvTotalReturer.toFixed(2)}\n`);

  // Get tenant
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, name')
    .eq('slug', tenantSlug)
    .single();

  if (tenantError || !tenant) {
    throw new Error(`Tenant not found: ${tenantSlug}`);
  }

  // Get platform orders
  const { data: platformOrders, error: platformError } = await supabase
    .from('shopify_orders')
    .select('order_id, gross_sales, net_sales, total_price, total_tax, discount_total, total_refunds')
    .eq('tenant_id', tenant.id)
    .eq('processed_at', targetDate)
    .gt('gross_sales', 0);

  if (platformError) {
    throw new Error(`Failed to fetch platform orders: ${platformError.message}`);
  }

  const platformTotalGross = (platformOrders || []).reduce((sum, o) => sum + (o.gross_sales || 0), 0);
  const platformTotalNet = (platformOrders || []).reduce((sum, o) => sum + (o.net_sales || 0), 0);
  const platformTotalDiscounts = (platformOrders || []).reduce((sum, o) => sum + (o.discount_total || 0), 0);
  const platformTotalTax = (platformOrders || []).reduce((sum, o) => sum + (o.total_tax || 0), 0);
  const platformTotalRefunds = (platformOrders || []).reduce((sum, o) => sum + (o.total_refunds || 0), 0);

  console.log(`📊 Platform Summary:`);
  console.log(`  Orders: ${(platformOrders || []).length}`);
  console.log(`  Total gross_sales: ${platformTotalGross.toFixed(2)}`);
  console.log(`  Total net_sales: ${platformTotalNet.toFixed(2)}`);
  console.log(`  Total discounts: ${platformTotalDiscounts.toFixed(2)}`);
  console.log(`  Total tax: ${platformTotalTax.toFixed(2)}`);
  console.log(`  Total refunds: ${platformTotalRefunds.toFixed(2)}\n`);

  console.log(`📊 Comparison:`);
  console.log(`  Bruttoförsäljning difference: ${(csvTotalBrutto - platformTotalGross).toFixed(2)}`);
  console.log(`  Nettoförsäljning difference: ${(csvTotalNetto - platformTotalNet).toFixed(2)}\n`);

  // Analyze formula from CSV
  console.log(`📊 CSV Formula Analysis:`);
  console.log(`  Nettoförsäljning = Bruttoförsäljning + Rabatter (Rabatter is negative in CSV)`);
  console.log(`  Example: ${csvOrders[0].bruttoförsäljning.toFixed(2)} + ${csvOrders[0].rabatter.toFixed(2)} = ${(csvOrders[0].bruttoförsäljning + csvOrders[0].rabatter).toFixed(2)}`);
  console.log(`  Expected Nettoförsäljning: ${csvOrders[0].nettoförsäljning.toFixed(2)}\n`);

  // Check if our formula matches
  console.log(`📊 Formula Verification:`);
  csvOrders.slice(0, 10).forEach(order => {
    const calculatedNetto = order.bruttoförsäljning + order.rabatter - order.returer;
    const matches = Math.abs(calculatedNetto - order.nettoförsäljning) < 0.01;
    if (!matches) {
      console.log(`  Order ${order.orderId}: Calculated=${calculatedNetto.toFixed(2)}, Expected=${order.nettoförsäljning.toFixed(2)}, Diff=${Math.abs(calculatedNetto - order.nettoförsäljning).toFixed(2)}`);
    }
  });
}

main().catch((error) => {
  console.error('\n[analyze_csv] ❌ Error:', error);
  process.exit(1);
});

