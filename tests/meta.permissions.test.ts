import { expect, test } from 'vitest'

import {
  META_REQUESTED_SCOPES,
  META_STATE_TTL_MS,
  getMetaRedirectUri,
  isMetaStateExpired,
} from '@/lib/integrations/meta'

test('requested scopes include required Meta Marketing API permissions', () => {
  const scopeSet = new Set(META_REQUESTED_SCOPES)
  expect(scopeSet.has('ads_read')).toBe(true)
  expect(scopeSet.has('ads_management')).toBe(true)
  expect(scopeSet.has('business_management')).toBe(true)
  expect(META_REQUESTED_SCOPES.length).toBe(3)
})

test('redirect URI matches base URL and callback path', () => {
  const redirectUri = getMetaRedirectUri()
  expect(redirectUri).toBe(`${process.env.APP_BASE_URL}/api/oauth/meta/callback`)
})

test('state expiration helper respects TTL window', () => {
  const freshMeta = {
    oauth_state_created_at: new Date().toISOString(),
  }
  expect(isMetaStateExpired(freshMeta)).toBe(false)

  const staleMeta = {
    oauth_state_created_at: new Date(Date.now() - META_STATE_TTL_MS - 1000).toISOString(),
  }
  expect(isMetaStateExpired(staleMeta)).toBe(true)
})


