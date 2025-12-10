# Sales Calculation Modes

## Overview

The platform supports two parallel methods for calculating and reporting Shopify sales:

1. **Shopify Analytics Mode** - Matches Shopify Analytics reports as closely as possible
2. **Financial Mode** - Financially correct model reflecting actual cash flow

Both modes use the same Net Sales calculation per order:
- `net_sales_excl_tax_before_refunds = subtotalPriceSet - totalTaxSet`
- `total_refunds_excl_tax = SUM(refundLineItems.subtotalSet)`
- `net_sales_excl_tax_after_refunds = net_sales_excl_tax_before_refunds - total_refunds_excl_tax`

The difference lies in **which orders are included** and **which date is used for grouping**.

---

## Shopify Analytics Mode

**Goal:** Match Shopify Analytics reports exactly.

### Date Logic

- **Grouping key:** `order.createdAt` (converted to store timezone)
- Orders are grouped by when they were **created**, not when payment was processed

### Included Orders

**Includes:**
- ✅ Orders with or without successful transactions
- ✅ Cancelled orders (handled via refunds in Shopify Analytics)

**Excludes:**
- ❌ Test orders (`test = true`)

### Net Sales Calculation

**Sales (on order.createdAt date):**
- Add `net_sales_excl_tax_before_refunds` for all orders created on that date

**Refunds (on refund.createdAt date):**
- Subtract `refund_excl_tax` for refunds created on that date
- Refunds are separate negative entries on their creation date

**Formula:**
```
Shopify-mode day X = 
  SUM(net_sales_excl_tax_before_refunds for orders where createdAt = X)
  - SUM(refund_excl_tax for refunds where createdAt = X)
```

### Use Cases

- ✅ Direct comparison with Shopify Analytics dashboards
- ✅ Marketing attribution (when order was created)
- ✅ Understanding "order creation" trends

---

## Financial Mode

**Goal:** Financially correct model reflecting when money actually moves.

### Date Logic

- **Grouping key:** `transaction.processedAt` for:
  - First successful SALE transaction (for sales)
  - REFUND transaction (for refunds)
- Orders are grouped by when **payment was processed**, not when order was created

### Included Orders

**Includes:**
- ✅ Orders with at least one successful SALE transaction

**Excludes:**
- ❌ Cancelled orders
- ❌ Orders without successful transactions (no actual payment)

### Net Sales Calculation

**Sales (on transaction.processedAt date):**
- Add `net_sales_excl_tax_before_refunds` when payment was received

**Refunds (on refund.processedAt date):**
- Subtract `refund_excl_tax` when refund was processed
- Based on REFUND transaction processedAt

**Formula:**
```
Financial-mode day X = 
  SUM(net_sales_excl_tax_before_refunds for orders where first SALE.transaction.processedAt = X)
  - SUM(refund_excl_tax for refunds where refund.transaction.processedAt = X)
```

### Use Cases

- ✅ Cash flow analysis
- ✅ Financial reporting
- ✅ ROAS, LTV, CoS calculations
- ✅ Understanding "cash in / cash out" per day
- ✅ Primary BI/performance model

---

## Key Differences

| Aspect | Shopify Mode | Financial Mode |
|--------|-------------|----------------|
| **Date Grouping** | `order.createdAt` | `transaction.processedAt` |
| **Cancelled Orders** | Included | Excluded |
| **Orders Without Payment** | Included | Excluded |
| **Refund Date** | `refund.createdAt` | `refund.transaction.processedAt` |
| **Perspective** | Marketing (when order created) | Financial (when money moved) |

---

## Implementation

### Type Definition

```typescript
export type SalesMode = 'shopify' | 'financial';
```

### Core Function

```typescript
calculateDailySales(
  orders: ShopifyOrderWithTransactions[],
  mode: SalesMode,
  timezone: string = 'Europe/Stockholm'
): DailySalesRow[]
```

### Database Storage

Daily aggregations are stored in `shopify_daily_sales` table:

```sql
create table shopify_daily_sales(
  tenant_id uuid,
  date date,
  mode text check (mode in ('shopify', 'financial')),
  net_sales_excl_tax numeric,
  gross_sales_excl_tax numeric,
  refunds_excl_tax numeric,
  discounts_excl_tax numeric,
  orders_count integer,
  currency text,
  new_customer_net_sales numeric,
  returning_customer_net_sales numeric,
  guest_net_sales numeric,
  primary key (tenant_id, date, mode)
);
```

### API Usage

```typescript
GET /api/reports/daily-sales?mode=shopify
GET /api/reports/daily-sales?mode=financial
```

**Default:** `mode=financial` if not specified

---

## Customer Classification (New vs Returning)

The platform tracks customer classification separately for each mode to match Shopify Analytics behavior while maintaining financial accuracy.

### Database Storage

Customer classification is stored per order in `shopify_orders` table:

```sql
ALTER TABLE shopify_orders ADD COLUMN is_first_order_for_customer BOOLEAN;
ALTER TABLE shopify_orders ADD COLUMN customer_type_shopify_mode TEXT 
  CHECK (customer_type_shopify_mode IN ('FIRST_TIME', 'RETURNING', 'GUEST', 'UNKNOWN'));
ALTER TABLE shopify_orders ADD COLUMN customer_type_financial_mode TEXT 
  CHECK (customer_type_financial_mode IN ('NEW', 'RETURNING', 'GUEST', 'UNKNOWN'));
```

### Shopify Mode: Customer Classification

**Goal:** Match Shopify Analytics "New Customer Net Sales" as closely as possible.

