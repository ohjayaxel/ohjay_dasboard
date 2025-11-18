import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getOverviewData, type OverviewTotals } from '@/lib/data/agg'
import { resolveTenantId } from '@/lib/tenants/resolve-tenant'
import { OverviewTable } from '@/components/tenant/overview-table'
import { OverviewChart } from '@/components/tenant/overview-chart'

export const revalidate = 60

type PageProps = {
  params: Promise<{ tenantSlug: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

export default async function TenantOverviewPage(props: PageProps) {
  const [{ tenantSlug }, rawSearchParams] = await Promise.all([
    props.params,
    props.searchParams ?? Promise.resolve({}),
  ])

  const tenantId = await resolveTenantId(tenantSlug)

  const today = new Date()
  const startWindow = new Date(today)
  startWindow.setDate(startWindow.getDate() - 29)

  const defaultFrom = startWindow.toISOString().slice(0, 10)
  const defaultTo = today.toISOString().slice(0, 10)

  const fromParam = rawSearchParams?.from
  const toParam = rawSearchParams?.to

  const from = typeof fromParam === 'string' && fromParam.length > 0 ? fromParam : defaultFrom
  const to = typeof toParam === 'string' && toParam.length > 0 ? toParam : defaultTo

  const { series, totals, currency } = await getOverviewData({ tenantId, from, to })

  // Use Swedish locale for SEK, otherwise fallback to en-US
  const currencyCode = currency ?? 'SEK' // Default to SEK for Swedish stores
  const numberLocale = currencyCode === 'SEK' ? 'sv-SE' : 'en-US'

  const formatCurrency = (value: number | null) =>
    value !== null && Number.isFinite(value)
      ? new Intl.NumberFormat(numberLocale, {
          style: 'currency',
          currency: currencyCode,
          maximumFractionDigits: 0,
        }).format(value)
      : '—'

  const formatNumber = (value: number | null) =>
    value !== null && Number.isFinite(value)
      ? new Intl.NumberFormat(numberLocale).format(value)
      : '0'

  const formatRatio = (value: number | null) =>
    value === null || Number.isNaN(value) ? '—' : value.toFixed(2)

  const metricCards = [
    {
      key: 'gross_sales',
      label: 'Gross Sales',
      value: formatCurrency(totals.gross_sales),
    },
    {
      key: 'net_sales',
      label: 'Net Sales',
      value: formatCurrency(totals.net_sales),
    },
    {
      key: 'new_customer_net_sales',
      label: 'New Customer Net Sales',
      value: formatCurrency(totals.new_customer_net_sales),
    },
    {
      key: 'marketing_spend',
      label: 'Marketing Spend',
      value: formatCurrency(totals.marketing_spend),
    },
    {
      key: 'amer',
      label: 'aMER',
      value: formatRatio(totals.amer),
    },
    {
      key: 'orders',
      label: 'Orders',
      value: formatNumber(totals.orders),
    },
    {
      key: 'aov',
      label: 'AOV',
      value: formatCurrency(totals.aov),
    },
  ]

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {metricCards.map((item) => (
          <Card key={item.key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {item.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tracking-tight">{item.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <OverviewChart
        data={series}
        formatCurrency={formatCurrency}
        formatNumber={formatNumber}
        formatRatio={formatRatio}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Daily Performance ({from} → {to})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <OverviewTable
            data={series}
            formatCurrency={formatCurrency}
            formatNumber={formatNumber}
            formatRatio={formatRatio}
          />
        </CardContent>
      </Card>
    </div>
  )
}
