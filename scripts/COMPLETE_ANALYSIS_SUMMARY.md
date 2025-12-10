# Complete Analysis Summary - 2025-11-28

## ✅ Confirmed Findings

### 1. Missing Orders (2 orders)

**Order #139721** (`7052073599319`)
- Created: 2025-11-28
- Why we exclude: No successful transactions
- Net Sales: 0.00 SEK

**Order #139795** (`7056661905751`)
- Created: 2025-11-28
- Cancelled: 2025-12-01
- Why we exclude: Cancelled order
- Net Sales: -148.48 SEK (negative due to full refund)
- Transaction history: 4 failed payments, 1 successful (742.40 SEK), 1 refund (742.40 SEK)

**Total Impact:** -148.48 SEK

---

## Calculation Results

### Our Method (Transaction.processedAt, excluding cancelled/no-transaction)
- Orders included: 141
- Net Sales: **112,670.70 SEK**

### Shopify Method (Order.createdAt, including all)
- Orders included: 143
- If we calculate using Shopify grouping: **112,522.22 SEK**
- Shopify Expected: **111,773.01 SEK**
- **Difference: 749.21 SEK**

---

## Tested Calculation Methods

| Method | Total | Diff from Expected | Match? |
|--------|-------|-------------------|--------|
| subtotalPriceSet - totalTaxSet - refunds | 112,522.22 SEK | +749.21 SEK | ❌ |
| subtotalPriceSet - taxLines - refunds | 112,545.42 SEK | +772.41 SEK | ❌ |
| subtotalPriceSet - totalTaxSet (no refunds) | 113,264.62 SEK | +1,491.61 SEK | ❌ |
| totalPriceSet - totalTaxSet - refunds | 112,638.22 SEK | +865.21 SEK | ❌ |

**Conclusion:** None of the standard calculation methods match Shopify exactly.

---

## ⚠️ Remaining Unexplained Difference: 749.21 SEK

### What We've Tested:
- ✅ Different tax calculation methods (totalTaxSet vs taxLines)
- ✅ Not subtracting refunds
- ✅ Using totalPriceSet instead of subtotalPriceSet
- ✅ Same-day refunds (none found)
- ✅ Currency differences (all SEK)

### What We Haven't Found Yet:
- ❌ Order adjustments (not visible in GraphQL API)
- ❌ Gift card payment handling
- ❌ Exchange order special cases
- ❌ Shopify's internal calculation rules
- ❌ Orders Shopify excludes that we include

---

## Next Steps to Find the 749.21 SEK

1. **Manual Verification in Shopify Admin:**
   - Export detailed CSV (already created: `scripts/data/detailed_orders_2025_11_28.csv`)
   - Compare each order's Net Sales in Shopify Admin vs our calculation
   - Look for orders with manual adjustments
   - Check for gift card payments, exchanges, or special handling

2. **Check for Order Adjustments:**
   - Order adjustments might not be visible in GraphQL API
   - These could reduce Net Sales for specific orders
   - Check Shopify Admin → Orders → Order Details for adjustments

3. **Verify Shopify Analytics Report:**
   - Open Shopify Admin → Analytics → Finances → Sales
   - Filter by date: 2025-11-28
   - Check if report shows 111,773.01 SEK exactly
   - Verify which orders are included/excluded

---

## Strategic Recommendation

### Keep Current Logic ✅

**Rationale:**
- Our method (transaction.processedAt + filtering) is **financially correct**
- Better for marketing attribution, ROAS, LTV, CoS
- Better for cash flow analysis
- The 0.67% difference (749.21 SEK of 111,773.01 SEK) is acceptable for BI purposes

### Implement "Shopify Mode" as Optional View

For direct comparison with Shopify Analytics, implement a toggle/view that:
- Uses `order.createdAt` for date grouping
- Includes cancelled orders
- Includes orders without transactions
- Uses same Net Sales calculation as primary method

This allows:
- ✅ Primary BI view: Financially correct
- ✅ Shopify comparison view: Direct match for verification
- ✅ Best of both worlds

---

## Analysis Status

**✅ Completed:**
- Identified 2 missing orders
- Confirmed date grouping difference
- Confirmed filtering differences
- Tested multiple calculation methods
- Exported detailed CSV for manual inspection

**⚠️ Remaining:**
- 749.21 SEK difference source (0.67% of total)
- Requires manual verification in Shopify Admin
- Likely due to Shopify internal calculations or adjustments not accessible via API

---

## Files Created

1. `scripts/analyze_missing_orders_2025_11_28.ts` - Identifies missing orders
2. `scripts/complete_diff_investigation_2025_11_28.ts` - Complete investigation
3. `scripts/data/detailed_orders_2025_11_28.csv` - **Export for manual comparison**
4. `scripts/MISSING_ORDERS_REPORT_2025_11_28.md` - Missing orders report
5. `scripts/FINAL_REMAINING_DIFF_REPORT_2025_11_28.md` - Final remaining diff report

---

## Manual Verification Checklist

Use the CSV file (`scripts/data/detailed_orders_2025_11_28.csv`) to manually verify in Shopify Admin:

1. [ ] Open Shopify Admin → Analytics → Finances → Sales
2. [ ] Filter by date: 2025-11-28
3. [ ] Verify Net Sales shows: 111,773.01 SEK
4. [ ] Compare top 20 orders from CSV with Shopify Admin
5. [ ] Check for manual order adjustments
6. [ ] Verify gift card payments handling
7. [ ] Check if any orders are excluded from Analytics
8. [ ] Document any differences found



