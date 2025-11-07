'use client';

import { useMemo, useTransition } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

type ConnectActionResult = {
  redirectUrl: string;
};

type AsyncAction<T = void> = () => Promise<T>;

export type GoogleAdsConnectProps = {
  status: 'connected' | 'disconnected' | 'error';
  customerId?: string | null;
  lastSyncedAt?: string | null;
  onConnect?: AsyncAction<ConnectActionResult>;
  onDisconnect?: AsyncAction;
};

export function GoogleAdsConnect({
  status,
  customerId,
  lastSyncedAt,
  onConnect,
  onDisconnect,
}: GoogleAdsConnectProps) {
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

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
          title: 'Google Ads OAuth not configured yet',
          description: 'TODO: Implement server action to start Google OAuth flow.',
        });
        return;
      }

      try {
        const { redirectUrl } = await onConnect();
        window.location.href = redirectUrl;
      } catch (error) {
        console.error('Failed to start Google Ads OAuth flow', error);
        toast({
          title: 'Unable to start Google Ads OAuth',
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
          description: 'TODO: Implement server action to disconnect Google Ads integration.',
        });
        return;
      }

      try {
        await onDisconnect();
        toast({
          title: 'Google Ads disconnected',
          description: 'The Google Ads connection has been disconnected.',
        });
      } catch (error) {
        console.error('Failed to disconnect Google Ads connection', error);
        toast({
          title: 'Unable to disconnect',
          description: 'Please try again later or contact support.',
          variant: 'destructive',
        });
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">Google Ads</h3>
          <p className="text-sm text-muted-foreground">
            Connect a Google Ads manager or customer account to sync insights.
          </p>
        </div>
        <Badge variant={statusLabel.variant}>{statusLabel.label}</Badge>
      </div>

      <dl className="grid gap-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Customer ID</dt>
          <dd>{customerId ?? 'Not set'}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Last synced</dt>
          <dd>{formattedSync}</dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleConnect} disabled={isPending || status === 'connected'}>
          {status === 'connected' ? 'Reconnect Google Ads' : 'Connect Google Ads'}
        </Button>
        <Button
          variant="outline"
          onClick={handleDisconnect}
          disabled={isPending || status !== 'connected'}
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}

