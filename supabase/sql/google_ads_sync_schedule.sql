-- Google Ads sync scheduling script (pg_cron + pg_net)
-- ------------------------------------------------
-- Instructions:
--   1. Replace the placeholders below before running (project URL + function key).
--   2. Run this script in the Supabase SQL Editor (prod project) or via psql against the prod DB.
--   3. If secrets already exist, comment out the CREATE statements and use vault.update_secret instead.
--
--   Secrets used:
--     - google_ads_sync_project_url      → https://<project-ref>.supabase.co
--     - google_ads_sync_function_key     → SUPABASE_EDGE_FUNCTION_KEY (service role) used for Edge Function auth
--
--   Reference: https://supabase.com/docs/guides/functions/schedule-functions

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store/update secrets in Supabase Vault (idempotent - creates or updates).
do $$
begin
  -- Try to update first (if exists)
  perform vault.update_secret('google_ads_sync_project_url', 'https://punicovacaktaszqcckp.supabase.co');
exception
  when others then
    -- If update fails, create new
    perform vault.create_secret('https://punicovacaktaszqcckp.supabase.co', 'google_ads_sync_project_url');
end
$$;

do $$
begin
  -- Try to update first (if exists)
  perform vault.update_secret('google_ads_sync_function_key', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB1bmljb3ZhY2FrdGFzenFjY2twIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MjUxMDM3MywiZXhwIjoyMDc4MDg2MzczfQ.3-9ftt3jy_D4O1gjn3mO7F4NkKzqzfcDcc--unJwXGc');
exception
  when others then
    -- If update fails, create new
    perform vault.create_secret('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB1bmljb3ZhY2FrdGFzenFjY2twIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MjUxMDM3MywiZXhwIjoyMDc4MDg2MzczfQ.3-9ftt3jy_D4O1gjn3mO7F4NkKzqzfcDcc--unJwXGc', 'google_ads_sync_function_key');
end
$$;

-- Remove previous job if it exists.
do $$
begin
  perform cron.unschedule('google-ads-sync-hourly');
exception
  when others then
    null;
end
$$;

-- Schedule sync-googleads every hour (10 minutes past) with incremental payload.
-- Runs 10 minutes past the hour to avoid conflicts with Meta sync (5 minutes past) and Shopify sync (15 minutes past).
select
  cron.schedule(
    'google-ads-sync-hourly',
    '10 * * * *',
    $$
    select
      net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'google_ads_sync_project_url') || '/functions/v1/sync-googleads',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'google_ads_sync_function_key')
        ),
        body := jsonb_build_object()
      ) as request_id;
    $$
  );

