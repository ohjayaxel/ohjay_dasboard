import { NextResponse } from 'next/server';

import { formatTokenExpirationWarning, sendSlackMessage } from '@/lib/notifications/slack';
import { getSupabaseServiceClient } from '@/lib/supabase/server';

const TOKEN_EXPIRATION_WARNING_HOURS = 24; // Warn if token expires within 24 hours
const SLACK_ALERTS_ENABLED = process.env.SLACK_WEBHOOK_URL !== undefined;

async function handleRequest(request: Request) {
  try {
    const client = getSupabaseServiceClient();

    // Get all active connections
    const { data: connections, error: connectionsError } = await client
      .from('connections')
      .select('id, tenant_id, source, expires_at')
      .eq('status', 'connected')
      .not('expires_at', 'is', null);

    if (connectionsError) {
      throw new Error(`Failed to fetch connections: ${connectionsError.message}`);
    }

    const warnings: Array<{
      source: string;
      tenantId: string;
      tenantName?: string;
      expiresAt: string;
      hoursUntilExpiration: number;
    }> = [];

    const now = new Date();
    const warningThreshold = new Date(now.getTime() + TOKEN_EXPIRATION_WARNING_HOURS * 60 * 60 * 1000);

    if (connections && connections.length > 0) {
      // Get tenant names for better context
      const tenantIds = new Set<string>(connections.map(c => c.tenant_id));
      const { data: tenants } = await client
        .from('tenants')
        .select('id, name')
        .in('id', Array.from(tenantIds));

      const tenantMap = new Map<string, string>();
      tenants?.forEach(t => tenantMap.set(t.id, t.name));

      for (const connection of connections) {
        const expiresAt = connection.expires_at ? new Date(connection.expires_at) : null;
        
        if (expiresAt && expiresAt <= warningThreshold && expiresAt > now) {
          const hoursUntilExpiration = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);
          
          warnings.push({
            source: connection.source as string,
            tenantId: connection.tenant_id,
            tenantName: tenantMap.get(connection.tenant_id),
            expiresAt: connection.expires_at as string,
            hoursUntilExpiration,
          });
        }
      }
    }

    // Send Slack alerts for warnings
    console.log(`[jobs/check-token-health] Slack alerts enabled: ${SLACK_ALERTS_ENABLED}, Warnings: ${warnings.length}`);
    
    if (SLACK_ALERTS_ENABLED && warnings.length > 0) {
      console.log(`[jobs/check-token-health] Sending ${warnings.length} token expiration warnings to Slack`);
      for (const warning of warnings) {
        const slackMessage = formatTokenExpirationWarning({
          source: warning.source,
          tenantId: warning.tenantId,
          tenantName: warning.tenantName,
          expiresAt: warning.expiresAt,
          hoursUntilExpiration: warning.hoursUntilExpiration,
        });

        const sent = await sendSlackMessage(slackMessage);
        console.log(`[jobs/check-token-health] Sent warning for ${warning.source}:${warning.tenantId} - Success: ${sent}`);
      }
    } else if (!SLACK_ALERTS_ENABLED) {
      console.warn('[jobs/check-token-health] SLACK_WEBHOOK_URL not configured, skipping Slack notifications');
    }

    const result = {
      status: warnings.length > 0 ? 'warning' : 'ok',
      warnings,
      checked_at: new Date().toISOString(),
      warning_threshold_hours: TOKEN_EXPIRATION_WARNING_HOURS,
    };

    return NextResponse.json(result, {
      status: warnings.length > 0 ? 200 : 200, // Always 200, warnings are not errors
    });
  } catch (error) {
    console.error('[jobs/check-token-health] Failed to check token health', error);
    return NextResponse.json(
      { error: 'Failed to check token health.', details: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return handleRequest(request);
}
