import { revalidatePath } from 'next/cache'
import { NextRequest, NextResponse } from 'next/server'

import { handleMetaOAuthCallback } from '@/lib/integrations/meta'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code') ?? 'mock-code'

  if (!state) {
    return NextResponse.json({ error: 'Missing state parameter.' }, { status: 400 })
  }

  const client = getSupabaseServiceClient()

  const { data: connection, error: connectionError } = await client
    .from('connections')
    .select('id, tenant_id, meta')
    .eq('source', 'meta')
    .eq('meta->>oauth_state', state)
    .maybeSingle()

  if (connectionError) {
    console.error('Failed to lookup Meta connection for callback:', connectionError.message)
    return NextResponse.json({ error: 'Unable to locate connection for provided state.' }, { status: 400 })
  }

  if (!connection) {
    return NextResponse.json({ error: 'Unknown or expired Meta OAuth state.' }, { status: 410 })
  }

  const meta =
    connection.meta && typeof connection.meta === 'object' ? (connection.meta as Record<string, unknown>) : {}
  const redirectPath =
    typeof meta.oauth_redirect_path === 'string' && meta.oauth_redirect_path.length > 0
      ? meta.oauth_redirect_path
      : '/admin'

  try {
    await handleMetaOAuthCallback({
      tenantId: connection.tenant_id as string,
      code,
      state,
    })
  } catch (error) {
    console.error('Meta OAuth callback failed:', error)
    const errorUrl = new URL(redirectPath, url.origin)
    errorUrl.searchParams.set(
      'error',
      'Meta authorization failed. Please verify credentials and try connecting again.',
    )
    return NextResponse.redirect(errorUrl)
  }

  revalidatePath('/admin')
  revalidatePath(redirectPath)

  const successUrl = new URL(redirectPath, url.origin)
  successUrl.searchParams.set('status', 'meta-connected')

  return NextResponse.redirect(successUrl)
}

