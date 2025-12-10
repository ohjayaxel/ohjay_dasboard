import { NextResponse } from 'next/server';

import { getSupabaseServiceClient } from '@/lib/supabase/server';

const STUCK_JOB_THRESHOLD_HOURS = 2; // Warn if jobs running for more than 2 hours

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const source = url.searchParams.get('source') || 'meta';

    const client = getSupabaseServiceClient();
    const threshold = new Date();
    threshold.setHours(threshold.getHours() - STUCK_JOB_THRESHOLD_HOURS);

    // Check for stuck jobs
    const { data: stuckJobs, error: stuckError } = await client
      .from('jobs_log')
      .select('id, tenant_id, started_at')
      .eq('source', source)
      .eq('status', 'running')
      .lt('started_at', threshold.toISOString());

    if (stuckError) {
      return NextResponse.json(
        { status: 'error', message: 'Failed to check job health', error: stuckError.message },
        { status: 500 },
      );
    }

    // Check last successful sync
    const { data: lastSuccess, error: lastSuccessError } = await client
      .from('jobs_log')
      .select('started_at, finished_at')
      .eq('source', source)
      .eq('status', 'succeeded')
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastSuccessError) {
      return NextResponse.json(
        { status: 'error', message: 'Failed to check last success', error: lastSuccessError.message },
        { status: 500 },
      );
    }

    // Check last failed sync
    const { data: lastFailure, error: lastFailureError } = await client
      .from('jobs_log')
      .select('started_at, finished_at, error')
      .eq('source', source)
      .eq('status', 'failed')
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastFailureError) {
      return NextResponse.json(
        { status: 'error', message: 'Failed to check last failure', error: lastFailureError.message },
        { status: 500 },
      );
    }

    const health = {
      source,
      status: 'healthy' as const,
      stuckJobs: stuckJobs?.length || 0,
      lastSuccess: lastSuccess?.finished_at || null,
      lastFailure: lastFailure?.finished_at || null,
      lastFailureError: lastFailure?.error || null,
    };

    // Mark as unhealthy if there are stuck jobs
    if (health.stuckJobs > 0) {
      health.status = 'unhealthy';
    }

    return NextResponse.json(health, {
      status: health.status === 'healthy' ? 200 : 503,
    });
  } catch (error) {
    return NextResponse.json(
      { status: 'error', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}


