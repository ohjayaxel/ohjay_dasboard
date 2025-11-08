import { expect, test } from 'vitest'

import { startMetaConnect } from '@/app/(dashboard)/admin/actions'
import { getConnectionsTable } from './mocks/supabase'

test('persists oauth_state and redirect path in connections table', async () => {
  const tenantId = '00000000-0000-0000-0000-000000000001'
  const result = await startMetaConnect({
    tenantId,
    tenantSlug: 'demo',
  })

  expect(result.redirectUrl).toContain('facebook.com')
  expect(result.state).toBeDefined()

  const rows = getConnectionsTable().filter(
    (row) => row.tenant_id === tenantId && row.source === 'meta',
  )
  expect(rows).toHaveLength(1)

  const [connection] = rows
  expect(connection.meta?.oauth_state).toBe(result.state)
  expect(connection.meta?.oauth_redirect_path).toBe('/admin/tenants/demo')
})


