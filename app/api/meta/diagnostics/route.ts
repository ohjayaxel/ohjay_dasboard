import { NextRequest, NextResponse } from 'next/server'

import { requirePlatformAdmin } from '@/lib/auth/current-user'
import {
  META_REQUESTED_SCOPES,
  META_STATE_TTL_MS,
  getMetaBaseUrl,
  getMetaCallbackPath,
  getMetaRedirectUri,
} from '@/lib/integrations/meta'
import { logger, withRequestContext } from '@/lib/logger'

const DIAGNOSTICS_ENDPOINT = '/api/meta/diagnostics'

type DiagnosticsResult = {
  env: {
    META_APP_ID: boolean
    META_APP_SECRET: boolean
    NEXT_PUBLIC_BASE_URL: boolean
  }
  missing_env: string[]
  computed: {
    redirect_uri?: string
    redirect_error?: string
    redirect_mismatch: boolean
  }
  auth: {
    scopes: string[]
    state_ttl_ms: number
  }
  app_mode_hint: string
  routes: {
    callback: string
    diagnostics: string
    test: string
  }
  logging: {
    active: boolean
    request_id_policy: string
  }
  recommendations: Record<string, string[]>
  notes?: string[]
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? undefined

  return withRequestContext(async () => {
    const user = await requirePlatformAdmin()

    const envStatus = {
      META_APP_ID: Boolean(process.env.META_APP_ID),
      META_APP_SECRET: Boolean(process.env.META_APP_SECRET),
      NEXT_PUBLIC_BASE_URL: Boolean(process.env.NEXT_PUBLIC_BASE_URL),
    }
    const missingEnv = Object.entries(envStatus)
      .filter(([, present]) => !present)
      .map(([key]) => key)

    let redirectUri: string | undefined
    let redirectError: string | undefined
    try {
      redirectUri = getMetaRedirectUri()
    } catch (error) {
      redirectError = error instanceof Error ? error.message : String(error)
    }

    const callbackPath = getMetaCallbackPath()
    let redirectMismatch = false
    if (redirectUri) {
      try {
        const redirectUrl = new URL(redirectUri)
        if (!redirectUrl.pathname.endsWith(callbackPath)) {
          redirectMismatch = true
        }
      } catch (error) {
        redirectError = error instanceof Error ? error.message : String(error)
      }
    }

    const baseUri = (() => {
      try {
        return getMetaBaseUrl()
      } catch (error) {
        redirectError = redirectError ?? (error instanceof Error ? error.message : String(error))
        return undefined
      }
    })()

    const baseHost = (() => {
      if (!redirectUri) return undefined
      try {
        return new URL(redirectUri).host
      } catch {
        return undefined
      }
    })()

    const result: DiagnosticsResult = {
      env: envStatus,
      missing_env: missingEnv,
      computed: {
        redirect_uri: redirectUri,
        redirect_error: redirectError,
        redirect_mismatch: redirectMismatch,
      },
      auth: {
        scopes: [...META_REQUESTED_SCOPES],
        state_ttl_ms: META_STATE_TTL_MS,
      },
      app_mode_hint:
        process.env.APP_ENV ??
        process.env.VERCEL_ENV ??
        process.env.NODE_ENV ??
        'unknown',
      routes: {
        callback: callbackPath,
        diagnostics: DIAGNOSTICS_ENDPOINT,
        test: '/api/meta/test',
      },
      logging: {
        active: true,
        request_id_policy: 'async_local_storage',
      },
      recommendations: {
        app_domains: baseHost ? [baseHost] : [],
        valid_oauth_redirect_uris: redirectUri
          ? Array.from(
              new Set([
                redirectUri,
                redirectUri.endsWith('/') ? redirectUri : `${redirectUri}/`,
              ]),
            )
          : [],
      },
    }

    if (!redirectUri) {
      result.notes = [
        'Redirect URI could not be computed. Validate NEXT_PUBLIC_BASE_URL / APP_BASE_URL.',
      ]
    }

    logger.info(
      {
        route: 'api.meta.diagnostics',
        action: 'generate',
        endpoint: DIAGNOSTICS_ENDPOINT,
        userId: user.id,
        base_uri: baseUri,
        redirect_uri: redirectUri,
        redirect_mismatch: redirectMismatch,
        missing_env: missingEnv,
      },
      'Meta diagnostics generated',
    )

    return NextResponse.json(result)
  }, requestId)
}

