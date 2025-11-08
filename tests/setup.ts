import { beforeAll, beforeEach, vi } from 'vitest'

import { createSupabaseClient, resetMockDb } from './mocks/supabase'

process.env.META_APP_ID = process.env.META_APP_ID ?? '123456789012345'
process.env.META_APP_SECRET = process.env.META_APP_SECRET ?? 'super-secret-meta'
process.env.NEXT_PUBLIC_BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://example.com'
process.env.APP_BASE_URL = process.env.APP_BASE_URL ?? 'https://example.com'
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? '12345678901234567890123456789012'

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseServiceClient: () => createSupabaseClient(),
  resetSupabaseServiceClientCache: () => {},
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

export const fetchMock = vi.fn()

vi.stubGlobal('fetch', fetchMock)

beforeAll(() => {
  fetchMock.mockImplementation(() =>
    Promise.reject(new Error('fetch not mocked for this test')),
  )
})

beforeEach(() => {
  resetMockDb()
  fetchMock.mockClear()
  fetchMock.mockImplementation(() =>
    Promise.reject(new Error('fetch not mocked for this test')),
  )
})


