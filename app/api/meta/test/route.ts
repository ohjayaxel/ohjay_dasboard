import { NextRequest, NextResponse } from 'next/server'

import { requirePlatformAdmin } from '@/lib/auth/current-user'
import { fetchMetaAdAccountsForTenant } from '@/lib/integrations/meta'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  const user = await requirePlatformAdmin()
  const tenantId = request.nextUrl.searchParams.get('tenantId')

  if (!tenantId) {
    return NextResponse.json({ error: 'Missing tenantId parameter.' }, { status: 400 })
  }

  try {
    const payload = await fetchMetaAdAccountsForTenant({
      tenantId,
      userId: user.id,
      route: 'api.meta.test',
    })

    logger.info(
      {
        route: 'api.meta.test',
        action: 'fetch_adaccounts',
        tenantId,
        userId: user.id,
      },
      'Meta test endpoint succeeded',
    )

    return NextResponse.json(payload ?? {})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    logger.error(
      {
        route: 'api.meta.test',
        action: 'fetch_adaccounts',
        tenantId,
        userId: user.id,
        error_message: message,
      },
      'Meta test endpoint failed',
    )

    return NextResponse.json(
      {
        error: 'Failed to fetch Meta ad accounts.',
        detail: message,
      },
      { status: 500 },
    )
  }
}

