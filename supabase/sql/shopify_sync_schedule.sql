-- Shopify sync scheduling script (pg_cron + pg_net)
-- ------------------------------------------------
-- Instructions:
--   1. Run this script in the Supabase SQL Editor (prod project) or via psql against the prod DB.
--   2. If secrets already exist, comment out the CREATE statements and use vault.update_secret instead.
--
--   Secrets used:
--     - shopify_sync_project_url      → https://<project-ref>.supabase.co
--     - shopify_sync_function_key     → SUPABASE_EDGE_FUNCTION_KEY (service role) used for Edge Function auth
--
--   Reference: https://supabase.com/docs/guides/functions/schedule-functions

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store/update secrets in Supabase Vault (idempotent - creates or updates).
do $$
begin
  -- Try to update first (if exists)
  perform vault.update_secret('shopify_sync_project_url', 'https://punicovacaktaszqcckp.supabase.co');
exception
  when others then
    -- If update fails, create new
    perform vault.create_secret('https://punicovacaktaszqcckp.supabase.co', 'shopify_sync_project_url');
end
$$;

do $$
begin
  -- Try to update first (if exists)
  -- IMPORTANT: do not commit service role keys.
  -- Set/update this secret manually in Supabase Vault:
  --   name: shopify_sync_function_key
  --   value: <YOUR_SUPABASE_SERVICE_ROLE_JWT>
  perform vault.update_secret('shopify_sync_function_key', '<SET_IN_SUPABASE_VAULT>');
exception
  when others then
    -- If update fails, create new
    perform vault.create_secret('<SET_IN_SUPABASE_VAULT>', 'shopify_sync_function_key');
end
$$;

-- Remove previous job if it exists.
do $$
begin
  perform cron.unschedule('shopify-sync-hourly');
exception
  when others then
    null;
end
$$;

-- Schedule sync-shopify every hour (ten minutes past) to avoid conflicts with Meta sync (five minutes past).
select
  cron.schedule(
    'shopify-sync-hourly',
    '10 * * * *',
    $$
    select
      net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'shopify_sync_project_url') || '/functions/v1/sync-shopify',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'shopify_sync_function_key')
        ),
        -- Optional: keep cron invocations small; Edge Function defaults to maxTenants=1 anyway.
        body := jsonb_build_object('maxTenants', 1)
      ) as request_id;
    $$
  );

