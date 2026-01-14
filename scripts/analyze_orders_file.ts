#!/usr/bin/env tsx

/**
 * Analyze orders from a file and compare with platform data
 * 
 * Usage:
 *   source env/local.prod.sh
 *   pnpm tsx scripts/analyze_orders_file.ts --tenant skinome --date 2025-11-28 --file orders.csv
 * 
 * Supported file formats:
 *   - CSV (with headers)
 *   - JSON (array of orders)
 */

import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface FileOrder {
  order_id?: string;
  order_number?: string;
  orderId?: string;
  orderNumber?: string;
  id?: string;
  processed_at?: string;
  date?: string;
  total_price?: number | string;
  totalPrice?: number | string;
  gross_sales?: number | string;
  grossSales?: number | string;
  net_sales?: number | string;
  netSales?: number | string;
  revenue?: number | string;
  currency?: string;
  [key: string]: any; // Allow other fields
}

interface PlatformOrder {
  order_id: string;
  processed_at: string;
  total_price: number | null;
  gross_sales: number | null;
  net_sales: number | null;
  currency: string | null;
  is_refund: boolean;
}

function parseValue(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    // Handle Swedish number format (space as thousands separator, comma as decimal)
    const cleaned = value
      .replace(/\s/g, '') // Remove spaces (thousands separator)
      .replace(',', '.') // Replace comma with dot (decimal separator)
      .replace(/[^\d.-]/g, ''); // Remove any remaining non-numeric chars except minus and dot
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeOrderId(order: FileOrder): string | null {
  // Handle Swedish column names
  const orderId = (
    order.order_id?.toString() ||
    order.orderId?.toString() ||
    order['Order-ID']?.toString() ||
    order['Order-ID']?.toString() ||
    order.order_number?.toString() ||
    order.orderNumber?.toString() ||
    order.id?.toString() ||
    null
  );
  
  // Clean up any quotes or whitespace
  return orderId ? orderId.replace(/^["']|["']$/g, '').trim() : null;
}

function parseOrderDate(order: FileOrder): string | null {
  const dateStr = order.processed_at || order.date;
  if (!dateStr) return null;
  
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function parseOrdersFromFile(filePath: string): FileOrder[] {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, 'utf-8');

  if (ext === '.json') {
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [data];
  } else if (ext === '.csv') {
    return parseCSV(content);
  } else {
    throw new Error(`Unsupported file format: ${ext}. Supported: .csv, .json`);
  }
}

function parseCSV(content: string): FileOrder[] {
  const lines = content.split('\n').filter(line => line.trim());
  if (lines.length === 0) return [];

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const orders: FileOrder[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const order: FileOrder = {};
    
    headers.forEach((header, index) => {
      order[header] = values[index] || null;
    });
    
    orders.push(order);
  }

  return orders;
}

async function fetchPlatformOrders(tenantId: string, date: string): Promise<PlatformOrder[]> {
  const { data, error } = await supabase
    .from('shopify_orders')
    .select('order_id, processed_at, total_sales, tax, gross_sales, net_sales, revenue, currency, is_refund')
    .eq('tenant_id', tenantId)
    .eq('processed_at', date);

  if (error) {
    throw new Error(`Failed to fetch platform orders: ${error.message}`);
  }

  return (data || []).map(o => ({
    order_id: o.order_id,
    processed_at: o.processed_at,
    total_price: o.total_price,
    gross_sales: o.gross_sales,
    net_sales: o.net_sales,
    currency: o.currency,
    is_refund: o.is_refund || false,
  }));
}

function compareOrders(fileOrders: FileOrder[], platformOrders: PlatformOrder[], targetDate: string) {
  const fileOrdersMap = new Map<string, FileOrder>();
  const platformOrdersMap = new Map<string, PlatformOrder>();

  // Filter file orders by date
  // If no date field exists in orders, assume all orders are for targetDate
  const filteredFileOrders = fileOrders.filter(order => {
    const orderDate = parseOrderDate(order);
    // If no date field, include all orders (assume they're all for targetDate)
    return !orderDate || orderDate === targetDate;
  });

  // Index file orders by order_id
  filteredFileOrders.forEach(order => {
    const orderId = normalizeOrderId(order);
    if (orderId) {
      fileOrdersMap.set(orderId, order);
    }
  });

  // Index platform orders by order_id
  platformOrders.forEach(order => {
    platformOrdersMap.set(order.order_id, order);
  });

  // Find matches and differences
  const matches: Array<{
    orderId: string;
    file: FileOrder;
    platform: PlatformOrder;
    differences: string[];
  }> = [];

  const onlyInFile: FileOrder[] = [];
  const onlyInPlatform: PlatformOrder[] = [];

  // Check file orders
  for (const [orderId, fileOrder] of fileOrdersMap.entries()) {
    const platformOrder = platformOrdersMap.get(orderId);
    if (platformOrder) {
      const differences: string[] = [];
      
      // Handle Swedish column names
      const fileGross = parseValue(
        fileOrder.gross_sales || 
        fileOrder.grossSales || 
        fileOrder['Bruttoförsäljning'] || 
        fileOrder.Bruttoförsäljning
      );
      const platformGross = platformOrder.gross_sales;
      
      if (fileGross !== null && platformGross !== null) {
        const diff = Math.abs(fileGross - platformGross);
        if (diff > 0.01) {
          differences.push(`gross_sales: file=${fileGross.toFixed(2)}, platform=${platformGross.toFixed(2)}, diff=${diff.toFixed(2)}`);
        }
      } else if (fileGross !== null && platformGross === null) {
        differences.push(`gross_sales: file=${fileGross.toFixed(2)}, platform=null`);
      } else if (fileGross === null && platformGross !== null) {
        differences.push(`gross_sales: file=null, platform=${platformGross.toFixed(2)}`);
      }
      
      const fileNet = parseValue(
        fileOrder.net_sales || 
        fileOrder.netSales || 
        fileOrder['Nettoförsäljning'] || 
        fileOrder.Nettoförsäljning
      );
      const platformNet = platformOrder.net_sales;
      
      // Calculate total_price from file (Bruttoförsäljning + Skatter - Rabatter, or Nettoförsäljning + Skatter)
      const fileTax = parseValue(fileOrder['Skatter'] || fileOrder.Skatter || fileOrder.tax || fileOrder.total_tax);
      const fileTotal = parseValue(
        fileOrder.total_price || 
        fileOrder.totalPrice || 
        fileOrder.revenue
      ) || (fileNet !== null && fileTax !== null ? fileNet + fileTax : (fileGross !== null ? fileGross : null));
      const platformTotal = platformOrder.total_price;
      
      if (fileNet !== null && platformNet !== null) {
        const diff = Math.abs(fileNet - platformNet);
        if (diff > 0.01) {
          differences.push(`net_sales: file=${fileNet}, platform=${platformNet}, diff=${diff.toFixed(2)}`);
        }
      } else if (fileNet !== null && platformNet === null) {
        differences.push(`net_sales: file=${fileNet}, platform=null`);
      } else if (fileNet === null && platformNet !== null) {
        differences.push(`net_sales: file=null, platform=${platformNet}`);
      }

      if (differences.length > 0) {
        matches.push({ orderId, file: fileOrder, platform: platformOrder, differences });
      }
    } else {
      onlyInFile.push(fileOrder);
    }
  }

  // Check platform orders
  for (const [orderId, platformOrder] of platformOrdersMap.entries()) {
    if (!fileOrdersMap.has(orderId)) {
      onlyInPlatform.push(platformOrder);
    }
  }

  return {
    matches: matches.length,
    matchesWithDifferences: matches,
    onlyInFile: onlyInFile.length,
    onlyInFileOrders: onlyInFile,
    onlyInPlatform: onlyInPlatform.length,
    onlyInPlatformOrders: onlyInPlatform,
    
    // Aggregate totals
    fileTotals: {
      orders: filteredFileOrders.length,
      total_price: filteredFileOrders.reduce((sum, o) => {
        const net = parseValue(o.net_sales || o.netSales || o['Nettoförsäljning'] || o.Nettoförsäljning);
        const tax = parseValue(o['Skatter'] || o.Skatter || o.tax || o.total_tax);
        const explicitTotal = parseValue(o.total_price || o.totalPrice || o.revenue);
        return sum + (explicitTotal || (net !== null && tax !== null ? net + tax : 0));
      }, 0),
      gross_sales: filteredFileOrders.reduce((sum, o) => sum + (parseValue(o.gross_sales || o.grossSales || o['Bruttoförsäljning'] || o.Bruttoförsäljning) || 0), 0),
      net_sales: filteredFileOrders.reduce((sum, o) => sum + (parseValue(o.net_sales || o.netSales || o['Nettoförsäljning'] || o.Nettoförsäljning) || 0), 0),
    },
    platformTotals: {
      orders: platformOrders.length,
      total_price: platformOrders.reduce((sum, o) => sum + (o.total_price || 0), 0),
      gross_sales: platformOrders.reduce((sum, o) => sum + (o.gross_sales || 0), 0),
      net_sales: platformOrders.reduce((sum, o) => sum + (o.net_sales || 0), 0),
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const tenantIndex = args.indexOf('--tenant');
  const dateIndex = args.indexOf('--date');
  const fileIndex = args.indexOf('--file');

  if (tenantIndex === -1 || !args[tenantIndex + 1]) {
    console.error('Usage: pnpm tsx scripts/analyze_orders_file.ts --tenant <slug> --date <YYYY-MM-DD> --file <path>');
    process.exit(1);
  }

  if (dateIndex === -1 || !args[dateIndex + 1]) {
    console.error('Usage: pnpm tsx scripts/analyze_orders_file.ts --tenant <slug> --date <YYYY-MM-DD> --file <path>');
    process.exit(1);
  }

  if (fileIndex === -1 || !args[fileIndex + 1]) {
    console.error('Usage: pnpm tsx scripts/analyze_orders_file.ts --tenant <slug> --date <YYYY-MM-DD> --file <path>');
    process.exit(1);
  }

  const tenantSlug = args[tenantIndex + 1];
  const targetDate = args[dateIndex + 1];
  const filePath = args[fileIndex + 1];

  console.log(`[analyze_orders] Starting analysis for tenant: ${tenantSlug}`);
  console.log(`[analyze_orders] Target date: ${targetDate}`);
  console.log(`[analyze_orders] File: ${filePath}\n`);

  // Get tenant
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, name')
    .eq('slug', tenantSlug)
    .single();

  if (tenantError || !tenant) {
    throw new Error(`Tenant not found: ${tenantSlug}`);
  }

  console.log(`[analyze_orders] Found tenant: ${tenant.name} (${tenant.id})\n`);

  // Parse file
  console.log(`[analyze_orders] Parsing file...`);
  const fileOrders = parseOrdersFromFile(filePath);
  console.log(`[analyze_orders] Found ${fileOrders.length} orders in file\n`);

  // Fetch platform orders
  console.log(`[analyze_orders] Fetching platform orders for ${targetDate}...`);
  const platformOrders = await fetchPlatformOrders(tenant.id, targetDate);
  console.log(`[analyze_orders] Found ${platformOrders.length} orders in platform\n`);

  // Compare
  console.log(`[analyze_orders] Comparing orders...\n`);
  const comparison = compareOrders(fileOrders, platformOrders, targetDate);

  // Print results
  console.log('='.repeat(80));
  console.log('ANALYSIS RESULTS');
  console.log('='.repeat(80));
  console.log(`\n📊 Summary:`);
  console.log(`  Orders in file (${targetDate}): ${comparison.fileTotals.orders}`);
  console.log(`  Orders in platform (${targetDate}): ${comparison.platformTotals.orders}`);
  console.log(`  Matched orders: ${comparison.matches}`);
  console.log(`  Matched orders with differences: ${comparison.matchesWithDifferences.length}`);
  console.log(`  Only in file: ${comparison.onlyInFile}`);
  console.log(`  Only in platform: ${comparison.onlyInPlatform}`);

  console.log(`\n💰 Totals comparison:`);
  console.log(`  File total_price: ${comparison.fileTotals.total_price.toFixed(2)}`);
  console.log(`  Platform total_price: ${comparison.platformTotals.total_price.toFixed(2)}`);
  console.log(`  Difference: ${(comparison.fileTotals.total_price - comparison.platformTotals.total_price).toFixed(2)}`);
  
  console.log(`\n  File gross_sales: ${comparison.fileTotals.gross_sales.toFixed(2)}`);
  console.log(`  Platform gross_sales: ${comparison.platformTotals.gross_sales.toFixed(2)}`);
  console.log(`  Difference: ${(comparison.fileTotals.gross_sales - comparison.platformTotals.gross_sales).toFixed(2)}`);
  
  console.log(`\n  File net_sales: ${comparison.fileTotals.net_sales.toFixed(2)}`);
  console.log(`  Platform net_sales: ${comparison.platformTotals.net_sales.toFixed(2)}`);
  console.log(`  Difference: ${(comparison.fileTotals.net_sales - comparison.platformTotals.net_sales).toFixed(2)}`);

  if (comparison.matchesWithDifferences.length > 0) {
    console.log(`\n⚠️  Orders with differences (showing first 20):`);
    comparison.matchesWithDifferences.slice(0, 20).forEach((match, i) => {
      console.log(`\n  ${i + 1}. Order ${match.orderId}:`);
      match.differences.forEach(diff => {
        console.log(`     - ${diff}`);
      });
    });
    
    if (comparison.matchesWithDifferences.length > 20) {
      console.log(`\n     ... and ${comparison.matchesWithDifferences.length - 20} more`);
    }
  }

  if (comparison.onlyInFile.length > 0) {
    console.log(`\n📁 Orders only in file (first 10):`);
    comparison.onlyInFileOrders.slice(0, 10).forEach((order, i) => {
      const orderId = normalizeOrderId(order) || 'unknown';
      const total = parseValue(order.total_price || order.totalPrice || order.revenue);
      console.log(`  ${i + 1}. Order ${orderId}: total=${total}`);
    });
    
    if (comparison.onlyInFile > 10) {
      console.log(`     ... and ${comparison.onlyInFile - 10} more`);
    }
  }

  if (comparison.onlyInPlatform.length > 0) {
    console.log(`\n🌐 Orders only in platform (first 10):`);
    comparison.onlyInPlatformOrders.slice(0, 10).forEach((order, i) => {
      console.log(`  ${i + 1}. Order ${order.order_id}: total=${order.total_price || 'null'}, gross=${order.gross_sales || 'null'}`);
    });
    
    if (comparison.onlyInPlatform > 10) {
      console.log(`     ... and ${comparison.onlyInPlatform - 10} more`);
    }
  }

  console.log('\n' + '='.repeat(80));
}

main().catch((error) => {
  console.error('\n[analyze_orders] ❌ Error:', error);
  process.exit(1);
});

