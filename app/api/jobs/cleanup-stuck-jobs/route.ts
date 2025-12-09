import { NextResponse } from 'next/server';

import { getSupabaseServiceClient } from '@/lib/supabase/server';

const VALID_SOURCES = new Set(['meta', 'google_ads', 'shopify']);
const STUCK_JOB_TIMEOUT_MINUTES = 60; // Mark jobs as failed if running for more than 60 minutes

async function handleRequest(request: Request) {
  const url = new URL(request.url);
  const source = url.searchParams.get('source');

  if (!source || !VALID_SOURCES.has(source)) {
    return NextResponse.json(
      { error: 'Invalid or missing source parameter.' },
      { status: 400 },
    );
  }

  try {
    const client = getSupabaseServiceClient();
    const timeoutThreshold = new Date();
    timeoutThreshold.setMinutes(timeoutThreshold.getMinutes() - STUCK_JOB_TIMEOUT_MINUTES);

    // Find stuck jobs (running for more than STUCK_JOB_TIMEOUT_MINUTES)
    const { data: stuckJobs, error: fetchError } = await client
      .from('jobs_log')
      .select('id, tenant_id, started_at')
      .eq('source', source)
      .eq('status', 'running')
      .lt('started_at', timeoutThreshold.toISOString());

    if (fetchError) {
      throw new Error(`Failed to fetch stuck jobs: ${fetchError.message}`);
    }

    if (!stuckJobs || stuckJobs.length === 0) {
      return NextResponse.json({
        status: 'ok',
        message: 'No stuck jobs found',
        cleaned: 0,
      });
    }

    // Update stuck jobs in batches to avoid timeout
    const BATCH_SIZE = 100;
    const stuckJobIds = stuckJobs.map((job) => job.id);
    let cleaned = 0;
    let errors: string[] = [];

    for (let i = 0; i < stuckJobIds.length; i += BATCH_SIZE) {
      const batch = stuckJobIds.slice(i, i + BATCH_SIZE);
      const { error: updateError } = await client
        .from('jobs_log')
        .update({
          status: 'failed',
          finished_at: new Date().toISOString(),
          error: `Job stuck in running status for more than ${STUCK_JOB_TIMEOUT_MINUTES} minutes. Marked as failed by cleanup job.`,
        })
        .in('id', batch);

      if (updateError) {
        errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${updateError.message}`);
      } else {
        cleaned += batch.length;
      }
    }

    if (errors.length > 0 && cleaned === 0) {
      throw new Error(`Failed to update stuck jobs: ${errors.join('; ')}`);
    }

    console.log(`[jobs/cleanup-stuck-jobs] Cleaned up ${cleaned}/${stuckJobs.length} stuck ${source} jobs`);

    return NextResponse.json({
      status: errors.length > 0 ? 'partial' : 'ok',
      message: `Cleaned up ${cleaned}/${stuckJobs.length} stuck jobs${errors.length > 0 ? ` (${errors.length} batches failed)` : ''}`,
      cleaned,
      total: stuckJobs.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error(`[jobs/cleanup-stuck-jobs] Failed to cleanup stuck jobs (${source})`, error);
    return NextResponse.json(
      { error: 'Failed to cleanup stuck jobs.', details: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return handleRequest(request);
}

