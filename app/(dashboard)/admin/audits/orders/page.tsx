import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { OrdersTable } from '@/components/shopify/orders-table'
import { ShopifyDailySalesTable } from '@/components/shopify/shopify-daily-sales-table'
import { listAdminTenants } from '@/lib/admin/tenants'
import { requirePlatformAdmin } from '@/lib/auth/current-user'
import { TenantSelector } from '@/components/admin/tenant-selector'

export const revalidate = 60

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

type DateDimension = 'processed_at' | 'created_at' | 'created_at_ts' | 'updated_at'
type IdDimension = 'order_id' | 'order_number'
type GroupBy = 'date_order' | 'date' | 'order'

function coerceDateDimension(value: unknown): DateDimension {
  if (value === 'created_at' || value === 'created_at_ts' || value === 'updated_at') return value
  return 'processed_at'
}

function coerceIdDimension(value: unknown): IdDimension {
  if (value === 'order_number') return 'order_number'
  return 'order_id'
}

function coerceGroupBy(value: unknown): GroupBy {
  if (value === 'date' || value === 'order') return value
  return 'date_order'
}

type ShopifySalesTransactionRow = {
  shopify_order_id: string
  shopify_order_number: number | null
  event_date: string // YYYY-MM-DD
  gross_sales: number | null
  discounts: number | null
  returns: number | null
  currency: string | null
}

