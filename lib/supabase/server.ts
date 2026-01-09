import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Support both Next.js-style NEXT_PUBLIC_SUPABASE_URL and server-side SUPABASE_URL.
// Scripts/backfills often set SUPABASE_URL only; the app typically sets NEXT_PUBLIC_SUPABASE_URL.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let cachedServiceClient: SupabaseClient | undefined;

function assertServerEnv() {
  if (typeof window !== 'undefined') {
    throw new Error('getSupabaseServiceClient must only be invoked on the server.');
  }
}

function ensureEnvVars() {
  if (!SUPABASE_URL) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL environment variable.');
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable.');
  }
}

export function getSupabaseServiceClient(): SupabaseClient {
  assertServerEnv();
  ensureEnvVars();

  if (!cachedServiceClient) {
    cachedServiceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return cachedServiceClient;
}

export function resetSupabaseServiceClientCache(): void {
  cachedServiceClient = undefined;
}

