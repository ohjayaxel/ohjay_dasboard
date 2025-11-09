const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_FUNCTION_KEY =
  process.env.SUPABASE_EDGE_FUNCTION_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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
    throw new Error('Missing SUPABASE_EDGE_FUNCTION_KEY (or SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY) environment variable.');
  }
}

async function invokeWithRetry({ source, payload, attempt = 1 }: InvokeOptions): Promise<{ status: number }> {
  ensureEnv();

  const normalized = SUPABASE_URL!.replace(/\/$/, '');
  const response = await fetch(`${normalized}/functions/v1/sync-${source}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_FUNCTION_KEY!,
      Authorization: `Bearer ${SUPABASE_FUNCTION_KEY}`,
    },
    body: JSON.stringify(payload ?? {}),
  });

  if (response.ok) {
    return { status: response.status };
  }

  const status = response.status;
  const body = await response.text();

  if (status === 429 || status >= 500) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Failed to invoke sync-${source} after ${attempt} attempts.`);
    }

    const delay = Math.pow(2, attempt - 1) * 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return invokeWithRetry({ source, payload, attempt: attempt + 1 });
  }

  throw new Error(`Invocation failed: ${status} ${body || 'Unknown error'}`);
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