async function fetchAllShopifySalesTransactionsForRange(params: {
  supabase: ReturnType<typeof getSupabaseServiceClient>
  tenantId: string
  from: string
  to: string
  maxRows?: number
}) {
  const maxRows = params.maxRows ?? 50000
  const PAGE_SIZE = 5000

  const all: ShopifySalesTransactionRow[] = []
  let offset = 0

  while (all.length < maxRows) {
    const { data, error } = await params.supabase
      .from('shopify_sales_transactions')
      .select('shopify_order_id,shopify_order_number,event_date,gross_sales,discounts,returns,currency')
      .eq('tenant_id', params.tenantId)
      .gte('event_date', params.from)
      .lte('event_date', params.to)
      .order('event_date', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) throw error

    const batch = (data as ShopifySalesTransactionRow[]) ?? []
    all.push(...batch)

    if (batch.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return all
}

function buildSyntheticOrdersFromTransactions(rows: ShopifySalesTransactionRow[]) {
  // Build one row per (event_date, shopify_order_id) with:
  // net = gross - discounts - returns
  const map = new Map<string, any>()

  for (const r of rows) {
    const orderId = r.shopify_order_id
    const date = r.event_date
    const key = `${date}|${orderId}`

    const existing =
      map.get(key) ??
      ({
        order_id: orderId,
        order_number: r.shopify_order_number ?? null,
        processed_at: date,
        created_at: date,
        gross_sales: 0,
        net_sales: 0,
        total_tax: 0,
        total_sales: 0,
        tax: 0,
        discount: 0,
        refunds: 0,
        currency: r.currency ?? null,
        financial_status: null,
        fulfillment_status: null,
        source_name: null,
        is_refund: false,
      } as any)

    const gross = Number(r.gross_sales ?? 0) || 0
    const discounts = Number(r.discounts ?? 0) || 0
    const returns = Number(r.returns ?? 0) || 0

    existing.gross_sales += gross
    existing.discount += discounts
    existing.refunds += returns
    existing.net_sales = existing.gross_sales - existing.discount - existing.refunds

    // Mark refund rows so they don't look like "orders"
    if (existing.gross_sales <= 0 && existing.refunds > 0) {
      existing.is_refund = true
    }

    if (!existing.currency && r.currency) existing.currency = r.currency
    map.set(key, existing)
  }

  return Array.from(map.values())
}

async function supportsShopifyOrdersColumn(params: {
  supabase: ReturnType<typeof getSupabaseServiceClient>
  tenantId: string
  column: string
}): Promise<boolean> {
  try {
    const { error } = await params.supabase
      .from('shopify_orders')
      .select(params.column)
      .eq('tenant_id', params.tenantId)
      .limit(1)
    if (error && (error as any).code === '42703') {
      return false
    }
    return !error
  } catch {
    return false
  }
}

async function fetchAllShopifyOrdersForRange(params: {
  supabase: ReturnType<typeof getSupabaseServiceClient>
  tenantId: string
  dateField: DateDimension
  from: string
  to: string
  maxRows?: number
}) {
  const { supabase, tenantId, dateField } = params
  const maxRows = params.maxRows ?? 20000
  const PAGE_SIZE = 1000

  const fromValue =
    dateField === 'created_at_ts' || dateField === 'updated_at'
      ? `${params.from}T00:00:00.000Z`
      : params.from
  const toValue =
    dateField === 'created_at_ts' || dateField === 'updated_at'
      ? `${params.to}T23:59:59.999Z`
      : params.to

  const all: any[] = []
  let offset = 0

  // Select only what the UI needs; avoids transferring huge JSON columns for audits.
  const selectCols = [
    'tenant_id',
    'order_id',
    'processed_at',
    'created_at',
    'gross_sales',
    'net_sales',
    'total_tax',
    'total_sales',
    'tax',
    'discount',
    'refunds',
    'currency',
    'financial_status',
    'fulfillment_status',
    'source_name',
    'is_refund',
  ].join(',')

  while (all.length < maxRows) {
    const { data, error } = await supabase
      .from('shopify_orders')
      .select(selectCols)
      .eq('tenant_id', tenantId)
      .gte(dateField, fromValue)
      .lte(dateField, toValue)
      .order(dateField, { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) {
      throw error
    }

    const batch = data ?? []
    all.push(...batch)

    if (batch.length < PAGE_SIZE) {
      break
    }

    offset += PAGE_SIZE
  }

  return all
}

export default async function AdminOrdersPage(props: PageProps) {
  await requirePlatformAdmin()
  const rawSearchParams = await (props.searchParams ?? Promise.resolve({}))
  const supabase = getSupabaseServiceClient()
  const tenants = await listAdminTenants()

  const fromParam = rawSearchParams?.from
  const toParam = rawSearchParams?.to
  const tenantParam = rawSearchParams?.tenant
  const dateFieldParam = rawSearchParams?.dateField
  const idFieldParam = rawSearchParams?.idField
  const groupByParam = rawSearchParams?.groupBy

  // Default to last 30 days
  const today = new Date()
  const startWindow = new Date(today)
  startWindow.setDate(startWindow.getDate() - 30)

  const defaultFrom = startWindow.toISOString().slice(0, 10)
  const defaultTo = today.toISOString().slice(0, 10)

  const from = typeof fromParam === 'string' && fromParam.length > 0 ? fromParam : defaultFrom
  const to = typeof toParam === 'string' && toParam.length > 0 ? toParam : defaultTo
  const selectedTenantId = typeof tenantParam === 'string' && tenantParam.length > 0 ? tenantParam : null
  const dateField = coerceDateDimension(typeof dateFieldParam === 'string' ? dateFieldParam : undefined)
  const idField = coerceIdDimension(typeof idFieldParam === 'string' ? idFieldParam : undefined)
  const groupBy = coerceGroupBy(typeof groupByParam === 'string' ? groupByParam : undefined)

  let orders: any[] = []
  let dailyRows: any[] = []
  let selectedTenant = tenants.find((t) => t.id === selectedTenantId) ?? null
  let supportsUpdatedAt = false
  let supportsCreatedAtTs = false
  let effectiveDateField: DateDimension = dateField

  if (selectedTenantId && selectedTenant) {
    // Fetch for selected tenant
    try {
      // Some environments don't have updated_at / created_at_ts columns on shopify_orders.
      // Detect support and fall back to processed_at to avoid hard failures.
      supportsUpdatedAt = await supportsShopifyOrdersColumn({
        supabase,
        tenantId: selectedTenantId,
        column: 'updated_at',
      })
      supportsCreatedAtTs = await supportsShopifyOrdersColumn({
        supabase,
        tenantId: selectedTenantId,
        column: 'created_at_ts',
      })

      if (effectiveDateField === 'updated_at' && !supportsUpdatedAt) {
        effectiveDateField = 'processed_at'
      }
      if (effectiveDateField === 'created_at_ts' && !supportsCreatedAtTs) {
        effectiveDateField = 'created_at'
      }

      if (groupBy === 'date') {
        // Date-only view should match Shopify Analytics: returns are allocated by refund date.
        // shopify_daily_sales (mode='shopify') is the canonical daily table for this.
        const { data, error } = await supabase
          .from('shopify_daily_sales')
          .select(
            'date, gross_sales_excl_tax, discounts_excl_tax, refunds_excl_tax, net_sales_excl_tax, orders_count, currency',
          )
          .eq('tenant_id', selectedTenantId)
          .eq('mode', 'shopify')
          .gte('date', from)
          .lte('date', to)
          .order('date', { ascending: false })

        if (error) throw error
        dailyRows = data ?? []
      } else if (groupBy === 'date_order') {
        // Date + Order should mirror Shopify Analytics "Day" behavior:
        // show both SALE rows (order day) and RETURN rows (refund day) per order.
        const txRows = await fetchAllShopifySalesTransactionsForRange({
          supabase,
          tenantId: selectedTenantId,
          from,
          to,
        })
        orders = buildSyntheticOrdersFromTransactions(txRows)
      } else {
        orders = await fetchAllShopifyOrdersForRange({
          supabase,
          tenantId: selectedTenantId,
          dateField: effectiveDateField,
          from,
          to,
        })
      }
    } catch (error) {
      console.error('Error fetching orders:', error)
      orders = []
      dailyRows = []
    }
  }

  const ordersWithGrossSales = orders.filter(
    (o: any) => parseFloat(o.gross_sales || 0) > 0
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
          <p className="text-muted-foreground">
            {selectedTenant
              ? `Orders for ${selectedTenant.name} used for calculating gross sales (${ordersWithGrossSales.length} orders)`
              : 'Select a tenant to view orders'}
          </p>
        </div>
      </div>

      <TenantSelector
        tenants={tenants}
        selectedTenantId={selectedTenantId}
        from={from}
        to={to}
        baseUrl="/admin/audits/orders"
      />

      {selectedTenant && groupBy === 'date' && dailyRows.length > 0 ? (
        <ShopifyDailySalesTable
          rows={dailyRows as any}
          from={from}
          to={to}
          supportsUpdatedAt={supportsUpdatedAt}
          supportsCreatedAtTs={supportsCreatedAtTs}
        />
      ) : selectedTenant && groupBy !== 'date' && orders.length > 0 ? (
        <OrdersTable
          orders={orders}
          from={from}
          to={to}
          tenantSlug={selectedTenant.slug}
          dateField={effectiveDateField}
          idField={idField}
          supportsUpdatedAt={supportsUpdatedAt}
          supportsCreatedAtTs={supportsCreatedAtTs}
          groupBy={groupBy}
        />
      ) : selectedTenant && orders.length === 0 && dailyRows.length === 0 ? (
        <div className="text-center text-muted-foreground py-8">
          No orders found for the selected date range.
        </div>
      ) : null}
    </div>
  )
}
