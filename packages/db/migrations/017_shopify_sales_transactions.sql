-- Create shopify_sales_transactions table for 100% matching with Shopify Sales/Finance reports
-- This table stores one row per line item transaction (SALE or RETURN events)

create table if not exists shopify_sales_transactions(
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  shopify_order_id text not null,
  shopify_order_name text,
  shopify_order_number text,
  shopify_refund_id text,
  shopify_line_item_id text,
  event_type text not null check (event_type in ('SALE', 'RETURN')),
  event_date date not null,
  currency text,
  product_sku text,
  product_title text,
  variant_title text,
  quantity numeric not null default 0,
  gross_sales numeric not null default 0,
  discounts numeric not null default 0,
  returns numeric not null default 0,
  shipping numeric not null default 0,
  tax numeric not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (tenant_id, shopify_order_id, shopify_line_item_id, event_type, event_date, shopify_refund_id)
);

-- Create index for fast aggregation queries by date
create index if not exists idx_shopify_sales_transactions_tenant_event_date
  on shopify_sales_transactions(tenant_id, event_date);

-- Create index for order lookups
create index if not exists idx_shopify_sales_transactions_order
  on shopify_sales_transactions(tenant_id, shopify_order_id);

-- Enable RLS
alter table shopify_sales_transactions enable row level security;

-- Create RLS policies (using existing pattern)
create policy shopify_sales_transactions_read on shopify_sales_transactions
  for select using (
    exists(
      select 1 from members m
      where m.tenant_id = shopify_sales_transactions.tenant_id
        and m.user_id = auth.uid()
    )
  );

create policy shopify_sales_transactions_write on shopify_sales_transactions
  for insert with check (
    exists(
      select 1 from members x
      where x.tenant_id = shopify_sales_transactions.tenant_id
        and x.user_id = auth.uid()
        and x.role in ('platform_admin','admin')
    )
  );

create policy shopify_sales_transactions_update on shopify_sales_transactions
  for update using (
    exists(
      select 1 from members x
      where x.tenant_id = shopify_sales_transactions.tenant_id
        and x.user_id = auth.uid()
        and x.role in ('platform_admin','admin')
    )
  );

