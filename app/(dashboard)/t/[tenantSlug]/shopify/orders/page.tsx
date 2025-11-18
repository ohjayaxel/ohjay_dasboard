import { getSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveTenantId } from '@/lib/tenants/resolve-tenant'
import { OrdersTable } from '@/components/shopify/orders-table'

export const revalidate = 60

type PageProps = {
  params: Promise<{ tenantSlug: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

export default async function ShopifyOrdersPage(props: PageProps) {
  const [{ tenantSlug }, rawSearchParams] = await Promise.all([
    props.params,
    props.searchParams ?? Promise.resolve({}),
  ])
  const tenantId = await resolveTenantId(tenantSlug)

  const supabase = getSupabaseServiceClient()

  const fromParam = rawSearchParams?.from
  const toParam = rawSearchParams?.to

  // Default to last 30 days
  const today = new Date()
  const startWindow = new Date(today)
  startWindow.setDate(startWindow.getDate() - 30)

  const defaultFrom = startWindow.toISOString().slice(0, 10)
  const defaultTo = today.toISOString().slice(0, 10)

  const from = typeof fromParam === 'string' && fromParam.length > 0 ? fromParam : defaultFrom
  const to = typeof toParam === 'string' && toParam.length > 0 ? toParam : defaultTo

  // Fetch orders for the date range
  const { data: orders, error } = await supabase
    .from('shopify_orders')
    .select('*')
    .eq('tenant_id', tenantId)
    .gte('processed_at', from)
    .lte('processed_at', to)
    .order('processed_at', { ascending: false })
    .limit(1000) // Limit to avoid huge queries

  if (error) {
    console.error('Error fetching orders:', error)
  }

  const ordersWithGrossSales = (orders || []).filter(
    (o: any) => parseFloat(o.gross_sales || 0) > 0
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
          <p className="text-muted-foreground">
            Orders used for calculating gross sales ({ordersWithGrossSales.length} orders)
          </p>
        </div>
      </div>

      <OrdersTable 
        orders={orders || []} 
        from={from} 
        to={to} 
        tenantSlug={tenantSlug}
      />
    </div>
  )
}