**Definition of "New Customer" (FIRST_TIME):**
- An order is classified as **FIRST_TIME** if:
  1. `customer.createdAt` falls within the reporting period, **OR**
  2. `order.is_first_order_for_customer === true` (customer's first order ever)

**Definition of "Returning Customer" (RETURNING):**
- An order is classified as **RETURNING** if:
  - Customer has a `customer_id` (not a guest), **AND**
  - The order is NOT classified as FIRST_TIME

**Guests:**
- Orders without a `customer_id` are classified as **GUEST**

**Date Used:** `order.createdAt` (same as Net Sales date grouping)

**Notes:**
- Minor discrepancies (~5%) with Shopify Analytics may occur due to:
  - Timezone differences in customer creation dates
  - Edge cases with customer data (N/A customers)
  - Guest checkout handling
  - Refund date handling

### Financial Mode: Customer Classification

**Goal:** Stable, cash-flow accurate customer classification that doesn't change over time.

**Definition of "New Customer" (NEW):**
- An order is classified as **NEW** if:
  - `order.id === first_revenue_order_id` (customer's first revenue-generating order)
  - `first_revenue_order_id` = first order with `NetSales > 0` and not cancelled/full-refunded

**Definition of "Returning Customer" (RETURNING):**
- An order is classified as **RETURNING** if:
  - Customer has a `customer_id` (not a guest), **AND**
  - The order is NOT the customer's first revenue-generating order

**Guests:**
- Orders without a `customer_id` are classified as **GUEST**

**Date Used:** `transaction.processedAt` (same as Net Sales date grouping)

**Key Characteristics:**
- ✅ Classification is **stable** - doesn't change when customer history changes
- ✅ Based on **first revenue-generating order** (cash-flow accurate)
- ✅ Stored per order, so historical reports remain consistent

### Customer History Calculation

During backfill, customer history is calculated once per customer:

1. **Sort all orders** by `created_at` (ascending) for each customer
2. **Identify:**
   - `first_order_id_all_time` = first order ever (by `created_at`)
   - `first_revenue_order_id` = first order with `NetSales > 0` and not cancelled/full-refunded
3. **Set per order:**
   - `is_first_order_for_customer = (order.id === first_order_id_all_time)`

### Daily Sales Aggregation

Daily sales are aggregated by customer type per mode:

- `new_customer_net_sales` - Net sales from NEW/FIRST_TIME customers
- `returning_customer_net_sales` - Net sales from RETURNING customers
- `guest_net_sales` - Net sales from GUEST checkouts

All three sum to `net_sales_excl_tax`:
```
net_sales_excl_tax = new_customer_net_sales + returning_customer_net_sales + guest_net_sales
```

---

## Verification

### Shopify Mode Verification

Compare daily Net Sales EXCL tax against Shopify Analytics "Net sales (excl. tax)":

- **Expected difference:** 0 SEK or only rounding differences (0.01-0.05 SEK)
- **Test dates:** Use dates with known Shopify values (e.g., 2025-11-28, 2025-11-29, 2025-11-30)

### Financial Mode Verification

Verify:
- ✅ Cancelled orders do not contribute to sales
- ✅ Orders without successful transactions do not contribute
- ✅ Refunds hit on refund date (not order creation date)
- ✅ Reasonableness check: Sum of all days should reflect cash-based sales development

---

## When to Use Which Mode

### Use Shopify Mode When:
- Comparing directly with Shopify Analytics dashboards
- Analyzing marketing performance (attribution based on order creation)
- Understanding order creation trends
- Troubleshooting discrepancies with Shopify reports

### Use Financial Mode When:
- Financial reporting and cash flow analysis
- Calculating ROAS, LTV, CoS
- Understanding actual money movement
- Primary BI and performance analytics
- Planning and budgeting based on cash flow

---

## Technical Details

### Order Filtering

**Shopify Mode:**
```typescript
shouldIncludeOrder(order, 'shopify'):
  - Exclude if test = true
  - Include if financial_status in valid statuses
  - Include even if cancelled_at is set
  - Include even if no successful transactions
```

**Financial Mode:**
```typescript
shouldIncludeOrder(order, 'financial'):
  - Exclude if test = true
  - Exclude if cancelled_at is set
  - Exclude if no successful transactions
  - Include only if financial_status in valid statuses AND has successful SALE
```

### Date Determination

**Shopify Mode:**
```typescript
getOrderEventDate(order, 'shopify'):
  return toLocalDate(order.createdAt, timezone)

getRefundEventDate(refund, order, 'shopify'):
  return toLocalDate(refund.createdAt, timezone)
```

**Financial Mode:**
```typescript
getOrderEventDate(order, 'financial'):
  return toLocalDate(firstSuccessfulSale.processedAt, timezone)

getRefundEventDate(refund, order, 'financial'):
  return toLocalDate(refundTransaction.processedAt, timezone)
  // Fallback to refund.createdAt if no transaction found
```

---

## Files

- **Core Logic:** `lib/shopify/sales.ts`
- **Order Converter:** `lib/shopify/order-converter.ts`
- **Backfill:** `scripts/shopify_backfill.ts`
- **Live Sync:** `supabase/functions/sync-shopify/index.ts`
- **Webhook:** `app/api/webhooks/shopify/route.ts`
- **API:** `app/api/shopify/daily-sales/route.ts`
- **Migrations:** 
  - `packages/db/migrations/023_add_sales_modes.sql` - Sales modes support
  - `packages/db/migrations/025_add_customer_type_classification.sql` - Customer classification fields
  - `packages/db/migrations/026_add_guest_net_sales_to_daily_sales.sql` - Customer type net sales columns
  - `packages/db/migrations/027_add_customer_type_indexes.sql` - Indexes for customer classification



