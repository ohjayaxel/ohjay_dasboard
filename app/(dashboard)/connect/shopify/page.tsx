import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';

import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { isPlatformAdmin } from '@/lib/auth/roles';
import { startShopifyConnect } from '@/app/(dashboard)/admin/actions';
import { getShopifyAuthorizeUrl } from '@/lib/integrations/shopify';
import { createHmac } from 'crypto';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';

type PageProps = {
  searchParams?: Promise<{
    shop?: string;
    error?: string;
  }>;
};

function normalizeShopDomain(domain: string): string {
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

export default async function ConnectShopifyPage(props: PageProps) {
  const searchParams = await (props.searchParams ?? Promise.resolve({}));
  const shop = searchParams?.shop;

  if (!shop) {
    return (
      <div className="container mx-auto max-w-2xl py-8">
        <Alert variant="destructive">
          <AlertDescription>Missing shop parameter. Please provide a shop domain.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const normalizedShop = normalizeShopDomain(shop);
  const user = await getCurrentUser();
  const client = getSupabaseServiceClient();

  // Hämta tenants som användaren har access till
  let tenantsQuery = client
    .from('tenants')
    .select(
      `
      id,
      name,
      slug,
      members!inner(user_id, role),
      connections!left(
        id,
        source,
        status,
        meta
      )
    `,
    )
    .eq('members.user_id', user.id);

  let tenantsData;
  if (isPlatformAdmin(user.role)) {
    // Platform admins får alla tenants
    const { data: allTenants, error: allError } = await client
      .from('tenants')
      .select(
        `
        id,
        name,
        slug,
        members(user_id, role),
        connections!left(
          id,
          source,
          status,
          meta
        )
      `,
      )
      .order('name');

    if (allError) {
      throw new Error(`Failed to fetch tenants: ${allError.message}`);
    }
    tenantsData = allTenants ?? [];
  } else {
    // Vanliga användare får bara tenants de är medlem i
    const { data: userTenants, error: userError } = await tenantsQuery;

    if (userError) {
      throw new Error(`Failed to fetch tenants: ${userError.message}`);
    }
    tenantsData = userTenants ?? [];
  }

  // Filtrera ut duplicerade tenants (pga inner join)
  const uniqueTenants = tenantsData.reduce((acc, tenant: any) => {
    if (!acc.find((t: any) => t.id === tenant.id)) {
      acc.push(tenant);
    }
    return acc;
  }, [] as any[]);

  // Formatera tenants med Shopify connection status
  const tenants = uniqueTenants.map((tenant: any) => {
    const shopifyConnection = tenant.connections?.find((c: any) => c.source === 'shopify');
    const connectedShopDomain = shopifyConnection?.meta?.store_domain || null;
    const isConnected = shopifyConnection?.status === 'connected';
    const isThisShop = isConnected && connectedShopDomain === normalizedShop;

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      isConnected,
      connectedShopDomain,
      isThisShop,
    };
  });

  // Kontrollera om shop redan är kopplad till en tenant
  const { data: existingConnection } = await client
    .from('connections')
    .select('tenant_id, meta')
    .eq('source', 'shopify')
    .eq('status', 'connected')
    .eq('meta->>store_domain', normalizedShop)
    .maybeSingle();

  if (existingConnection) {
    const { data: existingTenant } = await client
      .from('tenants')
      .select('slug, name')
      .eq('id', existingConnection.tenant_id)
      .maybeSingle();

    if (existingTenant) {
      return (
        <div className="container mx-auto max-w-2xl py-8">
          <Card>
            <CardHeader>
              <CardTitle>Shopify Store Already Connected</CardTitle>
              <CardDescription>
                The store <code className="text-sm">{normalizedShop}</code> is already connected to an account.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border bg-muted/50 p-4">
                <p className="text-sm font-medium">Connected to:</p>
                <p className="text-lg font-semibold">{existingTenant.name}</p>
                <p className="text-sm text-muted-foreground">/{existingTenant.slug}</p>
              </div>
              <div className="flex gap-2">
                <Button asChild>
                  <Link href={`/admin/tenants/${existingTenant.slug}/integrations`}>
                    Go to Integrations
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/admin">Back to Admin</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }
  }

  if (tenants.length === 0) {
    return (
      <div className="container mx-auto max-w-2xl py-8">
        <Card>
          <CardHeader>
            <CardTitle>No Access</CardTitle>
            <CardDescription>
              You don't have access to any tenant accounts. Please contact your administrator.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/admin">Back to Admin</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Om bara en tenant, auto-redirect till OAuth
  if (tenants.length === 1 && !tenants[0].isThisShop) {
    const tenant = tenants[0];
    if (!ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY environment variable is required');
    }

    // Skapa signed state
    const stateData = {
      tenantId: tenant.id,
      shopDomain: normalizedShop,
      userId: user.id,
      timestamp: Date.now(),
      nonce: crypto.randomUUID(),
    };

    const statePayload = JSON.stringify(stateData);
    const signature = createHmac('sha256', ENCRYPTION_KEY).update(statePayload).digest('hex');

    const state = Buffer.from(
      JSON.stringify({
        data: stateData,
        sig: signature,
      }),
    ).toString('base64');

    // Hämta OAuth URL
    const { url } = await getShopifyAuthorizeUrl({
      tenantId: tenant.id,
      shopDomain: normalizedShop,
      state,
    });

    redirect(url);
  }

  return (
    <div className="container mx-auto max-w-2xl py-8">
      <Card>
        <CardHeader>
          <CardTitle>Connect Shopify Store</CardTitle>
          <CardDescription>
            Select which account the store <code className="text-sm">{normalizedShop}</code> should be connected to.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {user && (
            <div className="rounded-lg border bg-blue-50 p-4 dark:bg-blue-950">
              <p className="text-sm text-blue-900 dark:text-blue-100">
                Logged in as: <strong>{user.email}</strong>
                {isPlatformAdmin(user.role) && (
                  <Badge variant="outline" className="ml-2">
                    Platform Admin
                  </Badge>
                )}
              </p>
            </div>
          )}

          <div className="space-y-3">
            {tenants.map((tenant) => (
              <form
                key={tenant.id}
                action={startShopifyConnect.bind(null, tenant.id, normalizedShop)}
              >
                <div className="rounded-lg border p-4 hover:bg-muted/50">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold">{tenant.name}</h3>
                        {tenant.isConnected && (
                          <Badge variant="secondary">
                            {tenant.isThisShop ? 'This shop' : 'Connected'}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">/{tenant.slug}</p>
                      {tenant.connectedShopDomain && !tenant.isThisShop && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Connected to: {tenant.connectedShopDomain}
                        </p>
                      )}
                    </div>
                    <Button
                      type="submit"
                      disabled={tenant.isThisShop}
                      variant={tenant.isThisShop ? 'secondary' : 'default'}
                    >
                      {tenant.isThisShop ? 'Already Connected' : 'Connect'}
                    </Button>
                  </div>
                </div>
              </form>
            ))}
          </div>

          <div className="border-t pt-4">
            <Button asChild variant="outline">
              <Link href="/admin">Back to Admin</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

