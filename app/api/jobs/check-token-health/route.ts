import { NextResponse } from 'next/server';

import { getSupabaseServiceClient } from '@/lib/supabase/server';

const TOKEN_EXPIRATION_WARNING_DAYS = 7; // Warn if token expires within 7 days

async function handleRequest(request: Request) {
  try {
    const client = getSupabaseServiceClient();
    const warningThreshold = new Date();
    warningThreshold.setDate(warningThreshold.getDate() + TOKEN_EXPIRATION_WARNING_DAYS);

    // Check all connected sources for token expiration
    const { data: connections, error: connectionsError } = await client
      .from('connections')
      .select('id, tenant_id, source, status, expires_at')
      .eq('status', 'connected')
      .not('expires_at', 'is', null)
      .lt('expires_at', warningThreshold.toISOString());

    if (connectionsError) {
      throw new Error(`Failed to check connections: ${connectionsError.message}`);
    }

    const warnings: Array<{
      tenant_id: string;
      source: string;
      expires_at: string;
      days_until_expiration: number;
    }> = [];

    if (connections && connections.length > 0) {
      const now = new Date();
      for (const conn of connections) {
        if (conn.expires_at) {
          const expiresAt = new Date(conn.expires_at);
          const daysUntilExpiration = Math.ceil(
            (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
          );
          
          if (daysUntilExpiration < TOKEN_EXPIRATION_WARNING_DAYS) {
            warnings.push({
              tenant_id: conn.tenant_id as string,
              source: conn.source as string,
              expires_at: conn.expires_at,
              days_until_expiration: daysUntilExpiration,
            });
          }
        }
      }
    }

    // Check for recent failures that might indicate token issues
    const recentFailureThreshold = new Date();
    recentFailureThreshold.setHours(recentFailureThreshold.getHours() - 24);

    const { data: recentFailures, error: failuresError } = await client
      .from('jobs_log')
      .select('tenant_id, source, error, finished_at')
      .eq('status', 'failed')
      .gte('finished_at', recentFailureThreshold.toISOString());

    // Filter in-memory for token-related errors (Supabase .or() doesn't work well with ilike)
    const tokenRelatedFailures: Array<{
      tenant_id: string;
      source: string;
      error: string;
      finished_at: string;
    }> = [];

    if (recentFailures && recentFailures.length > 0) {
      const tokenErrorKeywords = ['token', 'expired', 'unauthorized', 'authentication', '401', '403', 'invalid_grant'];
      for (const failure of recentFailures) {
        const errorText = ((failure.error as string) || '').toLowerCase();
        if (tokenErrorKeywords.some(keyword => errorText.includes(keyword))) {
          tokenRelatedFailures.push({
            tenant_id: failure.tenant_id as string,
            source: failure.source as string,
            error: (failure.error as string) || 'Unknown error',
            finished_at: failure.finished_at as string,
          });
        }
      }
    }


    const result = {
      status: warnings.length > 0 || tokenRelatedFailures.length > 0 ? 'warning' : 'ok',
      expiring_tokens: warnings,
      token_related_failures: tokenRelatedFailures,
      checked_at: new Date().toISOString(),
    };

    return NextResponse.json(result, {
      status: result.status === 'warning' ? 200 : 200, // Return 200 but with warning status
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

