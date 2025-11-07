import Link from 'next/link';

import { GoogleAdsConnect } from '@/components/connections/GoogleAdsConnect';
import { MetaConnect } from '@/components/connections/MetaConnect';
import { ShopifyConnect } from '@/components/connections/ShopifyConnect';
import { resolveTenantId } from '@/lib/tenants/resolve-tenant';

export const revalidate = 60;

type PageProps = {
  params: { tenantSlug: string };
};

export default async function ConnectionsSettingsPage({ params }: PageProps) {
  await resolveTenantId(params.tenantSlug);

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="text-sm text-muted-foreground">
          Manage Meta, Google Ads, and Shopify integrations for this tenant.
        </p>
      </header>

      <div className="space-y-6">
        <div className="rounded-lg border p-6">
          <MetaConnect status="disconnected" />
        </div>

        <div className="rounded-lg border p-6">
          <GoogleAdsConnect status="disconnected" />
        </div>

        <div className="rounded-lg border p-6">
          <ShopifyConnect status="disconnected" />
        </div>
      </div>

      <footer className="text-sm text-muted-foreground">
        Looking for aggregated performance? Return to the{' '}
        <Link href={`/t/${params.tenantSlug}`}>overview dashboard</Link>.
      </footer>
    </section>
  );
}

