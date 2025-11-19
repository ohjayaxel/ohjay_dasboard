-- Add meta KPI aggregation cron job (safety net)
-- This should be run after the main meta_sync_schedule.sql

-- Remove previous job if it exists.
do $$
begin
  perform cron.unschedule('meta-kpi-aggregate-hourly');
exception
  when others then
    null;
end
$$;

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

