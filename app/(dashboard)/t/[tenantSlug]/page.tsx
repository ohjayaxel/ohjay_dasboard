import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getKpiDaily } from '@/lib/data/agg'
import { resolveTenantId } from '@/lib/tenants/resolve-tenant'

export const revalidate = 60

type PageProps = {
  params: Promise<{ tenantSlug: string }>
}

export default async function TenantOverviewPage(props: PageProps) {
  const { tenantSlug } = await props.params
  const tenantId = await resolveTenantId(tenantSlug)

  const today = new Date()
  const startWindow = new Date(today)
  startWindow.setDate(startWindow.getDate() - 29)

  const from = startWindow.toISOString().slice(0, 10)
  const to = today.toISOString().slice(0, 10)

  const { totals, series } = await getKpiDaily({ tenantId, from, to })
  const latest = series.at(-1)

  const formatCurrency = (value: number | null) =>
    value !== null && Number.isFinite(value)
      ? new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0,
        }).format(value)
      : '—'

  const formatNumber = (value: number) =>
    Number.isFinite(value) ? new Intl.NumberFormat().format(value) : '0'

  const formatRatio = (value: number | null) =>
    value === null || Number.isNaN(value) ? '—' : value.toFixed(2)

  const cards: Array<{ label: string; value: string }> = [
    { label: 'Total Spend', value: formatCurrency(totals.spend) },
    { label: 'Total Revenue', value: formatCurrency(totals.revenue) },
    { label: 'ROAS', value: formatRatio(totals.roas) },
    { label: 'COS', value: formatRatio(totals.cos) },
    { label: 'Conversions', value: formatNumber(totals.conversions) },
    { label: 'Clicks', value: formatNumber(totals.clicks) },
  ]

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {cards.map((item) => (
          <Card key={item.label}>
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

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Daily Performance (Last 30 Days)
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
                  <th className="px-4 py-2 text-left font-medium">Conversions</th>
                  <th className="px-4 py-2 text-left font-medium">ROAS</th>
                  <th className="px-4 py-2 text-left font-medium">COS</th>
                </tr>
              </thead>
              <tbody>
                {series.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                      No KPI data available in the selected window.
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
                      <td className="px-4 py-2">{formatRatio(point.cos)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {latest ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-muted-foreground">
              Latest Data Point
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {latest.date}: Spend {formatCurrency(latest.spend)}, Revenue {formatCurrency(latest.revenue)}, ROAS {formatRatio(latest.roas)}.
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

