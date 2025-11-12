import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getKpiDaily } from '@/lib/data/agg'
import { resolveTenantId } from '@/lib/tenants/resolve-tenant'

export const revalidate = 60

type PageProps = {
  params: Promise<{ tenantSlug: string }>
}

export default async function MetaDashboardPage(props: PageProps) {
  const { tenantSlug } = await props.params
  const tenantId = await resolveTenantId(tenantSlug)

  const today = new Date()
  const startWindow = new Date(today)
  startWindow.setDate(startWindow.getDate() - 29)

  const from = startWindow.toISOString().slice(0, 10)
  const to = today.toISOString().slice(0, 10)

  const { totals, series, currency } = await getKpiDaily({ tenantId, from, to, source: 'meta' })

  const numberLocale = 'en-US'
  const currencyCode = currency ?? 'USD'

  const formatCurrency = (value: number | null) =>
    value !== null && Number.isFinite(value)
      ? new Intl.NumberFormat(numberLocale, {
          style: 'currency',
          currency: currencyCode,
          maximumFractionDigits: 0,
        }).format(value)
      : '—'

  const formatRatio = (value: number | null) =>
    value === null || Number.isNaN(value) ? '—' : value.toFixed(2)

  const formatNumber = (value: number) =>
    Number.isFinite(value) ? new Intl.NumberFormat(numberLocale).format(value) : '0'

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Spend</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tracking-tight">{formatCurrency(totals.spend)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Revenue</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tracking-tight">{formatCurrency(totals.revenue)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">ROAS</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tracking-tight">{formatRatio(totals.roas)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Results</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tracking-tight">{formatNumber(totals.conversions)}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Daily Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Date</th>
                  <th className="px-4 py-2 text-left font-medium">Spend</th>
                  <th className="px-4 py-2 text-left font-medium">Revenue</th>
                  <th className="px-4 py-2 text-left font-medium">Results</th>
                  <th className="px-4 py-2 text-left font-medium">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {series.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                      No Meta KPI data available.
                    </td>
                  </tr>
                ) : (
                  series.map((point) => (
                    <tr key={point.date} className="border-t">
                      <td className="px-4 py-2 font-medium">{point.date}</td>
                      <td className="px-4 py-2">{formatCurrency(point.spend)}</td>
                      <td className="px-4 py-2">{formatCurrency(point.revenue)}</td>
                      <td className="px-4 py-2">{formatNumber(point.conversions)}</td>
                      <td className="px-4 py-2">{formatRatio(point.roas)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

