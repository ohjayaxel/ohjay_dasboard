import { NextRequest } from 'next/server'
import { expect, test } from 'vitest'

import { GET as metaCallback } from '@/app/api/oauth/meta/callback/route'
import { decryptSecret } from '@/lib/integrations/crypto'
import { fetchMock } from './setup'
import { getConnectionsTable } from './mocks/supabase'

test('returns 400 when state is missing', async () => {
  const req = new NextRequest('https://example.com/api/oauth/meta/callback?code=abc')
  const res = await metaCallback(req)

  expect(res.status).toBe(400)
})

test('returns 410 when state does not exist', async () => {
  const req = new NextRequest(
    'https://example.com/api/oauth/meta/callback?code=abc&state=notfound',
  )
  const res = await metaCallback(req)

  expect(res.status).toBe(410)
})

test('exchanges token, persists connection, and redirects on success', async () => {
  const state = '1234567890abcdef'
  const tenantId = '00000000-0000-0000-0000-000000000002'
  const redirectPath = '/admin'

  getConnectionsTable().push({
    id: '11111111-1111-1111-1111-111111111111',
    tenant_id: tenantId,
    source: 'meta',
    status: 'disconnected',
    access_token_enc: null,
    refresh_token_enc: null,
    expires_at: null,
    meta: {
      oauth_state: state,
      oauth_state_created_at: new Date().toISOString(),
      oauth_redirect_path: redirectPath,
    },
  })

  fetchMock.mockImplementationOnce(async () => {
    return new Response(
      JSON.stringify({
        access_token: 'test-access-token',
        token_type: 'bearer',
        expires_in: 3600,
      }),
      { status: 200 },
    )
  })

  fetchMock.mockImplementationOnce(async () => {
    return new Response(
      JSON.stringify({
        data: {
          scopes: ['ads_read', 'ads_management', 'business_management'],
        },
      }),
      { status: 200 },
    )
  })

  fetchMock.mockImplementationOnce(async () => {
    return new Response(
      JSON.stringify({
        data: [
          {
            id: 'act_123',
            account_id: '123',
            name: 'Demo Account',
            currency: 'USD',
          },
        ],
      }),
      { status: 200 },
    )
  })

  fetchMock.mockImplementationOnce(async () => {
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  })

  fetchMock.mockImplementationOnce(async () => {
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  })

  const req = new NextRequest(
    `https://example.com/api/oauth/meta/callback?code=abc&state=${state}`,
  )
  const res = await metaCallback(req)

  expect(res.status).toBe(307)
  expect(res.headers.get('location')).toContain(`${redirectPath}?status=meta-connected`)

  const [connection] = getConnectionsTable().filter(
    (row) => row.tenant_id === tenantId && row.source === 'meta',
  )

  expect(connection.status).toBe('connected')
  expect(connection.meta?.oauth_state).toBeNull()
  expect(connection.meta?.ad_accounts?.length).toBe(1)
  expect(connection.meta?.selected_account_id).toBe('act_123')

  const decryptedToken = decryptSecret(connection.access_token_enc)
  expect(decryptedToken).toBe('test-access-token')
})


