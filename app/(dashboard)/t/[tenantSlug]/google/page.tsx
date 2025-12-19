import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getKpiDaily } from '@/lib/data/agg'
import { resolveTenantId } from '@/lib/tenants/resolve-tenant'
import { GoogleTable } from '@/components/tenant/google-table'

export const revalidate = 60

type PageProps = {
  params: Promise<{ tenantSlug: string }>
}

export default async function GoogleAdsDashboardPage(props: PageProps) {
  const { tenantSlug } = await props.params
  const tenantId = await resolveTenantId(tenantSlug)

  const today = new Date()
  const startWindow = new Date(today)
  startWindow.setDate(startWindow.getDate() - 29)

  const from = startWindow.toISOString().slice(0, 10)
  const to = today.toISOString().slice(0, 10)

  const { totals, series, currency } = await getKpiDaily({ tenantId, from, to, source: 'google_ads' })

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
            <CardTitle className="text-sm font-medium text-muted-foreground">Conversions</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tracking-tight">{formatNumber(totals.conversions)}</p>
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
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Daily Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          <GoogleTable data={series} currencyCode={currencyCode} numberLocale={numberLocale} />
        </CardContent>
      </Card>
    </div>
  )
}

