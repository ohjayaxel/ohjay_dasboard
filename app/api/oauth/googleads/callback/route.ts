import { revalidatePath } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';

import { handleGoogleAdsOAuthCallback } from '@/lib/integrations/googleads';
import { triggerSyncJobForTenant } from '@/lib/jobs/scheduler';
import { logger, withRequestContext } from '@/lib/logger';
import { getSupabaseServiceClient } from '@/lib/supabase/server';

const CALLBACK_ENDPOINT = '/api/oauth/googleads/callback';
const STATE_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes

export async function GET(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? undefined;

  return withRequestContext(
    async () => {
      const url = new URL(request.url);
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      // Handle OAuth errors from Google
      if (error) {
        logger.error(
          {
            route: 'googleads_callback',
            action: 'oauth_error',
            endpoint: CALLBACK_ENDPOINT,
            error,
          },
          'Google Ads OAuth error from provider',
        );
        return NextResponse.redirect(
          new URL(`/admin?error=${encodeURIComponent(`Google Ads authorization failed: ${error}`)}`, url.origin),
        );
      }

      if (!state) {
        logger.error(
          {
            route: 'googleads_callback',
            action: 'validate_state',
            endpoint: CALLBACK_ENDPOINT,
            error_message: 'Missing state parameter',
          },
          'Google Ads OAuth callback missing state',
        );
        return NextResponse.json({ error: 'Missing state parameter.' }, { status: 400 });
      }

      if (!code) {
        logger.error(
          {
            route: 'googleads_callback',
            action: 'validate_code',
            endpoint: CALLBACK_ENDPOINT,
            state: state.slice(0, 16), // Log only prefix for security
            error_message: 'Missing authorization code',
          },
          'Google Ads OAuth callback missing code',
        );
        return NextResponse.json({ error: 'Missing authorization code.' }, { status: 400 });
      }

      const client = getSupabaseServiceClient();

      // Look up connection by OAuth state
      const { data: connection, error: connectionError } = await client
        .from('connections')
        .select('id, tenant_id, meta')
        .eq('source', 'google_ads')
        .eq('meta->>oauth_state', state)
        .maybeSingle();

      if (connectionError) {
        logger.error(
          {
            route: 'googleads_callback',
            action: 'lookup_connection',
            endpoint: CALLBACK_ENDPOINT,
            state: state.slice(0, 16),
            error_message: connectionError.message,
          },
          'Failed to lookup Google Ads connection for callback',
        );
        return NextResponse.json({ error: 'Unable to locate connection for provided state.' }, { status: 400 });
      }

      if (!connection) {
        logger.warn(
          {
            route: 'googleads_callback',
            action: 'lookup_connection',
            endpoint: CALLBACK_ENDPOINT,
            state: state.slice(0, 16),
            error_message: 'State not found',
          },
          'Google Ads OAuth state not found or already consumed',
        );
        return NextResponse.json({ error: 'Unknown or expired Google Ads OAuth state.' }, { status: 410 });
      }

      const meta =
        connection.meta && typeof connection.meta === 'object'
          ? (connection.meta as Record<string, unknown>)
          : {};

      const redirectPath =
        typeof meta.oauth_redirect_path === 'string' && meta.oauth_redirect_path.length > 0
          ? meta.oauth_redirect_path
          : '/admin';

      // Check if state is expired
      const stateCreatedAt =
        typeof meta.oauth_state_created_at === 'string' ? new Date(meta.oauth_state_created_at).getTime() : null;

      if (stateCreatedAt && Date.now() - stateCreatedAt > STATE_MAX_AGE_MS) {
        logger.warn(
          {
            route: 'googleads_callback',
            action: 'validate_state_age',
            endpoint: CALLBACK_ENDPOINT,
            state: state.slice(0, 16),
            tenantId: connection.tenant_id,
            state_age_ms: Date.now() - stateCreatedAt,
          },
          'Google Ads OAuth state expired',
        );

        // Clear stale state
        await client
          .from('connections')
          .update({
            meta: {
              ...meta,
              oauth_state: null,
              oauth_state_created_at: null,
            },
          })
          .eq('id', connection.id);

        const errorUrl = new URL(redirectPath, url.origin);
        errorUrl.searchParams.set('error', 'Google Ads authorization expired. Please try connecting again.');
        return NextResponse.redirect(errorUrl);
      }

      // Get tenant slug for redirect
      const { data: tenant, error: tenantError } = await client
        .from('tenants')
        .select('slug')
        .eq('id', connection.tenant_id)
        .maybeSingle();

      if (tenantError || !tenant) {
        logger.error(
          {
            route: 'googleads_callback',
            action: 'fetch_tenant',
            endpoint: CALLBACK_ENDPOINT,
            tenantId: connection.tenant_id,
            error_message: tenantError?.message || 'Tenant not found',
          },
          'Failed to fetch tenant for Google Ads callback',
        );
        return NextResponse.json({ error: 'Tenant not found.' }, { status: 404 });
      }

      const finalRedirectPath = `/admin/tenants/${tenant.slug}/integrations`;

      // Handle OAuth callback
      try {
        await handleGoogleAdsOAuthCallback({
          tenantId: connection.tenant_id as string,
          code,
          state,
          loginCustomerId: typeof meta.login_customer_id === 'string' ? meta.login_customer_id : undefined,
        });

        // Clear OAuth state after successful callback
        await client
          .from('connections')
          .update({
            meta: {
              ...meta,
              oauth_state: null,
              oauth_state_created_at: null,
            },
          })
          .eq('id', connection.id);

        // Trigger initial sync
        try {
          await triggerSyncJobForTenant('google_ads', connection.tenant_id as string);
        } catch (syncError) {
          logger.warn(
            {
              route: 'googleads_callback',
              action: 'trigger_initial_sync',
              endpoint: CALLBACK_ENDPOINT,
              tenantId: connection.tenant_id,
              error_message: syncError instanceof Error ? syncError.message : String(syncError),
            },
            'Failed to trigger initial Google Ads sync after OAuth, will rely on cron job.',
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          {
            route: 'googleads_callback',
            action: 'handle_callback',
            endpoint: CALLBACK_ENDPOINT,
            state: state.slice(0, 16),
            tenantId: connection.tenant_id,
            error_message: errorMessage,
          },
          'Google Ads OAuth callback failed',
        );
        const errorUrl = new URL(finalRedirectPath, url.origin);
        errorUrl.searchParams.set(
          'error',
          encodeURIComponent('Google Ads authorization failed. Please verify credentials and try connecting again.'),
        );
        errorUrl.searchParams.set('error_detail', encodeURIComponent(errorMessage));
        return NextResponse.redirect(errorUrl);
      }

      revalidatePath('/admin');
      revalidatePath(finalRedirectPath);

      const successUrl = new URL(finalRedirectPath, url.origin);
      successUrl.searchParams.set('status', 'googleads-connected');

      logger.info(
        {
          route: 'googleads_callback',
          action: 'redirect_success',
          endpoint: CALLBACK_ENDPOINT,
          state: state.slice(0, 16),
          tenantId: connection.tenant_id,
        },
        'Google Ads OAuth flow completed successfully',
      );

      return NextResponse.redirect(successUrl);
    },
    requestId,
  );
}

