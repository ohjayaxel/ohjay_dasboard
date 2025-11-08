import { NextRequest, NextResponse } from 'next/server'

import { requirePlatformAdmin } from '@/lib/auth/current-user'
import {
  fetchMetaAdAccountsForTenant,
  fetchMetaProfileForTenant,
  getActiveMetaAccessToken,
  type MetaRequestErrorDetail,
} from '@/lib/integrations/meta'
import { logger, withRequestContext } from '@/lib/logger'

const TEST_ENDPOINT = '/api/meta/test'

type MetaTestResult = {
  ok_me: boolean
  ok_adaccounts: boolean
  me?: {
    status?: number
    fb_trace_id?: string
    id?: string
    name?: string
    error_message?: string
    error_code?: number
    error_subcode?: number
  }
  adaccounts?: {
    status?: number
    fb_trace_id?: string
    count?: number
    error_message?: string
    error_code?: number
    error_subcode?: number
  }
  diagnostics?: {
    token_present: boolean
    token_hint?: string
  }
}

function maskToken(token: string | null): string | undefined {
  if (!token) {
    return undefined
  }
  if (token.length <= 8) {
    return `${token.slice(0, 2)}…`
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

function applyErrorDetail(target: Record<string, unknown>, detail?: MetaRequestErrorDetail) {
  if (!detail) return
  target.status = detail.status
  target.fb_trace_id = detail.fbTraceId
  if (detail.message) {
    target.error_message = detail.message
  }
  if (detail.error_code !== undefined) {
    target.error_code = detail.error_code
  }
  if (detail.error_subcode !== undefined) {
    target.error_subcode = detail.error_subcode
  }
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? undefined

  return withRequestContext(async () => {
    const user = await requirePlatformAdmin()
    const tenantId = request.nextUrl.searchParams.get('tenantId')

    if (!tenantId) {
      return NextResponse.json({ error: 'Missing tenantId parameter.' }, { status: 400 })
    }

    const token = await getActiveMetaAccessToken(tenantId)
    if (!token) {
      logger.error(
        {
          route: 'api.meta.test',
          action: 'resolve_token',
          endpoint: TEST_ENDPOINT,
          tenantId,
          userId: user.id,
          error_message: 'No stored Meta access token for tenant',
        },
        'Meta test endpoint failed',
      )
      return NextResponse.json(
        {
          ok_me: false,
          ok_adaccounts: false,
          diagnostics: {
            token_present: false,
          },
          error: 'No Meta access token stored for tenant. Connect Meta first.',
        },
        { status: 400 },
      )
    }

    const result: MetaTestResult = {
      ok_me: false,
      ok_adaccounts: false,
      diagnostics: {
        token_present: true,
        token_hint: maskToken(token),
      },
    }

    let profileDetail: MetaRequestErrorDetail | undefined
    try {
      const profile = await fetchMetaProfileForTenant({
        tenantId,
        userId: user.id,
        route: 'api.meta.test',
      })

      result.ok_me = profile.status === 200
      result.me = {
        status: profile.status,
        fb_trace_id: profile.fbTraceId,
        id: profile.body?.id,
        name: profile.body?.name,
      }
    } catch (error) {
      const meta = (error as { meta?: MetaRequestErrorDetail }).meta
      profileDetail = meta
      result.ok_me = false
      result.me = {}
      applyErrorDetail(result.me, meta)
    }

    let adAccountsDetail: MetaRequestErrorDetail | undefined
    try {
      const adAccounts = await fetchMetaAdAccountsForTenant({
        tenantId,
        userId: user.id,
        route: 'api.meta.test',
      })

      result.ok_adaccounts = adAccounts.status === 200
      result.adaccounts = {
        status: adAccounts.status,
        fb_trace_id: adAccounts.fbTraceId,
        count: adAccounts.accounts?.length ?? 0,
      }
    } catch (error) {
      const meta = (error as { meta?: MetaRequestErrorDetail }).meta
      adAccountsDetail = meta
      result.ok_adaccounts = false
      result.adaccounts = {}
      applyErrorDetail(result.adaccounts, meta)
    }

    if (!result.ok_me || !result.ok_adaccounts) {
      const dominantError = adAccountsDetail ?? profileDetail
      logger.error(
        {
          route: 'api.meta.test',
          action: 'diagnostics',
          endpoint: TEST_ENDPOINT,
          tenantId,
          userId: user.id,
          fb_trace_id: dominantError?.fbTraceId,
          status: dominantError?.status,
          error_code: dominantError?.error_code,
          error_subcode: dominantError?.error_subcode,
          error_message: dominantError?.message,
        },
        'Meta test endpoint reported failure',
      )

      const status = dominantError?.status && dominantError.status >= 400 ? dominantError.status : 500
      return NextResponse.json(result, { status })
    }

    logger.info(
      {
        route: 'api.meta.test',
        action: 'diagnostics',
        endpoint: TEST_ENDPOINT,
        tenantId,
        userId: user.id,
        fb_trace_id: result.adaccounts?.fb_trace_id ?? result.me?.fb_trace_id,
        status: 200,
      },
      'Meta test endpoint succeeded',
    )

    return NextResponse.json(result)
  }, requestId)
}

