-- Seed data for local development only.

insert into tenants (id, slug, name)
values (
  gen_random_uuid(),
  'orange-juice-demo',
  'Orange Juice Demo Tenant'
)
on conflict (slug) do nothing;

with t as (
  select id from tenants where slug = 'orange-juice-demo'
)
insert into members (id, tenant_id, user_id, role, email)
select
  gen_random_uuid(),
  t.id,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'platform_admin',
  'admin@ohjay.co'
from t
on conflict (tenant_id, user_id) do nothing;

