import { NextResponse } from 'next/server';

import { getSupabaseServiceClient } from '@/lib/supabase/server';

const FAILURE_RATE_THRESHOLD = 0.5; // Alert if more than 50% of jobs fail
const MIN_JOBS_FOR_ALERT = 3; // Need at least 3 jobs to trigger alert
const TIME_WINDOW_HOURS = 24; // Check last 24 hours

async function handleRequest(request: Request) {
  try {
    const url = new URL(request.url);
    const source = url.searchParams.get('source'); // Optional: filter by source

    const client = getSupabaseServiceClient();
    const timeWindow = new Date();
    timeWindow.setHours(timeWindow.getHours() - TIME_WINDOW_HOURS);

    // Build query
    let query = client
      .from('jobs_log')
      .select('source, status, tenant_id')
      .gte('started_at', timeWindow.toISOString());

    if (source) {
      query = query.eq('source', source);
    }

    const { data: jobs, error: jobsError } = await query;

    if (jobsError) {
      throw new Error(`Failed to fetch jobs: ${jobsError.message}`);
    }

    // Group by source and tenant
    const jobStats = new Map<string, { total: number; failed: number; succeeded: number; tenants: Set<string> }>();

    if (jobs && jobs.length > 0) {
      for (const job of jobs) {
        const key = `${job.source as string}:${job.tenant_id as string}`;
        if (!jobStats.has(key)) {
          jobStats.set(key, { total: 0, failed: 0, succeeded: 0, tenants: new Set([job.tenant_id as string]) });
        }
        const stats = jobStats.get(key)!;
        stats.total++;
        if (job.status === 'failed') {
          stats.failed++;
        } else if (job.status === 'succeeded') {
          stats.succeeded++;
        }
      }
    }

    // Check for problematic patterns
    const alerts: Array<{
      source: string;
      tenant_id: string;
      failure_rate: number;
      total_jobs: number;
      failed_jobs: number;
      succeeded_jobs: number;
    }> = [];

    for (const [key, stats] of jobStats.entries()) {
      if (stats.total >= MIN_JOBS_FOR_ALERT) {
        const failureRate = stats.failed / stats.total;
        if (failureRate >= FAILURE_RATE_THRESHOLD) {
          const [source, tenantId] = key.split(':');
          alerts.push({
            source,
            tenant_id: tenantId,
            failure_rate: failureRate,
            total_jobs: stats.total,
            failed_jobs: stats.failed,
            succeeded_jobs: stats.succeeded,
          });
        }
      }
    }

    // Also check for consecutive failures
    const { data: recentJobs, error: recentJobsError } = await client
      .from('jobs_log')
      .select('source, status, tenant_id, started_at')
      .gte('started_at', timeWindow.toISOString())
      .order('started_at', { ascending: false });

    const consecutiveFailures: Array<{
      source: string;
      tenant_id: string;
      consecutive_count: number;
      last_failure_at: string;
    }> = [];

    if (!recentJobsError && recentJobs) {
      // Group by source and tenant, then check for consecutive failures
      const jobSequences = new Map<string, Array<{ status: string; started_at: string }>>();

      for (const job of recentJobs) {
        const key = `${job.source as string}:${job.tenant_id as string}`;
        if (!jobSequences.has(key)) {
          jobSequences.set(key, []);
        }
        jobSequences.get(key)!.push({
          status: job.status as string,
          started_at: job.started_at as string,
        });
      }

      for (const [key, sequence] of jobSequences.entries()) {
        // Sort by started_at descending (most recent first)
        sequence.sort((a, b) => b.started_at.localeCompare(a.started_at));

        // Count consecutive failures from the most recent job
        let consecutiveCount = 0;
        for (const job of sequence) {
          if (job.status === 'failed') {
            consecutiveCount++;
          } else {
            break;
          }
        }

        if (consecutiveCount >= 3) {
          const [source, tenantId] = key.split(':');
          consecutiveFailures.push({
            source,
            tenant_id: tenantId,
            consecutive_count: consecutiveCount,
            last_failure_at: sequence[0]?.started_at || '',
          });
        }
      }
    }

    const result = {
      status: alerts.length > 0 || consecutiveFailures.length > 0 ? 'alert' : 'ok',
      high_failure_rate: alerts,
      consecutive_failures: consecutiveFailures,
      checked_at: new Date().toISOString(),
      time_window_hours: TIME_WINDOW_HOURS,
    };

    return NextResponse.json(result, {
      status: result.status === 'alert' ? 503 : 200,
    });
  } catch (error) {
    console.error('[jobs/check-failure-rate] Failed to check failure rate', error);
    return NextResponse.json(
      { error: 'Failed to check failure rate.', details: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return handleRequest(request);
}

