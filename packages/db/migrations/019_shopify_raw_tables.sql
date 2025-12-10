-- Create raw data tables for Shopify pipeline
-- These tables store complete raw Shopify API responses as JSONB
-- Separate from processed/aggregated tables to allow complete reconstruction

-- Raw orders table - stores complete order data from Shopify
create table if not exists shopify_orders_raw(
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  shopify_order_id text not null,
  shopify_order_name text,
  shopify_order_number text,
  raw_data jsonb not null,
  created_at_shopify timestamptz,
  processed_at_shopify timestamptz,
  updated_at_shopify timestamptz not null,
  cancelled_at_shopify timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (tenant_id, shopify_order_id)
);

-- Raw line items table - stores complete line item data
create table if not exists shopify_line_items_raw(
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  shopify_order_id text not null,
  shopify_line_item_id text not null,
  raw_data jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (tenant_id, shopify_order_id, shopify_line_item_id)
);

-- Raw transactions table - stores transaction data from GraphQL or REST
create table if not exists shopify_transactions_raw(
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  shopify_order_id text not null,
  shopify_transaction_id text not null,
  raw_data jsonb not null,
  kind text,
  status text,
  processed_at_shopify timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (tenant_id, shopify_order_id, shopify_transaction_id)
);

-- Raw refunds table - stores refund data
create table if not exists shopify_refunds_raw(
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  shopify_order_id text not null,
  shopify_refund_id text not null,
  raw_data jsonb not null,
  created_at_shopify timestamptz not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (tenant_id, shopify_order_id, shopify_refund_id)
);

-- Raw refund line items table - stores refund line item details
create table if not exists shopify_refund_line_items_raw(
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  shopify_order_id text not null,
  shopify_refund_id text not null,
  shopify_line_item_id text not null,
  raw_data jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (tenant_id, shopify_order_id, shopify_refund_id, shopify_line_item_id)
);

-- Create indexes for efficient queries
create index if not exists idx_shopify_orders_raw_tenant_updated
  on shopify_orders_raw(tenant_id, updated_at_shopify);

create index if not exists idx_shopify_orders_raw_tenant_order
  on shopify_orders_raw(tenant_id, shopify_order_id);

create index if not exists idx_shopify_line_items_raw_tenant_order
  on shopify_line_items_raw(tenant_id, shopify_order_id);

create index if not exists idx_shopify_transactions_raw_tenant_order
  on shopify_transactions_raw(tenant_id, shopify_order_id);

create index if not exists idx_shopify_transactions_raw_processed_at
  on shopify_transactions_raw(tenant_id, processed_at_shopify)
  where processed_at_shopify is not null;

create index if not exists idx_shopify_refunds_raw_tenant_order
  on shopify_refunds_raw(tenant_id, shopify_order_id);

create index if not exists idx_shopify_refunds_raw_created_at
  on shopify_refunds_raw(tenant_id, created_at_shopify);

create index if not exists idx_shopify_refund_line_items_raw_tenant_refund
  on shopify_refund_line_items_raw(tenant_id, shopify_refund_id);

-- Enable RLS
alter table shopify_orders_raw enable row level security;
alter table shopify_line_items_raw enable row level security;
alter table shopify_transactions_raw enable row level security;
alter table shopify_refunds_raw enable row level security;
alter table shopify_refund_line_items_raw enable row level security;

-- Create RLS policies using existing pattern
create policy shopify_orders_raw_read on shopify_orders_raw
  for select using (
    exists(
      select 1 from members m
      where m.tenant_id = shopify_orders_raw.tenant_id
        and m.user_id = auth.uid()
    )
  );

create policy shopify_orders_raw_write on shopify_orders_raw
  for insert with check (
    exists(
      select 1 from members x
      where x.tenant_id = shopify_orders_raw.tenant_id
        and x.user_id = auth.uid()
        and x.role in ('platform_admin','admin')
    )
  );

create policy shopify_orders_raw_update on shopify_orders_raw
  for update using (
    exists(
      select 1 from members x
      where x.tenant_id = shopify_orders_raw.tenant_id
        and x.user_id = auth.uid()
        and x.role in ('platform_admin','admin')
    )
  );

create policy shopify_line_items_raw_read on shopify_line_items_raw
  for select using (
    exists(
      select 1 from members m
      where m.tenant_id = shopify_line_items_raw.tenant_id
        and m.user_id = auth.uid()
    )
  );

create policy shopify_line_items_raw_write on shopify_line_items_raw
  for insert with check (
    exists(
      select 1 from members x
      where x.tenant_id = shopify_line_items_raw.tenant_id
        and x.user_id = auth.uid()
        and x.role in ('platform_admin','admin')
    )
  );

create policy shopify_line_items_raw_update on shopify_line_items_raw
  for update using (
    exists(
      select 1 from members x
      where x.tenant_id = shopify_line_items_raw.tenant_id
        and x.user_id = auth.uid()
        and x.role in ('platform_admin','admin')
    )
  );

create policy shopify_transactions_raw_read on shopify_transactions_raw
  for select using (
    exists(
      select 1 from members m
      where m.tenant_id = shopify_transactions_raw.tenant_id
        and m.user_id = auth.uid()
    )
  );

create policy shopify_transactions_raw_write on shopify_transactions_raw
  for insert with check (
    exists(
      select 1 from members x
      where x.tenant_id = shopify_transactions_raw.tenant_id
        and x.user_id = auth.uid()
        and x.role in ('platform_admin','admin')
    )
  );

create policy shopify_transactions_raw_update on shopify_transactions_raw
  for update using (
    exists(
      select 1 from members x
      where x.tenant_id = shopify_transactions_raw.tenant_id
        and x.user_id = auth.uid()
        and x.role in ('platform_admin','admin')
    )
  );

create policy shopify_refunds_raw_read on shopify_refunds_raw
  for select using (
    exists(
      select 1 from members m
      where m.tenant_id = shopify_refunds_raw.tenant_id
        and m.user_id = auth.uid()
    )
  );

create policy shopify_refunds_raw_write on shopify_refunds_raw
  for insert with check (
    exists(
      select 1 from members x
      where x.tenant_id = shopify_refunds_raw.tenant_id
        and x.user_id = auth.uid()
        and x.role in ('platform_admin','admin')
    )
  );

create policy shopify_refunds_raw_update on shopify_refunds_raw
  for update using (
    exists(
      select 1 from members x
      where x.tenant_id = shopify_refunds_raw.tenant_id
        and x.user_id = auth.uid()
        and x.role in ('platform_admin','admin')
    )
  );

create policy shopify_refund_line_items_raw_read on shopify_refund_line_items_raw
  for select using (
    exists(
      select 1 from members m
      where m.tenant_id = shopify_refund_line_items_raw.tenant_id
        and m.user_id = auth.uid()
    )
  );

create policy shopify_refund_line_items_raw_write on shopify_refund_line_items_raw
  for insert with check (
    exists(
      select 1 from members x
      where x.tenant_id = shopify_refund_line_items_raw.tenant_id
        and x.user_id = auth.uid()
        and x.role in ('platform_admin','admin')
    )
  );

create policy shopify_refund_line_items_raw_update on shopify_refund_line_items_raw
  for update using (
    exists(
      select 1 from members x
      where x.tenant_id = shopify_refund_line_items_raw.tenant_id
        and x.user_id = auth.uid()
        and x.role in ('platform_admin','admin')
    )
  );

