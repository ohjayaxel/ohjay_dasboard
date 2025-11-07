'use client';

import { useMemo, useTransition } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

type ConnectActionResult = {
  redirectUrl: string;
};

type AsyncAction<T = void> = () => Promise<T>;

export type MetaConnectProps = {
  status: 'connected' | 'disconnected' | 'error';
  lastSyncedAt?: string | null;
  onConnect?: AsyncAction<ConnectActionResult>;
  onDisconnect?: AsyncAction;
};

export function MetaConnect({ status, lastSyncedAt, onConnect, onDisconnect }: MetaConnectProps) {
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
          title: 'Meta OAuth not configured yet',
          description: 'TODO: Implement server action to start Meta OAuth flow.',
        });
        return;
      }

      try {
        const { redirectUrl } = await onConnect();
        window.location.href = redirectUrl;
      } catch (error) {
        console.error('Failed to start Meta OAuth flow', error);
        toast({
          title: 'Unable to start Meta OAuth',
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
          description: 'TODO: Implement server action to disconnect Meta integration.',
        });
        return;
      }

      try {
        await onDisconnect();
        toast({
          title: 'Meta disconnected',
          description: 'The Meta connection has been disconnected.',
        });
      } catch (error) {
        console.error('Failed to disconnect Meta connection', error);
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
          <h3 className="text-lg font-semibold">Meta Ads</h3>
          <p className="text-sm text-muted-foreground">
            Connect a Meta Business account to sync campaign insights.
          </p>
        </div>
        <Badge variant={statusLabel.variant}>{statusLabel.label}</Badge>
      </div>

      <dl className="grid gap-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Last synced</dt>
          <dd>{formattedSync}</dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleConnect} disabled={isPending || status === 'connected'}>
          {status === 'connected' ? 'Reconnect Meta' : 'Connect Meta'}
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

