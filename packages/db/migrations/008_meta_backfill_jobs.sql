create table if not exists meta_backfill_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  account_id text not null,
  since date not null,
  until date not null,
  mode text not null check (mode in ('fast', 'full')),
  config_json jsonb not null,
  status text not null default 'pending'
    check (status in ('pending','running','completed','failed','paused')),
  progress_completed integer not null default 0,
  progress_total integer not null default 0,
  chunk_count integer,
  combination_count integer,
  aggregate_currency boolean not null default false,
  started_at timestamptz,
  finished_at timestamptz,
  error_message text,
  logs_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_meta_backfill_jobs_status_created
  on meta_backfill_jobs (status, created_at);

create index if not exists idx_meta_backfill_jobs_tenant
  on meta_backfill_jobs (tenant_id, created_at);

create index if not exists idx_meta_backfill_jobs_account
  on meta_backfill_jobs (account_id, created_at);

create or replace function meta_backfill_jobs_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_meta_backfill_jobs_set_updated on meta_backfill_jobs;

create trigger trg_meta_backfill_jobs_set_updated
before update on meta_backfill_jobs
for each row
execute function meta_backfill_jobs_set_updated_at();

create or replace function claim_meta_backfill_job()
returns meta_backfill_jobs
language plpgsql
as $$
declare
  job meta_backfill_jobs;
begin
  update meta_backfill_jobs
  set status = 'running',
      started_at = coalesce(started_at, now())
  where id in (
    select id
    from meta_backfill_jobs
    where status = 'pending'
    order by created_at asc
    limit 1
    for update skip locked
  )
  returning * into job;

  return job;
end;
$$;

