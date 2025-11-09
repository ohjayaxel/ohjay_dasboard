'use client';

import { useMemo, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

type ConnectActionResult = {
  redirectUrl: string;
  state?: string;
};

type AsyncAction<T = void> = () => Promise<T>;

export type MetaConnectProps = {
  status: 'connected' | 'disconnected' | 'error'
  lastSyncedAt?: string | null
  lastSyncedLabel?: string | null
  selectedAccountName?: string | null
  onConnect?: AsyncAction<ConnectActionResult>
  onDisconnect?: AsyncAction
}

export function MetaConnect({
  status,
  lastSyncedAt,
  lastSyncedLabel,
  selectedAccountName,
  onConnect,
  onDisconnect,
}: MetaConnectProps) {
  const { toast } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const formattedSync = useMemo(() => {
    if (lastSyncedLabel) {
      return lastSyncedLabel;
    }

    if (!lastSyncedAt) {
      return 'Never synced';
    }

    return lastSyncedAt;
  }, [lastSyncedAt, lastSyncedLabel]);

  const isConnected = status === 'connected';
  const accountLabel = selectedAccountName ?? 'Not set';

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
        router.refresh();
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
      <div className="flex flex-col gap-2">
        <div>
          <h3 className="text-lg font-semibold">Meta Ads</h3>
          <p className="text-sm text-muted-foreground">
            Connect a Meta Business account to sync campaign insights.
          </p>
        </div>
      </div>

      <dl className="grid gap-2 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Status</dt>
          <dd className={cn('font-medium', isConnected ? 'text-emerald-600' : 'text-muted-foreground')}>
            {isConnected ? 'Connected' : status === 'error' ? 'Error' : 'Disconnected'}
          </dd>
        </div>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <dt className="text-muted-foreground">Selected ad account</dt>
          <dd className="font-medium sm:text-right">{accountLabel}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Last synced</dt>
          <dd>{formattedSync}</dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={handleConnect}
          disabled={isPending}
          className={cn(
            isConnected && 'bg-emerald-500 text-white hover:bg-emerald-600',
          )}
        >
          {isConnected ? 'Meta Connected' : 'Connect Meta'}
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

