// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type SupabaseClient = ReturnType<typeof createClient<any, any, any>>;

const SOURCE = 'google_ads';

function getEnvVar(key: string) {
  const value = Deno.env.get(key);
  if (!value) {
    throw new Error(`Missing ${key} environment variable.`);
  }
  return value;
}

function createSupabaseClient(): SupabaseClient {
  const url = getEnvVar('SUPABASE_URL');
  const serviceRole = getEnvVar('SUPABASE_SERVICE_ROLE_KEY');

  return createClient(url, serviceRole, {
    auth: { persistSession: false },
  });
}

type GoogleConnection = {
  tenant_id: string;
  access_token_enc: unknown;
  refresh_token_enc: unknown;
  expires_at: string | null;
  meta: Record<string, any> | null;
};

type GoogleInsightRow = {
  tenant_id: string;
  date: string;
  customer_id: string;
  campaign_id: string | null;
  adgroup_id: string | null;
  ad_id: string | null;
  cost_micros: number | null;
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  revenue: number | null;
};

type JobResult = {
  tenantId: string;
  status: 'succeeded' | 'failed';
  error?: string;
  inserted?: number;
};

function mockGoogleInsights(tenantId: string): GoogleInsightRow[] {
  const today = new Date().toISOString().slice(0, 10);
  return [
    {
      tenant_id: tenantId,
      date: today,
      customer_id: '000-000-0000',
      campaign_id: null,
      adgroup_id: null,
      ad_id: null,
      cost_micros: 2_500_000,
      impressions: 5400,
      clicks: 260,
      conversions: 18,
      revenue: 1450.75,
    },
  ];
}

function microsToSpend(micros: number | null): number {
  if (!micros) return 0;
  return micros / 1_000_000;
}

function aggregateKpis(rows: GoogleInsightRow[]) {
  const byDate = new Map<string, { spend: number; clicks: number; conversions: number; revenue: number }>();

  for (const row of rows) {
    const existing = byDate.get(row.date) ?? { spend: 0, clicks: 0, conversions: 0, revenue: 0 };
    existing.spend += microsToSpend(row.cost_micros ?? 0);
    existing.clicks += row.clicks ?? 0;
    existing.conversions += row.conversions ?? 0;
    existing.revenue += row.revenue ?? 0;
    byDate.set(row.date, existing);
  }

  return Array.from(byDate.entries()).map(([date, values]) => {
    const aov = values.conversions > 0 ? values.revenue / values.conversions : null;
    const cos = values.revenue > 0 ? values.spend / values.revenue : null;
    const roas = values.spend > 0 ? values.revenue / values.spend : null;

    return {
      date,
      spend: values.spend || null,
      clicks: values.clicks || null,
      conversions: values.conversions || null,
      revenue: values.revenue || null,
      aov,
      cos,
      roas,
    };
  });
}

async function upsertJobLog(client: SupabaseClient, payload: {
  tenantId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  error?: string;
  startedAt: string;
  finishedAt?: string;
}) {
  const { error } = await client.from('jobs_log').insert({
    tenant_id: payload.tenantId,
    source: SOURCE,
    status: payload.status,
    started_at: payload.startedAt,
    finished_at: payload.finishedAt ?? null,
    error: payload.error ?? null,
  });

  if (error) {
    console.error(`Failed to write jobs_log for tenant ${payload.tenantId}:`, error);
  }
}

// Note: Token refresh for Google Ads should be handled by refreshGoogleAdsTokenIfNeeded
// in lib/integrations/googleads.ts before sync runs. This function just checks expiration
// and logs a warning if token is expired or about to expire.
function checkTokenExpiration(connection: GoogleConnection, tenantId: string): void {
  if (!connection.expires_at) {
    return; // No expiration date - assume long-lived token
  }

  const expiresAt = new Date(connection.expires_at).getTime();
  const now = Date.now();
  const fiveMinutesFromNow = now + 5 * 60 * 1000;

  if (expiresAt < fiveMinutesFromNow) {
    const minutesUntilExpiration = Math.ceil((expiresAt - now) / (1000 * 60));
    console.warn(
      `[sync-googleads] Token for tenant ${tenantId} is expired or expires within 5 minutes (${minutesUntilExpiration} minutes). ` +
      `Token refresh should be handled before sync runs.`,
    );
  }
}

