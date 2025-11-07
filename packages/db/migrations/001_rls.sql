-- Row Level Security configuration for Orange Juice multi-tenant schema.

alter table tenants enable row level security;
alter table members enable row level security;
alter table connections enable row level security;
alter table meta_insights_daily enable row level security;
alter table google_insights_daily enable row level security;
alter table shopify_orders enable row level security;
alter table kpi_daily enable row level security;
alter table jobs_log enable row level security;

create or replace function is_member_of(tenant uuid)
returns boolean language sql stable as $$
  select exists(
    select 1 from members m
    where m.tenant_id = tenant and m.user_id = auth.uid()
  );
$$;

create policy tenants_read on tenants
for select using (is_member_of(id));

create policy members_read on members
for select using (is_member_of(tenant_id));

create policy members_write on members
for insert with check (
  exists(select 1 from members x
    where x.tenant_id = members.tenant_id
      and x.user_id = auth.uid()
      and x.role in ('platform_admin','admin'))
);

create policy members_update on members
for update using (
  exists(select 1 from members x
    where x.tenant_id = members.tenant_id
      and x.user_id = auth.uid()
      and x.role in ('platform_admin','admin'))
);

do $$
declare t regclass;
begin
  for t in select unnest(array[
    'connections'::regclass,
    'meta_insights_daily'::regclass,
    'google_insights_daily'::regclass,
    'shopify_orders'::regclass,
    'kpi_daily'::regclass,
    'jobs_log'::regclass
  ]) loop
    execute format($f$
      create policy %I_read on %s
      for select using (is_member_of(tenant_id));
    $f$, t::text, t::text);
  end loop;
end$$;

do $$
declare t regclass;
begin
  for t in select unnest(array[
    'connections'::regclass,
    'meta_insights_daily'::regclass,
    'google_insights_daily'::regclass,
    'shopify_orders'::regclass,
    'kpi_daily'::regclass,
    'jobs_log'::regclass
  ]) loop
    execute format($f$
      create policy %I_write on %s
      for insert with check (
        exists(select 1 from members x
          where x.tenant_id = %s.tenant_id
            and x.user_id = auth.uid()
            and x.role in ('platform_admin','admin'))
      );
    $f$, t::text, t::text, t::text);
  end loop;
end$$;

