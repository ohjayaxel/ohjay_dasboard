import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { OrdersTable } from '@/components/shopify/orders-table'
import { listAdminTenants } from '@/lib/admin/tenants'
import { requirePlatformAdmin } from '@/lib/auth/current-user'
import { TenantSelector } from '@/components/admin/tenant-selector'

export const revalidate = 60

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

export default async function AdminOrdersPage(props: PageProps) {
  await requirePlatformAdmin()
  const rawSearchParams = await (props.searchParams ?? Promise.resolve({}))
  const supabase = getSupabaseServiceClient()
  const tenants = await listAdminTenants()

  const fromParam = rawSearchParams?.from
  const toParam = rawSearchParams?.to
  const tenantParam = rawSearchParams?.tenant

  // Default to last 30 days
  const today = new Date()
  const startWindow = new Date(today)
  startWindow.setDate(startWindow.getDate() - 30)

  const defaultFrom = startWindow.toISOString().slice(0, 10)
  const defaultTo = today.toISOString().slice(0, 10)

  const from = typeof fromParam === 'string' && fromParam.length > 0 ? fromParam : defaultFrom
  const to = typeof toParam === 'string' && toParam.length > 0 ? toParam : defaultTo
  const selectedTenantId = typeof tenantParam === 'string' && tenantParam.length > 0 ? tenantParam : null

  let orders: any[] = []
  let selectedTenant = tenants.find((t) => t.id === selectedTenantId) ?? null

  if (selectedTenantId && selectedTenant) {
    // Fetch orders for selected tenant
    const { data, error } = await supabase
      .from('shopify_orders')
      .select('*')
      .eq('tenant_id', selectedTenantId)
      .gte('processed_at', from)
      .lte('processed_at', to)
      .order('processed_at', { ascending: false })
      .limit(1000)

    if (error) {
      console.error('Error fetching orders:', error)
    } else {
      orders = data || []
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

      {selectedTenant && orders.length > 0 ? (
        <OrdersTable
          orders={orders}
          from={from}
          to={to}
          tenantSlug={selectedTenant.slug}
        />
      ) : selectedTenant && orders.length === 0 ? (
        <div className="text-center text-muted-foreground py-8">
          No orders found for the selected date range.
        </div>
      ) : null}
    </div>
  )
}
