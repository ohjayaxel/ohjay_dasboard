const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_FUNCTION_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_RETRIES = 5;

type Source = 'meta' | 'google_ads' | 'shopify';

function ensureEnv() {
  if (!SUPABASE_URL) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL environment variable.');
  }

  if (!SUPABASE_FUNCTION_KEY) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable.');
  }
}

function getFunctionUrl(source: Source) {
  ensureEnv();
  const normalized = SUPABASE_URL!.replace(/\/$/, '');
  return `${normalized}/functions/v1/sync-${source}`;
}

async function invokeWithRetry(source: Source, attempt = 1): Promise<{ status: number }> {
  const url = getFunctionUrl(source);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_FUNCTION_KEY}`,
      apikey: SUPABASE_FUNCTION_KEY!,
    },
    body: JSON.stringify({}),
  });

  if (response.ok) {
    return { status: response.status };
  }

  if (response.status === 429 || response.status >= 500) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Failed to invoke sync-${source} after ${attempt} attempts.`);
    }

    const delay = Math.pow(2, attempt - 1) * 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return invokeWithRetry(source, attempt + 1);
  }

  const body = await response.text();
  throw new Error(`Invocation failed: ${response.status} ${body}`);
}

export async function triggerSyncJob(source: Source) {
  // TODO: add per-tenant rate limiting using Redis/Upstash.
  return invokeWithRetry(source);
}

