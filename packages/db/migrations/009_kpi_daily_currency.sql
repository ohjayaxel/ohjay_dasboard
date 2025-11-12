alter table if exists kpi_daily
  add column if not exists currency text;

alter table if exists meta_backfill_jobs
  add column if not exists aggregate_currency boolean not null default false;


