'use client';

import { useState, useMemo, useTransition } from 'react';
import { useRouter, usePathname } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { connectShopifyCustomAppAction, testShopifyCustomAppToken } from '@/app/(dashboard)/admin/actions';

type ConnectActionResult = {
  redirectUrl: string;
};

type AsyncAction<T = void> = () => Promise<T>;

export type ShopifyConnectProps = {
  status: 'connected' | 'disconnected' | 'error';
  shopDomain?: string | null;
  lastSyncedAt?: string | null;
  tenantId: string;
  onConnect?: AsyncAction<ConnectActionResult>;
  onDisconnect?: AsyncAction;
};

export function ShopifyConnect({
  status,
  shopDomain,
  lastSyncedAt,
  tenantId,
  onConnect,
  onDisconnect,
}: ShopifyConnectProps) {
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [connectionMethod, setConnectionMethod] = useState<'oauth' | 'custom_app'>('oauth');
  const [customAppShopDomain, setCustomAppShopDomain] = useState('');
  const [customAppToken, setCustomAppToken] = useState('');
  const [isTestingToken, setIsTestingToken] = useState(false);
  
  // Extract tenantSlug from pathname (/admin/tenants/[tenantSlug]/integrations)
  const tenantSlugMatch = pathname.match(/\/admin\/tenants\/([^/]+)/);
  const tenantSlug = tenantSlugMatch ? tenantSlugMatch[1] : null;

  const statusLabel = useMemo(() => {
    switch (status) {
      case 'connected':
        return { label: 'Connected', variant: 'default' as const };
      case 'error':
        return { label: 'Error', variant: 'destructive' as const };
      default:
        return { label: 'Disconnected', variant: 'secondary' as const };
    }
  }, [status]);

  const formattedSync = useMemo(() => {
    if (!lastSyncedAt) {
      return 'Never synced';
    }

    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(lastSyncedAt));
    } catch (error) {
      console.warn('Failed to format `lastSyncedAt`', error);
      return lastSyncedAt;
    }
  }, [lastSyncedAt]);

  const handleConnect = () => {
    startTransition(async () => {
      if (!onConnect) {
        toast({
          title: 'Shopify OAuth not configured yet',
          description: 'TODO: Implement server action to start Shopify OAuth flow.',
        });
        return;
      }

      try {
        const { redirectUrl } = await onConnect();
        window.location.href = redirectUrl;
      } catch (error) {
        console.error('Failed to start Shopify OAuth flow', error);
        toast({
          title: 'Unable to start Shopify OAuth',
          description: 'Please try again later or contact support.',
          variant: 'destructive',
        });
      }
    });
  };

  const handleDisconnect = () => {
    startTransition(async () => {
      if (!onDisconnect) {
        toast({
          title: 'Disconnect action missing',
          description: 'TODO: Implement server action to disconnect Shopify integration.',
        });
        return;
      }

      try {
        await onDisconnect();
        toast({
          title: 'Shopify disconnected',
          description: 'The Shopify connection has been disconnected.',
        });
        // Navigate with status query parameter if we have tenantSlug
        if (tenantSlug) {
          router.push(`/admin/tenants/${tenantSlug}/integrations?status=shopify-disconnected`);
        } else {
          router.refresh();
        }
      } catch (error: any) {
        // NEXT_REDIRECT is expected and should be handled gracefully
        if (error?.digest === 'NEXT_REDIRECT' || error?.message === 'NEXT_REDIRECT') {
          // This is expected - the server action redirected, navigate manually
          if (tenantSlug) {
            router.push(`/admin/tenants/${tenantSlug}/integrations?status=shopify-disconnected`);
          } else {
            router.refresh();
          }
          return;
        }
        console.error('Failed to disconnect Shopify connection', error);
        toast({
          title: 'Unable to disconnect',
          description: 'Please try again later or contact support.',
          variant: 'destructive',
        });
      }
    });
  };

  const handleTestToken = async () => {
    if (!customAppShopDomain.trim() || !customAppToken.trim()) {
      toast({
        title: 'Missing fields',
        description: 'Please enter both shop domain and access token.',
        variant: 'destructive',
      });
      return;
    }

    setIsTestingToken(true);
    try {
      const result = await testShopifyCustomAppToken({
        shopDomain: customAppShopDomain.trim(),
        accessToken: customAppToken.trim(),
      });

      if (result.valid) {
        toast({
          title: 'Token valid',
          description: 'The access token is valid and can connect to Shopify.',
        });
      } else {
        toast({
          title: 'Token invalid',
          description: result.error || 'The access token could not be validated.',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Failed to test token', error);
      toast({
        title: 'Test failed',
        description: 'Unable to test token. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsTestingToken(false);
    }
  };

  const handleCustomAppConnect = async (formData: FormData) => {
    formData.set('tenantId', tenantId);
    if (tenantSlug) {
      formData.set('tenantSlug', tenantSlug);
    }
    await connectShopifyCustomAppAction(formData);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">Shopify</h3>
          <p className="text-sm text-muted-foreground">
            Connect a Shopify store to sync orders and revenue metrics.
          </p>
        </div>
        <Badge variant={statusLabel.variant}>{statusLabel.label}</Badge>
      </div>

      <dl className="grid gap-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Store domain</dt>
          <dd>{shopDomain ?? 'Not set'}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Last synced</dt>
          <dd>{formattedSync}</dd>
        </div>
      </dl>

      {status === 'connected' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleConnect} disabled={isPending}>
            Reconnect Shopify
          </Button>
          <Button
            variant="outline"
            onClick={handleDisconnect}
            disabled={isPending}
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <Tabs value={connectionMethod} onValueChange={(value) => setConnectionMethod(value as 'oauth' | 'custom_app')}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="oauth">OAuth</TabsTrigger>
            <TabsTrigger value="custom_app">Custom App</TabsTrigger>
          </TabsList>
          <TabsContent value="oauth" className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="text-sm text-muted-foreground mb-4">
                Connect via OAuth to automatically authorize your Shopify store.
              </p>
              <Button onClick={handleConnect} disabled={isPending}>
                Connect via OAuth
              </Button>
            </div>
          </TabsContent>
          <TabsContent value="custom_app" className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
              <p className="text-sm text-muted-foreground">
                Connect using a Custom App access token from your Shopify Admin.
              </p>
              <form action={handleCustomAppConnect} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="shop-domain">Shop Domain</Label>
                  <Input
                    id="shop-domain"
                    name="shopDomain"
                    type="text"
                    placeholder="your-store.myshopify.com"
                    value={customAppShopDomain}
                    onChange={(e) => setCustomAppShopDomain(e.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    Enter your Shopify store domain (e.g., your-store.myshopify.com)
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="access-token">Access Token</Label>
                  <Input
                    id="access-token"
                    name="accessToken"
                    type="password"
                    placeholder="shpat_..."
                    value={customAppToken}
                    onChange={(e) => setCustomAppToken(e.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    Enter the Admin API access token from your Custom App settings
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleTestToken}
                    disabled={isTestingToken || !customAppShopDomain.trim() || !customAppToken.trim()}
                  >
                    {isTestingToken ? 'Testing...' : 'Test Connection'}
                  </Button>
                  <Button type="submit" disabled={isPending || !customAppShopDomain.trim() || !customAppToken.trim()}>
                    {isPending ? 'Connecting...' : 'Connect'}
                  </Button>
                </div>
              </form>
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

