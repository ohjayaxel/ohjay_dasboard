import Link from 'next/link'

import { GoogleAdsConnect } from '@/components/connections/GoogleAdsConnect'
import { MetaConnect } from '@/components/connections/MetaConnect'
import { ShopifyConnect } from '@/components/connections/ShopifyConnect'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { resolveTenantId } from '@/lib/tenants/resolve-tenant'

export const revalidate = 60

type PageProps = {
  params: Promise<{ tenantSlug: string }>
}

export default async function ConnectionsSettingsPage(props: PageProps) {
  const { tenantSlug } = await props.params
  await resolveTenantId(tenantSlug)

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Meta Ads Connection</CardTitle>
        </CardHeader>
        <CardContent>
          <MetaConnect status="disconnected" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Google Ads Connection</CardTitle>
        </CardHeader>
        <CardContent>
          <GoogleAdsConnect status="disconnected" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Shopify Connection</CardTitle>
        </CardHeader>
        <CardContent>
          <ShopifyConnect status="disconnected" />
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        Looking for aggregated performance? Return to the{' '}
        <Link href={`/t/${tenantSlug}`} className="underline">
          overview dashboard
        </Link>
        .
      </p>
    </div>
  )
}

