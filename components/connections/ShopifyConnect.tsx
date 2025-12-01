'use client';

import { useState, useMemo, useTransition, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { connectShopifyCustomAppAction, testShopifyCustomAppToken, verifyShopifyConnection } from '@/app/(dashboard)/admin/actions';

type ConnectActionResult = {
  redirectUrl: string;
};

type AsyncAction<T = void> = () => Promise<T>;

export type ShopifyConnectProps = {
  status: 'connected' | 'disconnected' | 'error';
  shopDomain?: string | null;
  lastSyncedAt?: string | null;
  tenantId: string;
  backfillSince?: string | null;
  latestJob?: {
    status: 'pending' | 'running' | 'succeeded' | 'failed';
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  };
  onConnect?: AsyncAction<ConnectActionResult>;
  onDisconnect?: AsyncAction;
};

export function ShopifyConnect({
  status,
  shopDomain,
  lastSyncedAt,
  tenantId,
  backfillSince,
  latestJob,
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
  const [connectionErrors, setConnectionErrors] = useState<string[]>([]);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifiedStatus, setVerifiedStatus] = useState<'connected' | 'error' | null>(null);
  
  // Extract tenantSlug from pathname (/admin/tenants/[tenantSlug]/integrations)
  const tenantSlugMatch = pathname.match(/\/admin\/tenants\/([^/]+)/);
  const tenantSlug = tenantSlugMatch ? tenantSlugMatch[1] : null;

  // Verify connection when status is connected
  useEffect(() => {
    if (status === 'connected') {
      setIsVerifying(true);
      verifyShopifyConnection(tenantId)
        .then((result) => {
          if (result.connected) {
            setVerifiedStatus('connected');
            setConnectionErrors([]);
          } else {
            setVerifiedStatus('error');
            setConnectionErrors(result.errors || []);
          }
        })
        .catch((error) => {
          setVerifiedStatus('error');
          setConnectionErrors([`Verification failed: ${error instanceof Error ? error.message : String(error)}`]);
        })
        .finally(() => {
          setIsVerifying(false);
        });
    } else {
      setVerifiedStatus(null);
      setConnectionErrors([]);
    }
  }, [status, tenantId]);

  // Auto-refresh page when backfill is running
  useEffect(() => {
    if (backfillStatus?.active) {
      const interval = setInterval(() => {
        router.refresh();
      }, 5000); // Refresh every 5 seconds

      return () => clearInterval(interval);
    }
  }, [backfillStatus?.active, router]);

  const statusLabel = useMemo(() => {
    // If status is connected but verification shows errors, show error
    const effectiveStatus = status === 'connected' && verifiedStatus === 'error' ? 'error' : status;
    
    switch (effectiveStatus) {
      case 'connected':
        return { label: isVerifying ? 'Verifying...' : 'Connected', variant: 'default' as const };
      case 'error':
        return { label: 'Error', variant: 'destructive' as const };
      default:
        return { label: 'Disconnected', variant: 'secondary' as const };
    }
  }, [status, verifiedStatus, isVerifying]);

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

  const backfillStatus = useMemo(() => {
    if (!backfillSince && !latestJob) {
      return null;
    }

    const isBackfilling = backfillSince !== null && latestJob?.status === 'running';
    const backfillJustFinished = backfillSince === null && latestJob?.status === 'succeeded' && latestJob.startedAt;

    if (isBackfilling && latestJob?.startedAt) {
      const startTime = new Date(latestJob.startedAt);
      const now = new Date();
      const durationMs = now.getTime() - startTime.getTime();
      const durationSeconds = Math.floor(durationMs / 1000);
      const minutes = Math.floor(durationSeconds / 60);
      const seconds = durationSeconds % 60;
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;

      let durationText = '';
      if (hours > 0) {
        durationText = `${hours}h ${mins}m`;
      } else if (minutes > 0) {
        durationText = `${minutes}m ${seconds}s`;
      } else {
        durationText = `${seconds}s`;
      }

      return {
        active: true,
        since: backfillSince,
        duration: durationText,
        status: 'running' as const,
      };
    }

    if (backfillJustFinished) {
      return {
        active: false,
        finished: true,
        status: 'succeeded' as const,
      };
    }

    if (latestJob?.status === 'failed' && backfillSince) {
      return {
        active: false,
        failed: true,
        error: latestJob.error,
        status: 'failed' as const,
      };
    }

    return null;
  }, [backfillSince, latestJob]);

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

  const handleCustomAppConnect = () => {
    startTransition(async () => {
      if (!customAppShopDomain.trim() || !customAppToken.trim()) {
        toast({
          title: 'Missing fields',
          description: 'Please enter both shop domain and access token.',
          variant: 'destructive',
        });
        return;
      }

      try {
        const formData = new FormData();
        formData.set('tenantId', tenantId);
        if (tenantSlug) {
          formData.set('tenantSlug', tenantSlug);
        }
        formData.set('shopDomain', customAppShopDomain.trim());
        formData.set('accessToken', customAppToken.trim());

        await connectShopifyCustomAppAction(formData);
        
        // Success - redirect will happen in server action
        toast({
          title: 'Connecting...',
          description: 'Setting up Shopify connection.',
        });
      } catch (error: any) {
        // NEXT_REDIRECT is expected and should be handled gracefully
        if (error?.digest === 'NEXT_REDIRECT' || error?.message === 'NEXT_REDIRECT') {
          if (tenantSlug) {
            router.push(`/admin/tenants/${tenantSlug}/integrations?status=shopify-connected`);
          } else {
            router.refresh();
          }
          return;
        }
        console.error('Failed to connect Shopify Custom App', error);
        toast({
          title: 'Connection failed',
          description: error instanceof Error ? error.message : 'Unable to connect. Please try again.',
          variant: 'destructive',
        });
      }
    });
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

      {status === 'connected' && connectionErrors.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            <div className="space-y-1">
              <p className="font-medium">Connection verification failed:</p>
              <ul className="list-disc list-inside space-y-0.5">
                {connectionErrors.map((error, idx) => (
                  <li key={idx} className="text-sm">{error}</li>
                ))}
              </ul>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {backfillStatus?.active && (
        <Alert>
          <AlertDescription>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Backfill running</p>
                <p className="text-sm text-muted-foreground">
                  Syncing orders from {backfillStatus.since} • Running for {backfillStatus.duration}
                </p>
              </div>
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-foreground"></div>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {backfillStatus?.finished && (
        <Alert variant="default">
          <AlertDescription>
            <p className="font-medium">Backfill completed successfully</p>
          </AlertDescription>
        </Alert>
      )}

      {backfillStatus?.failed && (
        <Alert variant="destructive">
          <AlertDescription>
            <div>
              <p className="font-medium">Backfill failed</p>
              {backfillStatus.error && (
                <p className="text-sm mt-1">{backfillStatus.error}</p>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}

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
              <form className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="shop-domain">Shop Domain</Label>
                  <Input
                    id="shop-domain"
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
                  <Button 
                    type="button"
                    onClick={handleCustomAppConnect}
                    disabled={isPending || !customAppShopDomain.trim() || !customAppToken.trim()}
                  >
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

