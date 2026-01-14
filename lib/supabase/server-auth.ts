import 'server-only'

import { createServerClient, type CookieOptions } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY

function ensureEnvVars() {
  if (!SUPABASE_URL) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL environment variable.')
  if (!SUPABASE_ANON_KEY) throw new Error('Missing NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable.')
}

/**
 * Server client for Server Components.
 * Note: Server Components can't set cookies; token refresh will happen on the client.
 */
export function getSupabaseServerComponentClient(): SupabaseClient {
  ensureEnvVars()
  const cookieStore = cookies()
  return createServerClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      // Server Components can't mutate cookies — no-op.
      setAll() {},
    },
  })
}

/**
 * Server client for Route Handlers / Server Actions where cookie mutation is allowed.
 */
export function getSupabaseServerActionClient(): SupabaseClient {
  ensureEnvVars()
  const cookieStore = cookies()
  return createServerClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options?: CookieOptions }>) {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options)
        }
      },
    },
  })
}


