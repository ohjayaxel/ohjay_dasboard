import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_FUNCTION_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_RETRIES = 5;

type Source = 'meta' | 'google_ads' | 'shopify';

type InvokeOptions = {
  source: Source
  payload?: Record<string, unknown>
  attempt?: number
};

function ensureEnv() {
  if (!SUPABASE_URL) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL environment variable.');
  }

  if (!SUPABASE_FUNCTION_KEY) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable.');
  }
}

async function invokeWithRetry({ source, payload, attempt = 1 }: InvokeOptions): Promise<{ status: number }> {
  ensureEnv();

  const supabase = createClient(SUPABASE_URL!, SUPABASE_FUNCTION_KEY!, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const response = await supabase.functions.invoke(`sync-${source}`, {
    body: payload ?? {},
  });

  if (response.error === null) {
    return { status: response.response?.status ?? 200 };
  }

  const status = response.response?.status ?? 500;
  const error = response.error;

  if (status === 429 || status >= 500) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Failed to invoke sync-${source} after ${attempt} attempts.`);
    }

    const delay = Math.pow(2, attempt - 1) * 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return invokeWithRetry({ source, payload, attempt: attempt + 1 });
  }

  throw new Error(`Invocation failed: ${status} ${error?.message ?? 'Unknown error'}`);
}

export async function triggerSyncJob(source: Source) {
  // TODO: add per-tenant rate limiting using Redis/Upstash.
  return invokeWithRetry({ source });
}

export async function triggerSyncJobForTenant(source: Source, tenantId: string) {
  return invokeWithRetry({
    source,
    payload: { tenantId },
  });
}

