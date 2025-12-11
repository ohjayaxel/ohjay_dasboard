import { NextResponse } from 'next/server';

import { formatSyncFailureAlert, sendSlackMessage } from '@/lib/notifications/slack';
import { getSupabaseServiceClient } from '@/lib/supabase/server';

const FAILURE_RATE_THRESHOLD = 0.5; // Alert if more than 50% of jobs fail
const MIN_JOBS_FOR_ALERT = 3; // Need at least 3 jobs to trigger alert
const TIME_WINDOW_HOURS = 24; // Check last 24 hours
// Check if Slack webhook URL is configured (check for both undefined and empty string)
const SLACK_ALERTS_ENABLED = !!process.env.SLACK_WEBHOOK_URL && process.env.SLACK_WEBHOOK_URL.trim().length > 0;

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

    // Send Slack alerts if there are issues and Slack is configured
    console.log(`[jobs/check-failure-rate] Slack alerts enabled: ${SLACK_ALERTS_ENABLED}, Status: ${result.status}, Alerts: ${alerts.length}, Consecutive: ${consecutiveFailures.length}`);
    
    if (SLACK_ALERTS_ENABLED && result.status === 'alert') {
      try {
        // Get tenant names for better alert context
        const tenantIds = new Set<string>();
        alerts.forEach(a => tenantIds.add(a.tenant_id));
        consecutiveFailures.forEach(c => tenantIds.add(c.tenant_id));

        const { data: tenants } = await client
          .from('tenants')
          .select('id, name')
          .in('id', Array.from(tenantIds));

        const tenantMap = new Map<string, string>();
        tenants?.forEach(t => tenantMap.set(t.id, t.name));

        // Send alert for each high failure rate
        console.log(`[jobs/check-failure-rate] Sending ${alerts.length} high failure rate alerts to Slack`);
        for (const alert of alerts) {
          const tenantName = tenantMap.get(alert.tenant_id);
          const slackMessage = formatSyncFailureAlert({
            source: alert.source,
            tenantId: alert.tenant_id,
            tenantName,
            failureRate: alert.failure_rate,
            totalJobs: alert.total_jobs,
            failedJobs: alert.failed_jobs,
          });

          const sent = await sendSlackMessage(slackMessage);
          console.log(`[jobs/check-failure-rate] Sent alert for ${alert.source}:${alert.tenant_id} - Success: ${sent}`);
        }

        // Send alert for each consecutive failure
        console.log(`[jobs/check-failure-rate] Sending ${consecutiveFailures.length} consecutive failure alerts to Slack`);
        for (const failure of consecutiveFailures) {
          const tenantName = tenantMap.get(failure.tenant_id);
          const slackMessage = formatSyncFailureAlert({
            source: failure.source,
            tenantId: failure.tenant_id,
            tenantName,
            consecutiveFailures: failure.consecutive_count,
            lastFailureAt: failure.last_failure_at,
          });

          const sent = await sendSlackMessage(slackMessage);
          console.log(`[jobs/check-failure-rate] Sent consecutive failure alert for ${failure.source}:${failure.tenant_id} - Success: ${sent}`);
        }
      } catch (slackError) {
        // Don't fail the endpoint if Slack fails, just log
        console.error('[jobs/check-failure-rate] Failed to send Slack alerts:', slackError);
      }
    } else if (!SLACK_ALERTS_ENABLED) {
      console.warn('[jobs/check-failure-rate] SLACK_WEBHOOK_URL not configured, skipping Slack notifications');
    }

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


