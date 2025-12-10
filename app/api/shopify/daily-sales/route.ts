import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { fetchShopifyDailySales, type SalesMode } from '@/lib/data/fetchers';

/**
 * GET /api/shopify/daily-sales
 * 
 * Fetches daily Shopify sales (Shopify Mode only).
 * 
 * Query parameters:
 * - tenantId (required): Tenant ID
 * - from (optional): Start date (YYYY-MM-DD)
 * - to (optional): End date (YYYY-MM-DD)
 * - mode (optional): 'shopify' (default: 'shopify', financial mode deprecated)
 * - limit (optional): Maximum number of rows to return
 * - order (optional): 'asc' | 'desc' (default: 'asc')
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const tenantId = searchParams.get('tenantId');
    const from = searchParams.get('from') || undefined;
    const to = searchParams.get('to') || undefined;
    const modeParam = searchParams.get('mode') || 'shopify';
    const limitParam = searchParams.get('limit');
    const orderParam = searchParams.get('order') || 'asc';

    if (!tenantId) {
      return NextResponse.json({ error: 'tenantId is required' }, { status: 400 });
    }

    // Validate mode (only 'shopify' supported now)
    const mode: SalesMode = 'shopify'; // Financial mode removed

    // Validate order
    const order = orderParam === 'desc' ? 'desc' : 'asc';

    // Parse limit
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;
    if (limit !== undefined && (isNaN(limit) || limit < 1)) {
      return NextResponse.json({ error: 'limit must be a positive number' }, { status: 400 });
    }

    const rows = await fetchShopifyDailySales({
      tenantId,
      from,
      to,
      mode,
      limit,
      order,
    });

    return NextResponse.json({ data: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[api/shopify/daily-sales] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}



