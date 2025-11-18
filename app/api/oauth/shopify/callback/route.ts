import { revalidatePath } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';

import { handleShopifyOAuthCallback } from '@/lib/integrations/shopify';
import { triggerSyncJobForTenant } from '@/lib/jobs/scheduler';
import { logger, withRequestContext } from '@/lib/logger';
import { getSupabaseServiceClient } from '@/lib/supabase/server';

const CALLBACK_ENDPOINT = '/api/oauth/shopify/callback';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function normalizeShopDomain(domain: string): string {
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function validateState(state: string): { tenantId: string; shopDomain: string; userId: string } | null {
  if (!ENCRYPTION_KEY) {
    logger.error(
      {
        route: 'shopify_callback',
        action: 'validate_state',
        endpoint: CALLBACK_ENDPOINT,
        error_message: 'Missing ENCRYPTION_KEY',
      },
      'Shopify OAuth callback missing ENCRYPTION_KEY',
    );
    return null;
  }

  try {
    // Dekoda base64 state
    const stateDecoded = JSON.parse(Buffer.from(state, 'base64').toString());

    if (!stateDecoded.data || !stateDecoded.sig) {
      logger.error(
        {
          route: 'shopify_callback',
          action: 'validate_state_format',
          endpoint: CALLBACK_ENDPOINT,
          error_message: 'Invalid state format',
        },
        'Shopify OAuth callback invalid state format',
      );
      return null;
    }

    // Verifiera HMAC-signatur
    const statePayload = JSON.stringify(stateDecoded.data);
    const expectedSig = createHmac('sha256', ENCRYPTION_KEY)
      .update(statePayload)
      .digest('hex');

    if (stateDecoded.sig !== expectedSig) {
      logger.error(
        {
          route: 'shopify_callback',
          action: 'validate_state_signature',
          endpoint: CALLBACK_ENDPOINT,
          error_message: 'Invalid state signature',
        },
        'Shopify OAuth callback invalid state signature',
      );
      return null;
    }

    // Validera timestamp (max 10 minuter gammal)
    const stateAge = Date.now() - stateDecoded.data.timestamp;
    if (stateAge > STATE_MAX_AGE_MS || stateAge < 0) {
      logger.warn(
        {
          route: 'shopify_callback',
          action: 'validate_state_age',
          endpoint: CALLBACK_ENDPOINT,
          state_age_ms: stateAge,
          error_message: 'State expired',
        },
        'Shopify OAuth state expired',
      );
      return null;
    }

    return {
      tenantId: stateDecoded.data.tenantId,
      shopDomain: normalizeShopDomain(stateDecoded.data.shopDomain),
      userId: stateDecoded.data.userId,
    };
  } catch (error) {
    logger.error(
      {
        route: 'shopify_callback',
        action: 'validate_state',
        endpoint: CALLBACK_ENDPOINT,
        error_message: error instanceof Error ? error.message : String(error),
      },
      'Shopify OAuth callback state validation failed',
    );
    return null;
  }
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? undefined;

  return withRequestContext(
    async () => {
      const url = new URL(request.url);
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const shop = url.searchParams.get('shop');

      if (!state) {
        logger.error(
          {
            route: 'shopify_callback',
            action: 'validate_state',
            endpoint: CALLBACK_ENDPOINT,
            error_message: 'Missing state parameter',
          },
          'Shopify OAuth callback missing state',
        );
        return NextResponse.json({ error: 'Missing state parameter.' }, { status: 400 });
      }

      if (!code) {
        logger.error(
          {
            route: 'shopify_callback',
            action: 'validate_code',
            endpoint: CALLBACK_ENDPOINT,
            state: state.slice(0, 16), // Log only prefix for security
            error_message: 'Missing authorization code',
          },
          'Shopify OAuth callback missing code',
        );
        return NextResponse.json({ error: 'Missing authorization code.' }, { status: 400 });
      }

      if (!shop) {
        logger.error(
          {
            route: 'shopify_callback',
            action: 'validate_shop',
            endpoint: CALLBACK_ENDPOINT,
            error_message: 'Missing shop parameter',
          },
          'Shopify OAuth callback missing shop',
        );
        return NextResponse.json({ error: 'Missing shop parameter.' }, { status: 400 });
      }

      // Validera state och extrahera tenantId
      const stateData = validateState(state);
      if (!stateData) {
        return NextResponse.json({ error: 'Invalid or expired OAuth state.' }, { status: 400 });
      }

      const { tenantId, shopDomain: expectedShopDomain } = stateData;

      // Normalisera och verifiera shop domain matchar state
      const normalizedShop = normalizeShopDomain(shop);
      if (normalizedShop !== expectedShopDomain) {
        logger.error(
          {
            route: 'shopify_callback',
            action: 'validate_shop_domain',
            endpoint: CALLBACK_ENDPOINT,
            tenantId,
            expected_shop: expectedShopDomain,
            received_shop: normalizedShop,
            error_message: 'Shop domain mismatch',
          },
          'Shopify OAuth callback shop domain mismatch',
        );
        return NextResponse.json(
          {
            error: `Shop domain mismatch: expected ${expectedShopDomain}, received ${normalizedShop}`,
          },
          { status: 400 },
        );
      }

      const client = getSupabaseServiceClient();

      // VERIFIERA att shop inte redan är kopplad till en annan tenant
      const { data: existingConnection, error: existingConnectionError } = await client
        .from('connections')
        .select('tenant_id, meta')
        .eq('source', 'shopify')
        .eq('status', 'connected')
        .eq('meta->>store_domain', normalizedShop)
        .maybeSingle();

      if (existingConnectionError) {
        logger.error(
          {
            route: 'shopify_callback',
            action: 'check_existing_connection',
            endpoint: CALLBACK_ENDPOINT,
            tenantId,
            shop: normalizedShop,
            error_message: existingConnectionError.message,
          },
          'Failed to check existing Shopify connection',
        );
        return NextResponse.json(
          { error: 'Failed to validate shop connection.' },
          { status: 500 },
        );
      }

      if (existingConnection && existingConnection.tenant_id !== tenantId) {
        logger.warn(
          {
            route: 'shopify_callback',
            action: 'check_existing_connection',
            endpoint: CALLBACK_ENDPOINT,
            tenantId,
            existing_tenant_id: existingConnection.tenant_id,
            shop: normalizedShop,
            error_message: 'Shop already connected to another tenant',
          },
          'Shopify OAuth callback shop already connected to different tenant',
        );

        // Hämta tenant slug för felmeddelande
        const { data: tenant } = await client
          .from('tenants')
          .select('slug')
          .eq('id', tenantId)
          .maybeSingle();

        const redirectPath = tenant
          ? `/admin/tenants/${tenant.slug}/integrations`
          : '/admin';

        const errorUrl = new URL(redirectPath, url.origin);
        errorUrl.searchParams.set(
          'error',
          encodeURIComponent(
            'This Shopify store is already connected to another account. ' +
              'Please disconnect it first or contact support.',
          ),
        );
        return NextResponse.redirect(errorUrl);
      }

      // Hämta tenant slug för redirect
      const { data: tenant, error: tenantError } = await client
        .from('tenants')
        .select('slug')
        .eq('id', tenantId)
        .maybeSingle();

      if (tenantError || !tenant) {
        logger.error(
          {
            route: 'shopify_callback',
            action: 'fetch_tenant',
            endpoint: CALLBACK_ENDPOINT,
            tenantId,
            error_message: tenantError?.message || 'Tenant not found',
          },
          'Failed to fetch tenant for Shopify callback',
        );
        return NextResponse.json({ error: 'Tenant not found.' }, { status: 404 });
      }

      const redirectPath = `/admin/tenants/${tenant.slug}/integrations`;

      // Hantera OAuth callback
      try {
        await handleShopifyOAuthCallback({
          tenantId,
          code,
          state,
          shop: normalizedShop,
        });

        try {
          await triggerSyncJobForTenant('shopify', tenantId);
        } catch (syncError) {
          logger.warn(
            {
              route: 'shopify_callback',
              action: 'trigger_initial_sync',
              endpoint: CALLBACK_ENDPOINT,
              tenantId,
              shop: normalizedShop,
              error_message: syncError instanceof Error ? syncError.message : String(syncError),
            },
            'Failed to trigger initial Shopify sync after OAuth, will rely on cron job.',
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          {
            route: 'shopify_callback',
            action: 'handle_callback',
            endpoint: CALLBACK_ENDPOINT,
            tenantId,
            shop: normalizedShop,
            error_message: errorMessage,
          },
          'Shopify OAuth callback failed',
        );
        const errorUrl = new URL(redirectPath, url.origin);
        errorUrl.searchParams.set(
          'error',
          encodeURIComponent(
            'Shopify authorization failed. Please verify credentials and try connecting again.',
          ),
        );
        errorUrl.searchParams.set('error_detail', encodeURIComponent(errorMessage));
        return NextResponse.redirect(errorUrl);
      }

      revalidatePath('/admin');
      revalidatePath(redirectPath);

      const successUrl = new URL(redirectPath, url.origin);
      successUrl.searchParams.set('status', 'shopify-connected');

      logger.info(
        {
          route: 'shopify_callback',
          action: 'redirect_success',
          endpoint: CALLBACK_ENDPOINT,
          tenantId,
          shop: normalizedShop,
        },
        'Shopify OAuth flow completed successfully',
      );

      return NextResponse.redirect(successUrl);
    },
    requestId,
  );
}

