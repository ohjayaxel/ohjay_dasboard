# Instructions for Running Verification

## Prerequisites

Make sure you have environment variables set up. Either:

1. **Export variables manually** (recommended if running from production):
   ```bash
   export NEXT_PUBLIC_SUPABASE_URL="your-supabase-url"
   export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
   ```

2. **Create `.env.local` file** in root directory:
   ```bash
   NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ```

3. **Or source environment file**: `source env/local.prod.sh` (if it exists)

## Step 1: Run Backfill

This will populate historical daily sales data for both modes (shopify & financial):

```bash
source env/local.prod.sh  # or your env file
pnpm tsx scripts/shopify_backfill.ts --tenant=skinome --since=2025-01-01
```

**Expected output:**
- Fetches orders from Shopify via GraphQL
- Calculates daily sales for both modes
- Inserts/updates `shopify_daily_sales` table with `mode` column
- Progress logs showing orders processed per day

## Step 2: Verify Shopify Mode

Compare our Shopify Mode calculations against Shopify Analytics:

```bash
source env/local.prod.sh  # or your env file
pnpm tsx scripts/verify_shopify_mode.ts --tenant=skinome --dates=2025-11-28,2025-11-29,2025-11-30
```

**Expected output:**
- Net Sales (EXCL tax) for each date in Shopify Mode
- Orders count per date
- You'll need to manually compare with Shopify Analytics values

## Step 3: Compare Both Modes

Compare Shopify Mode vs Financial Mode side-by-side:

```bash
source env/local.prod.sh  # or your env file
pnpm tsx scripts/compare_modes.ts --tenant=skinome --from=2025-11-28 --to=2025-11-30
```

This will show:
- Net Sales for both modes per day
- Order counts per day
- Total differences and percentage
- Explanation of what the difference represents

## Step 4: Test API Endpoint

Test the new API endpoint for both modes. First, get your tenant ID:

```bash
# In Supabase SQL editor or via psql:
SELECT id FROM tenants WHERE slug = 'skinome';
```

Then test both modes:

### Shopify Mode:
```bash
curl "http://localhost:3000/api/shopify/daily-sales?tenantId=YOUR_TENANT_ID&mode=shopify&from=2025-11-28&to=2025-11-30"
```

### Financial Mode:
```bash
curl "http://localhost:3000/api/shopify/daily-sales?tenantId=YOUR_TENANT_ID&mode=financial&from=2025-11-28&to=2025-11-30"
```

**Note:** Replace `YOUR_TENANT_ID` with the actual tenant UUID from your database.

## Expected Results

### Shopify Mode vs Shopify Analytics
- Should match Shopify Analytics "Net Sales (excl. tax)" 1:1
- Differences should be 0 or rounding errors (< 0.01 SEK)
- Date grouping: `order.createdAt` (Stockholm timezone)
- Includes: cancelled orders, orders without payment
- Refunds: booked on `refund.processedAt` date

### Financial Mode
- Date grouping: `transaction.processedAt` (first successful SALE)
- Excludes: cancelled orders, orders without successful payment
- Refunds: booked on `refund.processedAt` date
- Represents "real money in/out" per day

## Summary of Differences (Nov 28-30)

After running both verifications, you should see:
- **Shopify Mode**: Higher Net Sales (includes cancelled, no-payment orders)
- **Financial Mode**: Lower Net Sales (only orders with successful payment)
- **Difference**: The gap represents orders that were created but never paid, or were cancelled

