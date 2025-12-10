-- Add indexes to improve performance for stuck job cleanup queries
-- and job status lookups

CREATE INDEX IF NOT EXISTS idx_jobs_log_source_status_started 
ON jobs_log(source, status, started_at);

CREATE INDEX IF NOT EXISTS idx_jobs_log_tenant_source_started 
ON jobs_log(tenant_id, source, started_at DESC);

-- Add comment
COMMENT ON INDEX idx_jobs_log_source_status_started IS 'Index for cleanup-stuck-jobs query: find running jobs by source and started_at';
COMMENT ON INDEX idx_jobs_log_tenant_source_started IS 'Index for job status lookups: find recent jobs for a tenant';


