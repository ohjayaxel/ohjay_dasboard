# Order-Level Reconciliation Instructions - 2025-11-28

## Overview

This reconciliation identifies the exact order IDs that contribute to the remaining **749.21 SEK** difference between our calculation and Shopify's expected Net Sales.

## Summary

- **Orders included by BOTH Shopify and our method:** 141
- **Our calculated total (141 orders):** 112,670.70 SEK
- **Shopify expected total (141 orders):** 111,921.49 SEK
  - (Shopify total 143 orders: 111,773.01 SEK)
  - (Missing 2 orders: -148.48 SEK)
- **Expected difference:** 749.21 SEK

## CSV File

**File:** `scripts/data/reconciliation_orders_2025_11_28.csv`

**Columns:**
- `order_id` - Shopify order ID
- `order_name` - Order number (e.g., #139755)
- `created_at` - Order creation timestamp
- `shopify_net_sales` - **TO BE FILLED** - Net Sales from Shopify Admin
- `our_net_sales` - Our calculated Net Sales
- `diff` - **AUTO CALCULATED** - Difference (our_net_sales - shopify_net_sales)
- `subtotal_price_set` - Order subtotal (after discounts, incl. tax)
- `total_tax_set` - Total tax amount
- `refunds_excl_tax` - Total refunds (excluding tax)
- `has_refunds` - Whether order has refunds
- `refund_dates` - Dates of refunds (semicolon-separated)
- `refund_details` - Detailed refund information
- `has_shipping_refund` - Whether order has shipping refunds
- `currency` - Order currency (should be SEK)
- `notes` - For manual notes

## Step-by-Step Reconciliation Process

### Step 1: Open CSV File
Open `scripts/data/reconciliation_orders_2025_11_28.csv` in Excel, Google Sheets, or any spreadsheet application.

### Step 2: For Each Order (Start with Top 5-10 Largest)

1. **Copy Order Name** (e.g., `#139755`)
2. **Open Shopify Admin**
   - Go to: https://admin.shopify.com/store/[your-store]/orders
   - Search for the order number
3. **Find Net Sales Value**
   - In the order details page, look for "Financial Summary" or "Analytics" section
   - Find "Net Sales" value (excluding tax, after refunds)
   - **Important:** Use the value that matches Shopify Analytics (not total price)
4. **Fill in CSV**
   - Copy the Net Sales value
   - Paste it in the `shopify_net_sales` column for that order
5. **Calculate Difference**
   - In Excel/Sheets: `diff = our_net_sales - shopify_net_sales`
   - Or let the spreadsheet auto-calculate if you set up the formula

### Step 3: Sort by Difference

Once you've filled in Shopify Net Sales for all orders (or at least the top 20-30):

1. **Sort by ABS(diff) DESC**
   - This will show orders with largest differences first
2. **Identify Problem Orders**
   - Orders with `|diff| > 10 SEK` are likely candidates
   - Focus on the top 10-20 orders by absolute difference

### Step 4: Verify Total

1. **Sum all differences:** `SUM(diff)` should equal **749.21 SEK**
2. **If it doesn't match exactly:**
   - Check for rounding errors (should be within 0.01 SEK)
   - Verify you've filled in all 141 orders
   - Check for any manual calculation errors

### Step 5: Analyze Top Differences

For the **top 5 orders by absolute difference**, check:

1. **Refunds**
   - Do refund dates match?
   - Are all refunds included?
   - Are shipping refunds included?

2. **Order Adjustments**
   - Check if order has manual adjustments in Shopify Admin
   - Adjustments might not be visible in GraphQL API

3. **Currency Differences**
   - Check `presentment_money` vs `shop_money`
   - All orders should be SEK, but verify

4. **Gift Card Payments**
   - Check if order has gift card payments
   - Shopify might handle these differently

5. **Tax Calculation**
   - Verify `totalTaxSet` matches Shopify's tax calculation
   - Check if there are tax adjustments

## Top 5 Orders to Check First

Based on our Net Sales calculation:

1. **Order #139755** (ID: 7053776945495)
   - Our Net Sales: 4,246.12 SEK
   - Subtotal: 5,307.67 SEK
   - Tax: 1,061.55 SEK
   - Refunds: 0.00 SEK

2. **Order #139706** (ID: 7051679203671)
   - Our Net Sales: 1,744.00 SEK
   - Subtotal: 2,180.00 SEK
   - Tax: 436.00 SEK
   - Refunds: 0.00 SEK

3. **Order #139684** (ID: 7051576312151)
   - Our Net Sales: 1,616.64 SEK
   - Subtotal: 2,020.80 SEK
   - Tax: 404.16 SEK
   - Refunds: 0.00 SEK

4. **Order #139722** (ID: 7052097093975)
   - Our Net Sales: 1,616.64 SEK
   - Subtotal: 2,020.80 SEK
   - Tax: 404.16 SEK
   - Refunds: 0.00 SEK

5. **Order #139734** (ID: 7052597559639)
   - Our Net Sales: 1,583.92 SEK
   - Subtotal: 1,979.90 SEK
   - Tax: 395.98 SEK
   - Refunds: 0.00 SEK

## Expected Outcome

After completing the reconciliation:

1. **Identify exact order IDs** that contribute to the 749.21 SEK difference
2. **Document specific differences** for each problematic order
3. **Determine root cause:**
   - Order adjustments (not in GraphQL API)
   - Different refund handling
   - Currency/presentment money differences
   - Gift card payment handling
   - Shopify internal calculation rules

## Next Steps After Reconciliation

Once you've identified the orders with differences:

1. **For each problematic order:**
   - Document the exact difference
   - Note what Shopify includes/excludes
   - Check if it's a systematic issue or one-off

2. **Determine if we can fix it:**
   - If it's an order adjustment: We can't access via API, must accept difference
   - If it's refund handling: We can update our calculation logic
   - If it's currency: We can adjust our calculation
   - If it's gift cards: We can check for gift card payments in transactions

3. **Update our calculation logic** if possible, or document as accepted difference

## Files Generated

1. `scripts/data/reconciliation_orders_2025_11_28.csv` - Main reconciliation file
2. `scripts/order_level_reconciliation_2025_11_28.ts` - Script that generated the CSV
3. This instruction file



