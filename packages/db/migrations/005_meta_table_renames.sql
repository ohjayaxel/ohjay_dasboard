-- Rename legacy Meta tables to improved naming convention. This script is idempotent.

do $$
begin
  if to_regclass('public.meta_ad_accounts') is not null then
    alter table public.meta_ad_accounts rename to meta_accounts;
  end if;
end$$;

do $$
begin
  if to_regclass('public.meta_accounts') is not null then
    begin
      alter table public.meta_accounts rename constraint meta_ad_accounts_pkey to meta_accounts_pkey;
    exception
      when undefined_object then null;
    end;
    alter table public.meta_accounts enable row level security;
  end if;
end$$;

do $$
declare
  rename_read boolean;
  rename_write boolean;
begin
  if to_regclass('public.meta_accounts') is not null then
    alter index if exists meta_ad_accounts_tenant_idx rename to meta_accounts_tenant_idx;

    select exists(
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = 'meta_accounts'
        and policyname = 'meta_ad_accounts_read'
    ) into rename_read;

    if rename_read then
      begin
        alter policy meta_ad_accounts_read on meta_accounts rename to meta_accounts_read;
      exception
        when undefined_object then null;
      end;
    end if;

    select exists(
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = 'meta_accounts'
        and policyname = 'meta_ad_accounts_write'
    ) into rename_write;

    if rename_write then
      begin
        alter policy meta_ad_accounts_write on meta_accounts rename to meta_accounts_write;
      exception
        when undefined_object then null;
      end;
    end if;
  end if;
end$$;

do $$
begin
  if to_regclass('public.meta_insights_fact') is not null then
    alter table public.meta_insights_fact rename to meta_insights_levels;
  end if;
end$$;

do $$
begin
  if to_regclass('public.meta_insights_levels') is not null then
    begin
      alter table public.meta_insights_levels rename constraint meta_insights_fact_pkey to meta_insights_levels_pkey;
    exception
      when undefined_object then null;
    end;
    begin
      alter table public.meta_insights_levels rename constraint meta_insights_fact_ad_account_id_fkey to meta_insights_levels_ad_account_id_fkey;
    exception
      when undefined_object then null;
    end;
    alter table public.meta_insights_levels enable row level security;
  end if;
end$$;

alter index if exists meta_insights_fact_tenant_date_idx rename to meta_insights_levels_tenant_date_idx;
alter index if exists meta_insights_fact_account_date_idx rename to meta_insights_levels_account_date_idx;

do $$
begin
  if to_regclass('public.meta_insights_levels') is not null then
    begin
      alter policy meta_insights_fact_read on meta_insights_levels rename to meta_insights_levels_read;
    exception
      when undefined_object then null;
    end;
    begin
      alter policy meta_insights_fact_write on meta_insights_levels rename to meta_insights_levels_write;
    exception
      when undefined_object then null;
    end;
  end if;
end$$;

do $$
begin
  if to_regclass('public.meta_accounts') is not null and to_regclass('public.meta_insights_levels') is not null then
    alter table public.meta_insights_levels
      drop constraint if exists meta_insights_levels_ad_account_id_fkey,
      add constraint meta_insights_levels_ad_account_id_fkey
        foreign key (ad_account_id) references meta_accounts(id) on delete cascade;
  end if;
end$$;

