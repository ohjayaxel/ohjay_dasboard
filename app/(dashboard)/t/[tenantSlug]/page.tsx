import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getKpiDaily, type KpiSeriesPoint, type KpiTotals } from '@/lib/data/agg'
import { resolveTenantId } from '@/lib/tenants/resolve-tenant'
import { OverviewFilters } from '@/components/tenant/overview-filters'

export const revalidate = 60

type PageProps = {
  params: Promise<{ tenantSlug: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

type MetricKey = 'spend' | 'revenue' | 'conversions' | 'clicks' | 'roas' | 'cos'

type MetricDefinition = {
  key: MetricKey
  label: string
  description?: string
  format: (value: number | null) => string
  extractTotal: (totals: KpiTotals) => number | null
  extractPoint: (point: KpiSeriesPoint) => number | null
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

  const defaultMetrics: MetricKey[] = ['spend', 'revenue', 'roas', 'cos', 'conversions', 'clicks']

  const metricsParam = rawSearchParams?.metric
  const metricsFromQuery = Array.isArray(metricsParam)
    ? metricsParam
    : typeof metricsParam === 'string'
      ? [metricsParam]
      : []

  const metricsSelection = metricsFromQuery
    .map((value) => value as MetricKey)
    .filter((value): value is MetricKey => defaultMetrics.includes(value))

  const selectedMetricKeys = metricsSelection.length > 0 ? metricsSelection : defaultMetrics

  const { totals, series, currency } = await getKpiDaily({ tenantId, from, to })
  const latest = series.at(-1)

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

  const formatNumber = (value: number | null) =>
    value !== null && Number.isFinite(value)
      ? new Intl.NumberFormat(numberLocale).format(value)
      : '0'

  const formatRatio = (value: number | null) =>
    value === null || Number.isNaN(value) ? '—' : value.toFixed(2)

  const metricDefinitions: MetricDefinition[] = [
    {
      key: 'spend',
      label: 'Spend',
      description: 'Total advertising spend',
      format: formatCurrency,
      extractTotal: (value) => value.spend,
      extractPoint: (point) => point.spend,
    },
    {
      key: 'revenue',
      label: 'Revenue',
      description: 'Attributed revenue',
      format: formatCurrency,
      extractTotal: (value) => value.revenue,
      extractPoint: (point) => point.revenue,
    },
    {
      key: 'conversions',
      label: 'Results',
      description: 'Key conversion events or purchases',
      format: (value) => formatNumber(value),
      extractTotal: (value) => value.conversions,
      extractPoint: (point) => point.conversions,
    },
    {
      key: 'clicks',
      label: 'Link clicks',
      description: 'Traffic-driving link clicks',
      format: (value) => formatNumber(value),
      extractTotal: (value) => value.clicks,
      extractPoint: (point) => point.clicks,
    },
    {
      key: 'roas',
      label: 'ROAS',
      description: 'Return on ad spend',
      format: formatRatio,
      extractTotal: (value) => value.roas,
      extractPoint: (point) => point.roas,
    },
    {
      key: 'cos',
      label: 'COS',
      description: 'Cost of sale (spend / revenue)',
      format: formatRatio,
      extractTotal: (value) => value.cos,
      extractPoint: (point) => point.cos,
    },
  ]

  const visibleMetrics = metricDefinitions.filter((metric) =>
    selectedMetricKeys.includes(metric.key),
  )

  const cards = visibleMetrics.map((metric) => ({
    key: metric.key,
    label: metric.label,
    value: metric.format(metric.extractTotal(totals)),
  }))

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-muted-foreground">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <OverviewFilters
            tenantSlug={tenantSlug}
            from={from}
            to={to}
            metricOptions={metricDefinitions.map((metric) => ({
              value: metric.key,
              label: metric.label,
              description: metric.description,
            }))}
            selectedMetrics={selectedMetricKeys}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {cards.map((item) => (
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

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Daily Performance ({from} → {to})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[500px] text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Date</th>
                  {visibleMetrics.map((metric) => (
                    <th key={metric.key} className="px-4 py-2 text-left font-medium">
                      {metric.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {series.length === 0 ? (
                  <tr>
                    <td colSpan={visibleMetrics.length + 1} className="px-4 py-6 text-center text-muted-foreground">
                      No KPI data available in the selected window.
                    </td>
                  </tr>
                ) : (
                  series.map((point) => (
                    <tr key={point.date} className="border-t">
                      <td className="px-4 py-2 font-medium">{point.date}</td>
                      {visibleMetrics.map((metric) => (
                        <td key={metric.key} className="px-4 py-2">
                          {metric.format(metric.extractPoint(point))}
                        </td>
                      ))}
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
            {latest.date}:{' '}
            {visibleMetrics
              .map((metric) => `${metric.label} ${metric.format(metric.extractPoint(latest) ?? null)}`)
              .join(', ')}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

