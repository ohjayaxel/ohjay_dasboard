import Link from 'next/link'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getKpiDaily } from '@/lib/data/agg'
import { type KpiSource } from '@/lib/data/fetchers'
import { resolveTenantId } from '@/lib/tenants/resolve-tenant'

export const revalidate = 60

type PageProps = {
  params: Promise<{ tenantSlug: string }>
}

type ChannelKey = Extract<KpiSource, 'meta' | 'google_ads'>

type ChannelDefinition = {
  key: ChannelKey
  title: string
  description: string
  href: (tenantSlug: string) => string
}

const CHANNELS: ChannelDefinition[] = [
  {
    key: 'meta',
    title: 'Meta Ads',
    description: 'Paid social performance across Facebook & Instagram',
    href: (tenantSlug) => `/t/${tenantSlug}/meta`,
  },
  {
    key: 'google_ads',
    title: 'Google Ads',
    description: 'Search & shopping performance across Google properties',
    href: (tenantSlug) => `/t/${tenantSlug}/google`,
  },
]

export default async function ChannelsPage(props: PageProps) {
  const { tenantSlug } = await props.params
  const tenantId = await resolveTenantId(tenantSlug)

  const today = new Date()
  const startWindow = new Date(today)
  startWindow.setDate(startWindow.getDate() - 29)

  const from = startWindow.toISOString().slice(0, 10)
  const to = today.toISOString().slice(0, 10)

  const channelSummaries = await Promise.all(
    CHANNELS.map(async (channel) => {
      const { totals, currency } = await getKpiDaily({
        tenantId,
        from,
        to,
        source: channel.key,
      })

      return {
        ...channel,
        href: channel.href(tenantSlug),
        totals,
        currency: currency ?? 'USD',
      }
    }),
  )

  const numberLocale = 'en-US'

  const formatCurrency = (value: number | null, currencyCode: string) =>
    value !== null && Number.isFinite(value)
      ? new Intl.NumberFormat(numberLocale, {
          style: 'currency',
          currency: currencyCode,
          maximumFractionDigits: 0,
        }).format(value)
      : '—'

  const formatNumber = (value: number | null) =>
    value !== null && Number.isFinite(value) ? new Intl.NumberFormat(numberLocale).format(value) : '0'

  const formatRatio = (value: number | null) => (value === null || Number.isNaN(value) ? '—' : value.toFixed(2))

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Channels</h1>
        <p className="text-sm text-muted-foreground">
          Snapshot of paid channels over the last 30 days. Select a channel to dig into detailed performance.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {channelSummaries.map((channel) => (
          <Card key={channel.key} className="flex flex-col">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-base font-semibold">{channel.title}</CardTitle>
                  <p className="text-sm text-muted-foreground">{channel.description}</p>
                </div>
                <Link href={channel.href} className="text-sm font-medium text-primary">
                  View
                </Link>
              </div>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col justify-between gap-4">
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">Spend</dt>
                  <dd className="font-semibold">{formatCurrency(channel.totals.spend, channel.currency)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Revenue</dt>
                  <dd className="font-semibold">{formatCurrency(channel.totals.revenue, channel.currency)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Results</dt>
                  <dd className="font-semibold">{formatNumber(channel.totals.conversions)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">ROAS</dt>
                  <dd className="font-semibold">{formatRatio(channel.totals.roas)}</dd>
                </div>
              </dl>
              <div className="text-xs text-muted-foreground">Window: {from} → {to}</div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}


