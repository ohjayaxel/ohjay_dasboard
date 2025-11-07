import { NextResponse } from 'next/server';

import { triggerSyncJob } from '@/lib/jobs/scheduler';
import { checkRateLimit } from '@/lib/security/rate-limit';

const VALID_SOURCES = new Set(['meta', 'google_ads', 'shopify']);

async function handleRequest(request: Request) {
  const url = new URL(request.url);
  const source = url.searchParams.get('source');

  if (!source || !VALID_SOURCES.has(source)) {
    return NextResponse.json(
      { error: 'Invalid or missing source parameter.' },
      { status: 400 },
    );
  }

  // TODO: Validate Supabase session and ensure caller has platform_admin privileges.

  const identityKey = request.headers.get('x-user-id') ?? request.headers.get('x-forwarded-for') ?? 'anonymous';
  const rateLimit = await checkRateLimit(`jobs-sync:${identityKey}:${source}`);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please retry later.' },
      {
        status: 429,
        headers: rateLimit.retryAfter ? { 'Retry-After': Math.ceil(rateLimit.retryAfter / 1000).toString() } : undefined,
      },
    );
  }

  try {
    const result = await triggerSyncJob(source as 'meta' | 'google_ads' | 'shopify');
    return NextResponse.json({ status: 'queued', result });
  } catch (error) {
    console.error(`[jobs/sync] Failed to trigger job (${source})`, error);
    return NextResponse.json(
      { error: 'Failed to trigger sync job.' },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return handleRequest(request);
}

export async function POST(request: Request) {
  return handleRequest(request);
}

