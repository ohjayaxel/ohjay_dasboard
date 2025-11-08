import { revalidatePath } from 'next/cache'
import { NextRequest, NextResponse } from 'next/server'

import { handleMetaOAuthCallback, isMetaStateExpired } from '@/lib/integrations/meta'
import { logger } from '@/lib/logger'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')

  if (!state) {
    logger.error(
      {
        route: 'meta_callback',
        action: 'validate_state',
        error_message: 'Missing state parameter',
      },
      'Meta OAuth callback missing state',
    )
    return NextResponse.json({ error: 'Missing state parameter.' }, { status: 400 })
  }

  if (!code) {
    logger.error(
      {
        route: 'meta_callback',
        action: 'validate_code',
        state,
        error_message: 'Missing authorization code',
      },
      'Meta OAuth callback missing code',
    )
    return NextResponse.json({ error: 'Missing authorization code.' }, { status: 400 })
  }

  const client = getSupabaseServiceClient()

  const { data: connection, error: connectionError } = await client
    .from('connections')
    .select('id, tenant_id, meta')
    .eq('source', 'meta')
    .eq('meta->>oauth_state', state)
    .maybeSingle()

  if (connectionError) {
    logger.error(
      {
        route: 'meta_callback',
        action: 'lookup_connection',
        state,
        error_message: connectionError.message,
      },
      'Failed to lookup Meta connection for callback',
    )
    return NextResponse.json({ error: 'Unable to locate connection for provided state.' }, { status: 400 })
  }

  if (!connection) {
    logger.warn(
      {
        route: 'meta_callback',
        action: 'lookup_connection',
        state,
        error_message: 'State not found',
      },
      'Meta OAuth state not found or already consumed',
    )
    return NextResponse.json({ error: 'Unknown or expired Meta OAuth state.' }, { status: 410 })
  }

  const meta =
    connection.meta && typeof connection.meta === 'object'
      ? (connection.meta as Record<string, unknown>)
      : {}

  const redirectPath =
    typeof meta.oauth_redirect_path === 'string' && meta.oauth_redirect_path.length > 0
      ? meta.oauth_redirect_path
      : '/admin'

  if (isMetaStateExpired(meta)) {
    logger.warn(
      {
        route: 'meta_callback',
        action: 'validate_state_age',
        state,
        tenantId: connection.tenant_id,
      },
      'Meta OAuth state expired',
    )

    // Clear stale state to avoid reuse
    await client
      .from('connections')
      .update({
        meta: {
          ...meta,
          oauth_state: null,
          oauth_state_created_at: null,
        },
      })
      .eq('id', connection.id)

    const errorUrl = new URL(redirectPath, url.origin)
    errorUrl.searchParams.set('error', 'Meta authorization expired. Please try connecting again.')
    return NextResponse.redirect(errorUrl)
  }

  try {
    await handleMetaOAuthCallback({
      tenantId: connection.tenant_id as string,
      code,
      state,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(
      {
        route: 'meta_callback',
        action: 'handle_callback',
        state,
        tenantId: connection.tenant_id,
        error_message: errorMessage,
      },
      'Meta OAuth callback failed',
    )
    const errorUrl = new URL(redirectPath, url.origin)
    errorUrl.searchParams.set(
      'error',
      'Meta authorization failed. Please verify credentials and try connecting again.',
    )
    errorUrl.searchParams.set('error_detail', errorMessage)
    return NextResponse.redirect(errorUrl)
  }

  revalidatePath('/admin')
  revalidatePath(redirectPath)

  const successUrl = new URL(redirectPath, url.origin)
  successUrl.searchParams.set('status', 'meta-connected')

  logger.info(
    {
      route: 'meta_callback',
      action: 'redirect_success',
      state,
      tenantId: connection.tenant_id,
    },
    'Meta OAuth flow completed successfully',
  )

  return NextResponse.redirect(successUrl)
}

