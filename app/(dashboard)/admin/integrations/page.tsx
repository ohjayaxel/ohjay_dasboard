import { listAdminTenants } from '@/lib/admin/tenants'

import { GoogleAdsConnect } from '@/components/connections/GoogleAdsConnect'
import { MetaConnect } from '@/components/connections/MetaConnect'
import { ShopifyConnect } from '@/components/connections/ShopifyConnect'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default async function AdminIntegrationsPage() {
  const tenants = await listAdminTenants()

  return (
    <div className="space-y-6">
      {tenants.map((tenant) => {
        const meta = tenant.connections.meta
        const google = tenant.connections.google_ads
        const shopify = tenant.connections.shopify

        return (
          <Card key={tenant.id}>
            <CardHeader>
              <CardTitle className="text-lg font-semibold">{tenant.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-8">
              <MetaConnect status={meta.status} lastSyncedAt={meta.updatedAt ?? undefined} />
              <GoogleAdsConnect status={google.status} lastSyncedAt={google.updatedAt ?? undefined} />
              <ShopifyConnect status={shopify.status} lastSyncedAt={shopify.updatedAt ?? undefined} />
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

