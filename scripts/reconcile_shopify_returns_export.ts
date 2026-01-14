#!/usr/bin/env tsx
/**
 * Reconcile Shopify Analytics export "Returer" against platform tables.
 *
 * Source of truth: Shopify Analytics export with Swedish headers, e.g:
 *   "Dag","Order-ID","Bruttoförsäljning","Nettoförsäljning","Rabatter","Returer",...
 *
 * Usage:
 *   pnpm tsx scripts/reconcile_shopify_returns_export.ts --file "scripts/data/OHJAY Analaytics Check - 2025-01-01 - 2026-01-12 (1).csv" --date 2026-01-08
 *
 * Optional DB comparison (requires env):
 *   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 *   pnpm tsx scripts/reconcile_shopify_returns_export.ts --tenant skinome --file ... --date 2026-01-08
 */

import { ArgumentParser } from 'argparse';
import { readFileSync } from 'node:fs';

type CsvRow = Record<string, string>;

function parseNumber(raw: string | undefined): number {
  if (!raw) return 0;
  const n = parseFloat(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function parseCsv(filePath: string): CsvRow[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = lines[0].replace(/^\uFEFF/, '').replace(/"/g, '').split(',');

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    values.push(current);

    const row: CsvRow = {};
    for (let k = 0; k < headers.length; k++) {
      row[headers[k]] = (values[k] ?? '').replace(/^"|"$/g, '').trim();
    }
    rows.push(row);
  }
  return rows;
}

async function main() {
  const parser = new ArgumentParser({
    description: 'Reconcile Shopify Analytics export Returer vs platform data',
  });
  parser.add_argument('--file', { required: true, help: 'Path to Shopify Analytics export CSV' });
  parser.add_argument('--date', { required: true, help: 'Target date (YYYY-MM-DD)' });
  parser.add_argument('--tenant', { required: false, help: 'Tenant slug (optional; enables DB compare)' });

  const args = parser.parse_args();
  const filePath = args.file as string;
  const targetDate = args.date as string;
  const tenantSlug = (args.tenant as string | undefined) || undefined;

  const rows = parseCsv(filePath);
  if (rows.length === 0) {
    throw new Error(`No rows parsed from CSV: ${filePath}`);
  }

  // Detect first column name (Dag/Månad) and required headers
  const dayKey = rows[0]['Dag'] !== undefined ? 'Dag' : rows[0]['Månad'] !== undefined ? 'Månad' : null;
  if (!dayKey) {
    throw new Error(`CSV missing 'Dag'/'Månad' column. Headers seen: ${Object.keys(rows[0]).join(', ')}`);
  }

  const dateRows = rows.filter((r) => r[dayKey] === targetDate);
  console.log(`[reconcile_export] File: ${filePath}`);
  console.log(`[reconcile_export] Granularity: ${dayKey}`);
  console.log(`[reconcile_export] Target date: ${targetDate}`);
  console.log(`[reconcile_export] Rows for date: ${dateRows.length}\n`);

  let returnsSigned = 0;
  let returnsMagnitudeFromNegatives = 0;
  const returnOrders: Array<{ orderId: string; returer: number }> = [];

  for (const r of dateRows) {
    const orderId = r['Order-ID'] || '';
    const ret = parseNumber(r['Returer']);
    returnsSigned += ret;
    if (ret < 0) returnsMagnitudeFromNegatives += -ret;
    if (Math.abs(ret) > 0.0001) returnOrders.push({ orderId, returer: ret });
  }

  returnsSigned = Math.round(returnsSigned * 100) / 100;
  returnsMagnitudeFromNegatives = Math.round(returnsMagnitudeFromNegatives * 100) / 100;

  console.log(`[reconcile_export] Export Returer signed sum: ${returnsSigned.toFixed(2)}`);
  console.log(
    `[reconcile_export] Export Returns magnitude (only negative Returer): ${returnsMagnitudeFromNegatives.toFixed(2)}`,
  );

  if (returnOrders.length > 0) {
    returnOrders.sort((a, b) => Math.abs(b.returer) - Math.abs(a.returer));
    console.log(`\n[reconcile_export] Orders with Returer != 0 (${returnOrders.length}):`);
    for (const o of returnOrders.slice(0, 50)) {
      console.log(`  - ${o.orderId}: ${o.returer}`);
    }
    if (returnOrders.length > 50) console.log(`  ... +${returnOrders.length - 50} more`);
  }

  if (!tenantSlug) return;

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY');
  }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', tenantSlug)
    .single();
  if (tenantError || !tenant) throw new Error(`Tenant not found: ${tenantError?.message || tenantSlug}`);

  const tenantId = tenant.id as string;

  const { data: daily, error: dailyError } = await supabase
    .from('shopify_daily_sales')
    .select('date, net_sales_excl_tax, gross_sales_excl_tax, discounts_excl_tax, refunds_excl_tax')
    .eq('tenant_id', tenantId)
    .eq('mode', 'shopify')
    .eq('date', targetDate)
    .maybeSingle();

  if (dailyError) throw new Error(`Failed to fetch shopify_daily_sales: ${dailyError.message}`);

  const { data: returnTx, error: returnTxError } = await supabase
    .from('shopify_sales_transactions')
    .select('returns')
    .eq('tenant_id', tenantId)
    .eq('event_type', 'RETURN')
    .eq('event_date', targetDate);

  if (returnTxError) throw new Error(`Failed to fetch shopify_sales_transactions: ${returnTxError.message}`);

  const txReturns = Math.round(
    (returnTx || []).reduce((sum: number, r: any) => sum + (parseFloat((r.returns || 0).toString()) || 0), 0) * 100,
  ) / 100;

  console.log('\n[reconcile_export] Platform comparison:');
  console.log(`  - tenant: ${tenantSlug} (${tenantId})`);
  console.log(`  - shopify_daily_sales.refunds_excl_tax: ${(daily?.refunds_excl_tax ?? 0).toFixed(2)}`);
  console.log(`  - shopify_sales_transactions RETURN sum: ${txReturns.toFixed(2)}`);
  console.log(`  - export Returns magnitude (neg only): ${returnsMagnitudeFromNegatives.toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


