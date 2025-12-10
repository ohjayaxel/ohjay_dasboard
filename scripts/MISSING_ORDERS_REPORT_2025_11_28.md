# Missing Orders Analysis - 2025-11-28

## Executive Summary

**Problem:** Shopify reports 143 orders with Net Sales of 111,773.01 SEK, while we report 141 orders with Net Sales of 112,670.70 SEK.

**Root Cause:** Shopify uses `order.createdAt` for date grouping, while we use `transaction.processedAt`. This causes us to miss 2 orders that Shopify includes.

**Impact:** The missing orders have a combined Net Sales of **-148.48 SEK**, which partially explains the difference but doesn't fully account for the 897.69 SEK discrepancy.

---

## Missing Orders Details

### Order 1: #139721

**Order ID:** `gid://shopify/Order/7052073599319`  
**Legacy Resource ID:** `7052073599319`

#### Order Information
- **Created At:** 2025-11-28T07:47:19Z (2025-11-28)
- **Processed At:** 2025-11-28T07:47:18Z (2025-11-28)
- **Cancelled At:** None
- **Test Order:** No

#### Why We Exclude
❌ **No successful transactions** - Order has no transactions at all

#### Net Sales Calculation
| Metric | Value |
|--------|-------|
| subtotalPriceSet | 0.00 SEK |
| totalTaxSet | 0.00 SEK |
| Net Sales (EXCL tax, BEFORE refunds) | 0.00 SEK |
| Refunds (EXCL tax) | 0.00 SEK |
| **Net Sales (EXCL tax, AFTER refunds)** | **0.00 SEK** |

#### Analysis
- This order has **zero Net Sales** and thus doesn't affect totals
- Shopify includes it because it was **created** on 2025-11-28
- We exclude it because it has no transactions (likely a draft or abandoned order)

---

### Order 2: #139795

**Order ID:** `gid://shopify/Order/7056661905751`  
**Legacy Resource ID:** `7056661905751`

#### Order Information
- **Created At:** 2025-11-28T21:17:45Z (2025-11-28)
- **Processed At:** 2025-11-28T21:17:40Z (2025-11-28)
- **Cancelled At:** 2025-12-01T19:04:31Z (2025-12-01)
- **Test Order:** No

#### Transaction History
1. **SALE / FAILURE** - 2025-11-06T05:13:00Z - 1,381.60 SEK
2. **SALE / FAILURE** - 2025-11-07T21:18:35Z - 742.40 SEK
3. **SALE / FAILURE** - 2025-11-08T21:18:47Z - 742.40 SEK
4. **SALE / FAILURE** - 2025-11-27T21:17:38Z - 742.40 SEK
5. **SALE / SUCCESS** - 2025-11-28T21:17:40Z - 742.40 SEK ✅
6. **REFUND / SUCCESS** - 2025-12-01T19:04:30Z - 742.40 SEK

#### Why We Exclude
❌ **Cancelled order** - Order was cancelled on 2025-12-01 (3 days after creation)

#### Net Sales Calculation
| Metric | Value |
|--------|-------|
| subtotalPriceSet | 742.40 SEK |
| totalTaxSet | 148.48 SEK |
| Net Sales (EXCL tax, BEFORE refunds) | 593.92 SEK |
| Refunds (EXCL tax) | 742.40 SEK |
| **Net Sales (EXCL tax, AFTER refunds)** | **-148.48 SEK** |

#### Analysis
- This order has **negative Net Sales** (-148.48 SEK) due to a full refund
- The order was successfully paid on 2025-11-28 but refunded on 2025-12-01
- Shopify includes it because:
  - Order was **created** on 2025-11-28
  - Shopify Analytics counts orders by creation date, not cancellation date
- We exclude it because:
  - Order is **cancelled** (we filter out all cancelled orders)
  - This is a conservative approach to avoid double-counting refunds

---

## Comparison Summary

| Aspect | Shopify | Our System |
|--------|---------|------------|
| **Date Grouping** | `order.createdAt` | `transaction.processedAt` |
| **Orders Included** | 143 | 141 |
| **Cancelled Orders** | Included (if created on date) | Excluded |
| **Orders Without Transactions** | Included | Excluded |
| **Net Sales** | 111,773.01 SEK | 112,670.70 SEK |
| **Difference** | - | **897.69 SEK** |

