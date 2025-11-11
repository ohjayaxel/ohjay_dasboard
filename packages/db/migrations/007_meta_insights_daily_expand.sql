-- Expand meta_insights_daily to support breakdown-aware, idempotent upserts.
-- Run with: supabase db execute packages/db/migrations/007_meta_insights_daily_expand.sql

set check_function_bodies = off;

alter table if exists meta_insights_daily
  add column if not exists level text,
  add column if not exists entity_id text,
  add column if not exists date_stop date,
  add column if not exists action_report_time text,
  add column if not exists attribution_window text,
  add column if not exists breakdowns_key text,
  add column if not exists breakdowns_hash text,
  add column if not exists breakdowns jsonb,
  add column if not exists actions jsonb,
  add column if not exists action_values jsonb,
  add column if not exists unique_clicks numeric,
  add column if not exists inline_link_clicks numeric,
  add column if not exists campaign_name text,
  add column if not exists adset_name text,
  add column if not exists ad_name text,
  add column if not exists purchases numeric,
  add column if not exists add_to_cart numeric,
  add column if not exists leads numeric,
  add column if not exists revenue numeric,
  add column if not exists purchase_roas jsonb,
  add column if not exists cost_per_action_type jsonb,
  add column if not exists reach numeric,
  add column if not exists frequency numeric,
  add column if not exists cpm numeric,
  add column if not exists cpc numeric,
  add column if not exists ctr numeric,
  add column if not exists objective text,
  add column if not exists effective_status text,
  add column if not exists configured_status text,
  add column if not exists buying_type text,
  add column if not exists daily_budget numeric,
  add column if not exists lifetime_budget numeric,
  add column if not exists currency text;

alter table if exists meta_insights_daily
  drop constraint if exists meta_insights_daily_pkey;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'meta_insights_daily_unique_key'
  ) then
    alter table meta_insights_daily
      add constraint meta_insights_daily_unique_key
      unique (tenant_id, date, level, entity_id, action_report_time, attribution_window, breakdowns_hash);
  end if;
end $$;

create index if not exists idx_meta_insights_daily_actions on meta_insights_daily using gin (actions);
create index if not exists idx_meta_insights_daily_breakdowns on meta_insights_daily using gin (breakdowns);


