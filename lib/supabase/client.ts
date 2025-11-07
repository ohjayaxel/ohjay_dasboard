import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let browserClient: SupabaseClient | undefined;

function ensureBrowserEnv() {
  if (typeof window === 'undefined') {
    throw new Error('getSupabaseBrowserClient must only be invoked in the browser.');
  }
}

function ensureEnvVars() {
  if (!SUPABASE_URL) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL environment variable.');
  }

  if (!SUPABASE_ANON_KEY) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable.');
  }
}

export function getSupabaseBrowserClient(): SupabaseClient {
  ensureBrowserEnv();
  ensureEnvVars();

  if (!browserClient) {
    browserClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  }

  return browserClient;
}

export function resetSupabaseBrowserClientCache(): void {
  browserClient = undefined;
}