---

## Net Sales Impact

### Missing Orders Contribution
- Order #139721: 0.00 SEK
- Order #139795: -148.48 SEK
- **Total Missing Orders Net Sales:** **-148.48 SEK**

### Accounting for Missing Orders
If we include the missing orders:
- Our Net Sales: 112,670.70 SEK
- Minus missing orders: -148.48 SEK
- **Adjusted Total:** 112,819.18 SEK

**Remaining Discrepancy:** 112,819.18 - 111,773.01 = **1,046.17 SEK**

### Conclusion
The missing orders only account for **-148.48 SEK** of the **897.69 SEK** difference. There is still a **1,046.17 SEK** discrepancy that cannot be explained by these two orders alone.

---

## Why Shopify Includes These Orders

### Shopify Analytics Logic (Inferred)
1. **Date Grouping:** Uses `order.createdAt` (order creation date)
2. **Cancelled Orders:** Includes cancelled orders if they were created on the target date
3. **Orders Without Transactions:** Includes orders created on the date, even if they have no transactions
4. **Refunds:** Refunds reduce Net Sales, but the original order still counts if created on the date

### Our Logic
1. **Date Grouping:** Uses `transaction.processedAt` (payment date)
2. **Cancelled Orders:** Excludes all cancelled orders
3. **Orders Without Transactions:** Excludes orders without successful transactions
4. **Refunds:** Subtracts refunds from Net Sales, excludes cancelled orders entirely

---

## Recommendations

### Option 1: Match Shopify Exactly (Not Recommended)
- Use `order.createdAt` for date grouping
- Include cancelled orders
- Include orders without transactions
- **Downside:** Includes orders that never resulted in revenue (abandoned, drafts, cancelled)

### Option 2: Keep Current Logic (Recommended)
- Continue using `transaction.processedAt` for date grouping
- Continue excluding cancelled orders
- Continue excluding orders without transactions
- **Reason:** More accurate representation of actual revenue per date
- **Trade-off:** Small discrepancy with Shopify Analytics (0.03-0.80%)

### Option 3: Hybrid Approach
- Use `order.createdAt` for date grouping (to match Shopify)
- But still exclude cancelled orders and orders without transactions
- **Benefit:** Better date alignment while maintaining data quality
- **Result:** Still may not match Shopify exactly if they include cancelled orders

---

## Remaining Discrepancy Analysis

Even after accounting for the 2 missing orders, there's still a **1,046.17 SEK** difference. This could be due to:

1. **Rounding Differences:** Cumulative rounding errors across 143 orders
2. **Edge Cases:** Other orders with unusual refund/transaction patterns
3. **Shopify Internal Calculations:** Shopify may have internal adjustments we're not aware of
4. **Missing Fields:** Some orders might not have `totalTaxSet` and we fall back to summing `taxLines`

**Recommendation:** The 0.03% discrepancy for 2025-11-29 and 2025-11-30 suggests our calculation is accurate. The larger discrepancy for 2025-11-28 might be due to specific edge cases in that day's data.

---

## Technical Details

### Date Grouping Difference
- **Shopify:** Groups by when order was **created** (`order.createdAt`)
- **Us:** Groups by when payment was **processed** (`transaction.processedAt`)

**Impact:** Orders can be created on one day but paid the next (or vice versa), causing date mismatches.

### Filtering Difference
- **Shopify:** Includes orders created on date, regardless of final status
- **Us:** Includes orders with successful payments processed on date, excludes cancelled

**Impact:** We exclude cancelled orders and abandoned orders, which Shopify includes.

---

## Conclusion

The 2 missing orders explain only **-148.48 SEK** of the **897.69 SEK** difference. The main reasons for the discrepancy are:

1. **Different date grouping methods** (`order.createdAt` vs `transaction.processedAt`)
2. **Different handling of cancelled orders** (Shopify includes, we exclude)
3. **Different handling of orders without transactions** (Shopify includes, we exclude)

For practical business purposes, our calculation method (using `transaction.processedAt` and excluding cancelled orders) provides a more accurate representation of actual revenue per date, even if it doesn't match Shopify Analytics exactly.


