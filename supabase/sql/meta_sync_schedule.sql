-- Meta sync scheduling script (pg_cron + pg_net)
-- ------------------------------------------------
-- Instructions:
--   1. Replace the placeholders below before running (project URL + function key).
--   2. Run this script in the Supabase SQL Editor (prod project) or via psql against the prod DB.
--   3. If secrets already exist, comment out the CREATE statements and use vault.update_secret instead.
--
--   Secrets used:
--     - meta_sync_project_url      → https://<project-ref>.supabase.co
--     - meta_sync_function_key     → SUPABASE_EDGE_FUNCTION_KEY (service role) used for Edge Function auth
--
--   Reference: https://supabase.com/docs/guides/functions/schedule-functions

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store/update secrets in Supabase Vault (idempotent - creates or updates).
do $$
begin
  -- Try to update first (if exists)
  perform vault.update_secret('meta_sync_project_url', 'https://punicovacaktaszqcckp.supabase.co');
exception
  when others then
    -- If update fails, create new
    perform vault.create_secret('https://punicovacaktaszqcckp.supabase.co', 'meta_sync_project_url');
end
$$;

do $$
begin
  -- Try to update first (if exists)
  -- IMPORTANT: do not commit service role keys.
  -- Set/update this secret manually in Supabase Vault:
  --   name: meta_sync_function_key
  --   value: <YOUR_SUPABASE_SERVICE_ROLE_JWT>
  perform vault.update_secret('meta_sync_function_key', '<SET_IN_SUPABASE_VAULT>');
exception
  when others then
    -- If update fails, create new
    perform vault.create_secret('<SET_IN_SUPABASE_VAULT>', 'meta_sync_function_key');
end
$$;

-- Remove previous jobs if they exist.
do $$
begin
  perform cron.unschedule('meta-sync-hourly');
exception
  when others then
    null;
end
$$;

do $$
begin
  perform cron.unschedule('meta-kpi-aggregate-hourly');
exception
  when others then
    null;
end
$$;

-- Schedule sync-meta every hour (five minutes past) with incremental payload.
select
  cron.schedule(
    'meta-sync-hourly',
    '5 * * * *',
    $$
    select
      net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'meta_sync_project_url') || '/functions/v1/sync-meta',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'meta_sync_function_key')
        ),
        body := jsonb_build_object('mode', 'incremental')
      ) as request_id;
    $$
  );

-- Schedule meta KPI aggregation every hour (10 minutes past) as a safety net.
-- This ensures kpi_daily is updated even if sync-meta times out or fails partially.
-- It aggregates from existing meta_insights_daily data for the last 3 days.
select
  cron.schedule(
    'meta-kpi-aggregate-hourly',
    '10 * * * *',
    $$
    select
      net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'meta_sync_project_url') || '/functions/v1/aggregate-meta-kpi',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'meta_sync_function_key')
        ),
        body := jsonb_build_object('since', (current_date - interval '3 days')::text, 'until', current_date::text)
      ) as request_id;
    $$
  );