async function processTenant(client: SupabaseClient, connection: GoogleConnection): Promise<JobResult> {
  const tenantId = connection.tenant_id;
  const startedAt = new Date().toISOString();

  let jobLogInserted = false;
  try {
    await upsertJobLog(client, { tenantId, status: 'running', startedAt });
    jobLogInserted = true;
  } catch (logError) {
    console.error(`Failed to insert initial job log for tenant ${tenantId}:`, logError);
    // Continue anyway - we'll try to update it later
  }

  try {
    // TODO: integrate with Google Ads API using stored credentials.
    const insights = mockGoogleInsights(tenantId);

    if (insights.length > 0) {
      const { error: upsertError } = await client.from('google_insights_daily').upsert(insights, {
        onConflict: 'tenant_id,date,customer_id,campaign_id,adgroup_id,ad_id',
      });

      if (upsertError) {
        throw new Error(upsertError.message);
      }

      const aggregates = aggregateKpis(insights);
      const kpiRows = aggregates.map((row) => ({
        tenant_id: tenantId,
        date: row.date,
        source: SOURCE,
        spend: row.spend,
        clicks: row.clicks,
        conversions: row.conversions,
        revenue: row.revenue,
        aov: row.aov,
        cos: row.cos,
        roas: row.roas,
      }));

      const { error: kpiError } = await client.from('kpi_daily').upsert(kpiRows, {
        onConflict: 'tenant_id,date,source',
      });

      if (kpiError) {
        throw new Error(kpiError.message);
      }
    }

    await upsertJobLog(client, {
      tenantId,
      status: 'succeeded',
      startedAt,
      finishedAt: new Date().toISOString(),
    });

    return { tenantId, status: 'succeeded', inserted: insights.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertJobLog(client, {
      tenantId,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: message,
    });

    return { tenantId, status: 'failed', error: message };
  } finally {
    // Ensure job log is always updated, even if the try-catch above fails
    if (jobLogInserted) {
      try {
        // Check if job log was already updated (has finished_at)
        const { data: existingJob } = await client
          .from('jobs_log')
          .select('finished_at')
          .eq('tenant_id', tenantId)
          .eq('source', SOURCE)
          .eq('status', 'running')
          .eq('started_at', startedAt)
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        // Only update if still in running status
        if (existingJob && !existingJob.finished_at) {
          await upsertJobLog(client, {
            tenantId,
            status: 'failed',
            startedAt,
            finishedAt: new Date().toISOString(),
            error: 'Job execution was interrupted or failed unexpectedly',
          });
        }
      } catch (finalError) {
        // Last resort - log but don't throw
        console.error(`Failed to update job log in finally block for tenant ${tenantId}:`, finalError);
      }
    }
  }
}

serve(async () => {
  try {
    const client = createSupabaseClient();
    const { data, error } = await client
      .from('connections')
      .select('tenant_id, access_token_enc, refresh_token_enc, expires_at, meta')
      .eq('source', SOURCE)
      .eq('status', 'connected');

    if (error) {
      throw new Error(`Failed to list connections: ${error.message}`);
    }

    const connections = (data as GoogleConnection[]) ?? [];
    const results: JobResult[] = [];

    for (const connection of connections) {
      // Check token expiration and log warning if needed
      checkTokenExpiration(connection, connection.tenant_id);

      const result = await processTenant(client, connection);
      results.push(result);
    }

    return new Response(JSON.stringify({ source: SOURCE, results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sync-${SOURCE}] failed`, message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});

