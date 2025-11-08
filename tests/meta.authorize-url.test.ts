import { expect, test } from 'vitest'

import {
  META_REQUESTED_SCOPES,
  getMetaAuthorizeUrl,
  getMetaRedirectUri,
} from '@/lib/integrations/meta'

test('builds exact authorize URL with correct redirect & scopes', async () => {
  const { url, state } = await getMetaAuthorizeUrl('tenant-test')
  const parsed = new URL(url)

  expect(parsed.origin).toBe('https://www.facebook.com')
  expect(parsed.pathname.endsWith('/dialog/oauth')).toBe(true)
  expect(parsed.searchParams.get('client_id')).toBe(process.env.META_APP_ID)
  expect(parsed.searchParams.get('redirect_uri')).toBe(getMetaRedirectUri())
  expect(parsed.searchParams.get('scope')).toBe(META_REQUESTED_SCOPES.join(','))
  expect(parsed.searchParams.get('response_type')).toBe('code')
  expect(parsed.searchParams.get('state')).toBe(state)
  expect(state).toHaveLength(32)
})


