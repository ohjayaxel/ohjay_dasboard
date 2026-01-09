/**
 * @fileoverview
 * Sales calculation functions for Shopify Analytics Mode.
 * 
 * **Shopify Analytics Mode**: Matches Shopify Analytics reports as closely as possible.
 * 
 * These functions calculate Gross Sales, Net Sales, Discounts, and Returns:
 * - Gross Sales = product selling price × ordered quantity (line items only)
 * - Discounts = sum of all line item discounts
 * - Returns = value of returned items from refunds
 * - Net Sales = subtotal_price - total_tax - returns (EXCL tax)
 * 
 * No shipping, taxes, or fees are included in these calculations.
 */

/**
 * Sales calculation mode
 * 
 * Currently only 'shopify' mode is supported (matches Shopify Analytics).
 * Financial mode has been removed as it's not being used.
 */
export type SalesMode = 'shopify';

/**
 * Shopify Order structure (REST API-like)
 */
export type ShopifyOrder = {
  id: number | string;
  created_at: string;
  processed_at?: string | null; // When order was processed/paid (preferred for Shopify Analytics "Day" allocation)
  currency: string;
  financial_status: string;
  cancelled_at: string | null;
  subtotal_price?: string; // Subtotal after discounts, INCL tax (equivalent to subtotalPriceSet in GraphQL)
  total_tax?: string; // Total tax on order (equivalent to totalTaxSet in GraphQL)
  line_items: {
    id: number | string;
    product_id?: string; // Product ID for matching with CSV (extracted from variant or product GID)
    price: string; // Price per unit, as string
    quantity: number;
    total_discount: string; // Discount on this line item, as string
    tax?: string; // Total tax for this line item (across quantity), as string
  }[];
  total_discounts?: string; // Order-level total discounts (preferred over summing line_items)
  refunds?: {
    id: number | string;
    created_at: string;
    total_refunded?: string; // Refund total (likely INCL tax) from GraphQL totalRefundedSet
    adjustments?: Array<{
      reason?: string | null;
      amount?: string | null; // Adjustment amount (likely INCL tax)
      tax_amount?: string | null;
    }>;
    refund_line_items: {
      line_item_id: number | string;
      quantity: number;
      subtotal?: string; // Refund amount EXCL tax (equivalent to refundLineItems.subtotalSet in GraphQL)
      line_item?: {
        price: string;
      };
    }[];
    transactions?: Array<{
      id: string;
      kind: string;
      status: string;
      processed_at?: string | null; // Prefer for period inclusion when matching Shopify Analytics exports
      amount?: string; // Transaction amount (for shipping refunds, order-level refunds)
      currency?: string;
    }>;
  }[];
};

/**
 * Aggregated sales metrics across all orders
 */
export type SalesAggregation = {
  grossSales: number;
  discounts: number;
  returns: number;
  netSales: number;
};

/**
 * Per-order sales breakdown
 */
export type OrderSalesBreakdown = {
  orderId: string;
  grossSales: number;
  discounts: number;
  returns: number;
  netSales: number;
};

/**
 * Complete sales calculation result
 */
export type SalesResult = {
  summary: SalesAggregation;
  perOrder: OrderSalesBreakdown[];
};

/**
 * Customer type classification for Shopify Mode
 */
export type CustomerTypeShopifyMode = 'FIRST_TIME' | 'RETURNING' | 'GUEST' | 'UNKNOWN';

/**
 * Order customer classification map
 * Maps order_id -> customer type classification
 */
export type OrderCustomerClassification = {
  shopifyMode: CustomerTypeShopifyMode;
  // DEPRECATED: financialMode kept for backward compatibility but not used
  financialMode?: 'NEW' | 'RETURNING' | 'GUEST' | 'UNKNOWN';
  customerCreatedAt?: string | null; // For Shopify Mode calculation
  isFirstOrderForCustomer: boolean;
};

/**
 * Daily sales aggregation row
 */
export type DailySalesRow = {
  date: string; // YYYY-MM-DD format
  netSalesExclTax: number;
  grossSalesExclTax?: number;
  refundsExclTax?: number;
  discountsExclTax?: number;
  ordersCount: number;
  currency?: string;
  newCustomerNetSales?: number; // Net sales from new/first-time customers only (mode-dependent)
  returningCustomerNetSales?: number; // Net sales from returning customers only (mode-dependent)
  guestNetSales?: number; // Net sales from guest checkouts only
};

/**
 * Extended Shopify Order with transaction details for mode-based calculations
 */
export type ShopifyOrderWithTransactions = ShopifyOrder & {
  processed_at?: string | null;
  transactions?: Array<{
    kind: string;
    status: string;
    processedAt?: string | null;
  }>;
};

/**
 * Valid financial statuses that should be included in sales calculations.
 * 
 * Following Shopify Finance reports, we include:
 * - paid: Fully paid orders
 * - partially_paid: Partially paid orders
 * - partially_refunded: Orders with partial refunds
 * - refunded: Fully refunded orders (still counted, returns will offset)
 * 
 * We exclude:
 * - pending: Not yet paid
 * - voided: Voided payments
 * - unpaid: Unpaid orders
 */
const VALID_FINANCIAL_STATUSES = new Set([
  'paid',
  'partially_paid',
  'partially_refunded',
  'refunded',
]);

/**
 * Rounds a number to 2 decimal places to avoid floating-point precision issues.
 */
function roundTo2Decimals(value: number): number {
  return Math.round(value * 100) / 100;
}

function getRefundEffectiveDate(refund: NonNullable<ShopifyOrder['refunds']>[number]): string {
  // Shopify Analytics exports may align refunds to the transaction processed date (payout/settlement),
  // not necessarily refund.created_at. Prefer successful REFUND transaction processed_at when available.
  const processedDates =
    refund.transactions
      ?.filter((t) => t.kind === 'REFUND' && t.status === 'SUCCESS' && t.processed_at)
      .map((t) => t.processed_at as string) || [];

  if (processedDates.length > 0) {
    // Use the latest processed date to represent when the refund actually took effect financially.
    processedDates.sort();
    return processedDates[processedDates.length - 1];
  }

  return refund.created_at;
}

function sumRefundTransactionsAmount(refund: NonNullable<ShopifyOrder['refunds']>[number]): number {
  let total = 0;
  for (const t of refund.transactions || []) {
    if (t.kind === 'REFUND' && t.status === 'SUCCESS' && t.amount) {
      // Shopify can represent refund amounts as negative numbers depending on API surface.
      // For analytics "Returns" we want the magnitude.
      total += Math.abs(parseFloat(t.amount));
    }
  }
  return roundTo2Decimals(total);
}

function sumRefundOrderAdjustments(refund: NonNullable<ShopifyOrder['refunds']>[number]): number {
  let total = 0;
  for (const adj of refund.adjustments || []) {
    if (adj.amount) {
      total += parseFloat(adj.amount);
    }
  }
  return roundTo2Decimals(total);
}

function hasSuccessfulRefundTransaction(
  refund: NonNullable<ShopifyOrder['refunds']>[number],
): boolean {
  for (const t of refund.transactions || []) {
    if (t.kind === 'REFUND' && t.status === 'SUCCESS' && t.amount) return true;
  }
  return false;
}

function orderHasAnySuccessfulRefundTransaction(order: ShopifyOrder): boolean {
  for (const refund of order.refunds || []) {
    if (hasSuccessfulRefundTransaction(refund)) return true;
  }
  return false;
}

function getFullRefundTaxHintFromOrder(order: ShopifyOrder): number | null {
  // If there's a "full refund" object without a SUCCESS transaction but with line items,
  // Shopify Analytics `Dag` exports sometimes reflect the financial refund via a separate tx-only refund,
  // while this no-tx refund provides the full tax component for netting.
  for (const refund of order.refunds || []) {
    if (hasSuccessfulRefundTransaction(refund)) continue;
    const hasLineItems = refund.refund_line_items && refund.refund_line_items.length > 0;
    if (!hasLineItems) continue;
    if (!isFullRefundForOrder(refund, order.line_items)) continue;
    const refundedTax = calculateRefundedTaxFromLineItems(refund, order.line_items);
    if (refundedTax > 0) return refundedTax;
  }
  return null;
}

function calculateRefundedTaxFromLineItems(
  refund: NonNullable<ShopifyOrder['refunds']>[number],
  orderLineItems: ShopifyOrder['line_items'],
): number {
  // Shopify Analytics “Dag”-exports split refunds into Net + Taxes.
  // We want Returns EXCL tax, so we subtract refunded tax from the refund transaction totals.
  //
  // We approximate refunded tax by summing original order line item taxLines proportionally to refunded quantity.
  let tax = 0;
  const byId = new Map<string, ShopifyOrder['line_items'][number]>();
  for (const li of orderLineItems) {
    byId.set(li.id.toString(), li);
  }

  for (const rli of refund.refund_line_items || []) {
    const lineItemId = rli.line_item_id?.toString();
    if (!lineItemId) continue;
    const original = byId.get(lineItemId);
    if (!original) continue;
    const originalTaxTotal = parseFloat(original.tax || '0') || 0;
    const originalQty = original.quantity || 0;
    if (originalQty <= 0 || originalTaxTotal <= 0) continue;

    const perUnitTax = originalTaxTotal / originalQty;
    tax += perUnitTax * (rli.quantity || 0);
  }

  return roundTo2Decimals(tax);
}

function isFullRefundForOrder(
  refund: NonNullable<ShopifyOrder['refunds']>[number],
  orderLineItems: ShopifyOrder['line_items'],
): boolean {
  const refundedQtyByLineItem = new Map<string, number>();
  for (const rli of refund.refund_line_items || []) {
    const id = rli.line_item_id?.toString();
    if (!id) continue;
    refundedQtyByLineItem.set(id, (refundedQtyByLineItem.get(id) || 0) + (rli.quantity || 0));
  }

  for (const li of orderLineItems) {
    const id = li.id.toString();
    const orderedQty = li.quantity || 0;
    if (orderedQty <= 0) continue;
    const refundedQty = refundedQtyByLineItem.get(id) || 0;
    if (refundedQty < orderedQty) return false;
  }

  return orderLineItems.length > 0;
}

function sumRefundLineItemsSubtotalInclTax(
  refund: NonNullable<ShopifyOrder['refunds']>[number],
  orderLineItems: ShopifyOrder['line_items'],
): number {
  // In our current GraphQL mapping, refundLineItems.subtotalSet behaves like an INCL-tax line subtotal
  // (matches `Omsättning` per item in `Dag` exports).
  let total = 0;
  for (const rli of refund.refund_line_items || []) {
    if (rli.subtotal) {
      total += parseFloat(rli.subtotal);
    } else {
      const fallback = calculateRefundLineItemSubtotal(rli, orderLineItems);
      total += fallback;
    }
  }
  return roundTo2Decimals(total);
}

/**
 * Converts a date string to YYYY-MM-DD format in the shop's timezone
 */
function toLocalDate(dateString: string, timezone: string = 'Europe/Stockholm'): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

function getOrderReportDay(order: ShopifyOrder): string {
  // Shopify Analytics "Dag" aligns to shop timezone and typically uses processedAt for revenue recognition.
  // We default to processed_at when available, otherwise created_at.
  const dateString = order.processed_at || order.created_at;
  // `toLocalDate` normalizes to shop timezone (important around day boundaries).
  return toLocalDate(dateString);
}

/**
 * Determines the event date for an order
 * 
 * Shopify mode: Uses order.createdAt (when order was created)
 */
function getOrderEventDate(
  order: ShopifyOrderWithTransactions,
  mode: SalesMode, // Always 'shopify' now
  timezone: string = 'Europe/Stockholm',
): string | null {
  // Shopify mode: Use order.createdAt
  return toLocalDate(order.created_at, timezone);
  
  // DEPRECATED: Financial mode removed - was using transaction.processedAt
}

/**
 * Determines the event date for a refund
 * 
 * Shopify mode: Uses refund.createdAt
 */
function getRefundEventDate(
  refund: ShopifyOrder['refunds'][number],
  order: ShopifyOrderWithTransactions,
  mode: SalesMode, // Always 'shopify' now
  timezone: string = 'Europe/Stockholm',
): string {
  // Shopify mode: Use refund.createdAt
  return toLocalDate(refund.created_at, timezone);
  
  // DEPRECATED: Financial mode removed - was using refund transaction processedAt
}

/**
 * Filters orders for Shopify Mode
 * 
 * Shopify mode:
 * - Excludes test orders
 * - Includes cancelled orders (they're handled via refunds in Shopify)
 * - Includes orders without successful transactions (only checks financial_status)
 */
function shouldIncludeOrder(
  order: ShopifyOrderWithTransactions,
  mode: SalesMode, // Always 'shopify' now
): boolean {
  // Always exclude test orders (if test flag exists)
  if ('test' in order && (order as any).test === true) {
    return false;
  }
  
  // Shopify mode: Include orders with valid financial status
  // Includes cancelled orders (they're handled via refunds in Shopify)
  return VALID_FINANCIAL_STATUSES.has(order.financial_status);
  
  // DEPRECATED: Financial mode removed - was excluding cancelled orders and requiring successful transactions
}

/**
 * Calculates the subtotal for a refund line item.
 * 
 * If subtotal is provided, use it. Otherwise, calculate from:
 * - refund_line_item.line_item?.price (preferred)
 * - Or fallback to original line_item price from the order
 */
function calculateRefundLineItemSubtotal(
  refundLineItem: ShopifyOrder['refunds'][number]['refund_line_items'][number],
  originalLineItems: ShopifyOrder['line_items'],
): number {
  // If subtotal is directly provided, use it
  if (refundLineItem.subtotal) {
    return parseFloat(refundLineItem.subtotal);
  }

  // Try to get price from refund_line_item.line_item
  let pricePerUnit: number;
  if (refundLineItem.line_item?.price) {
    pricePerUnit = parseFloat(refundLineItem.line_item.price);
  } else {
    // Fallback: find original line item by line_item_id
    const originalLineItem = originalLineItems.find(
      (item) => item.id.toString() === refundLineItem.line_item_id.toString(),
    );
    if (!originalLineItem) {
      // If we can't find the original, we can't calculate - return 0
      // This is a conservative approach - we don't want to overstate returns
      console.warn(
        `Could not find original line item ${refundLineItem.line_item_id} for refund calculation`,
      );
      return 0;
    }
    pricePerUnit = parseFloat(originalLineItem.price);
  }

  return roundTo2Decimals(pricePerUnit * refundLineItem.quantity);
}

function calculateRefundReturnExclTaxForDaily(
  refund: NonNullable<ShopifyOrder['refunds']>[number],
  order: ShopifyOrder,
  datePeriod?: { from?: string; to?: string },
): number {
  // Apply the same logic as calculateOrderSales, but scoped to a single refund so we can allocate by refund day.
  if (datePeriod?.from || datePeriod?.to) {
    const refundDate = getRefundEffectiveDate(refund).split('T')[0];
    if (datePeriod.from && refundDate < datePeriod.from) return 0;
    if (datePeriod.to && refundDate > datePeriod.to) return 0;
  }

  const orderDay = getOrderReportDay(order);
  const orderDayInPeriod =
    (!datePeriod?.from || orderDay >= datePeriod.from) &&
    (!datePeriod?.to || orderDay <= datePeriod.to);

  const refundTxTotal = sumRefundTransactionsAmount(refund);
  const hasSuccessfulTx = hasSuccessfulRefundTransaction(refund);
  const hasRefundLineItems = refund.refund_line_items && refund.refund_line_items.length > 0;

  // Rule: if the order day is outside the report period and Shopify reports a discrepancy adjustment,
  // Analytics sometimes only shows the adjustment amount as "Returns" for that refund day.
  if (!orderDayInPeriod) {
    const adj = sumRefundOrderAdjustments(refund);
    if (Math.abs(adj) > 0.01 && (refundTxTotal <= 0 || Math.abs(adj) < Math.abs(refundTxTotal))) {
      return Math.abs(adj);
    }
  }

  if (hasSuccessfulTx && refundTxTotal > 0) {
    if (hasRefundLineItems) {
      const refundedTax = calculateRefundedTaxFromLineItems(refund, order.line_items);
      return Math.max(0, refundTxTotal - refundedTax);
    }

    // Tx-only refund (no line items): in Shopify Sales/Analytics "Returns" this typically should NOT be counted
    // as product returns (often shipping/fee/adjustment). Ignore to avoid overstating returns.
    return 0;
  }

  // No successful refund transaction.
  if (hasRefundLineItems) {
    const refundedTax = calculateRefundedTaxFromLineItems(refund, order.line_items);
    const fullRefund = isFullRefundForOrder(refund, order.line_items);

    // If we already have any successful refund transaction on this order, and this refund is a full-refund "shell"
    // without a transaction, it often represents a non-financial return event and should not affect totals.
    if (fullRefund && orderHasAnySuccessfulRefundTransaction(order)) {
      return 0;
    }

    if (fullRefund) {
      return refundedTax;
    }

    const subtotalInclTax = sumRefundLineItemsSubtotalInclTax(refund, order.line_items);
    return Math.max(0, subtotalInclTax - refundedTax);
  }

  return 0;
}

/**
 * Calculates sales metrics for a single Shopify order.
 * 
 * NEW CALCULATION METHOD (matching Shopify Analytics):
 * - Net Sales EXCL tax = subtotal_price - total_tax - refunds (EXCL tax)
 * - Uses Shopify's own fields as source of truth
 * 
 * **IMPORTANT - Refunds Date Filtering:**
 * - Refunds are filtered by report period (refund.created_at), NOT order.processed_at
 * - If datePeriod is provided, only refunds where refund.created_at is within the period are included
 * - This matches Shopify Analytics CSV export behavior
 * - Example: For period 1-30 December, only refunds created in December are included
 * 
 * @param order - Shopify order object
 * @param datePeriod - Optional date period to filter refunds (refund.created_at must be within this period)
 * @returns Per-order sales breakdown
 */
export function calculateOrderSales(
  order: ShopifyOrder,
  datePeriod?: { from?: string; to?: string },
): OrderSalesBreakdown {
  // Calculate Gross Sales INCL tax: sum of (price × quantity) for all line items
  // NOTE: line_item.price from Shopify API (originalUnitPriceSet) actually INCLUDES tax
  let grossSalesInclTax = 0;
  for (const lineItem of order.line_items) {
    const price = parseFloat(lineItem.price);
    const quantity = lineItem.quantity;
    grossSalesInclTax += price * quantity;
  }
  grossSalesInclTax = roundTo2Decimals(grossSalesInclTax);

  // Calculate Discounts INCL tax from API
  // IMPORTANT: Discounts are fetched at ORDER-LEVEL via totalDiscountsSet in GraphQL API
  // This is the recommended way according to Shopify documentation (similar to totalTaxSet, subtotalPriceSet)
  // Note: total_discounts from Shopify API is INCL tax, but Shopify Analytics shows EXCL tax
  let discountsInclTax = 0;
  if (order.total_discounts !== undefined && order.total_discounts !== null) {
    discountsInclTax = parseFloat(order.total_discounts || '0');
  } else {
    // Fallback: sum line-item discounts
    for (const lineItem of order.line_items) {
      discountsInclTax += parseFloat(lineItem.total_discount || '0');
    }
  }
  discountsInclTax = roundTo2Decimals(discountsInclTax);

  // NEW METHOD: Calculate Net Sales EXCL tax using Shopify's fields
  // subtotal_price = ordersumma efter rabatter, INKL moms
  // total_tax = total moms på ordern
  const subtotalPrice = order.subtotal_price
    ? parseFloat(order.subtotal_price)
    : 0;
  
  const totalTax = order.total_tax
    ? parseFloat(order.total_tax || '0')
    : 0;
  
  // Calculate subtotal EXCL tax = subtotal_price - total_tax
  const subtotalExclTax = subtotalPrice - totalTax;
  
  // Calculate tax rate from actual order values (from API)
  // tax_rate = total_tax / (subtotal_price - total_tax)
  // This gives us the tax rate on the subtotal (after discounts, EXCL tax)
  let taxRate = 0;
  if (subtotalPrice > 0 && totalTax > 0 && subtotalExclTax > 0) {
    taxRate = totalTax / subtotalExclTax;
  }

  // Compute line-level EXCL tax totals to handle mixed tax rates.
  // We derive a line-specific tax rate from line tax + (line net incl tax), and fallback to order taxRate.
  let grossSalesExclTaxFromLines = 0;
  let discountsExclTaxFromLines = 0;
  for (const lineItem of order.line_items) {
    const priceIncl = parseFloat(lineItem.price || '0') || 0;
    const qty = lineItem.quantity || 0;
    const discountIncl = parseFloat(lineItem.total_discount || '0') || 0;
    const taxTotal = parseFloat((lineItem as any).tax || '0') || 0;

    const lineTotalIncl = priceIncl * qty;
    const lineNetIncl = Math.max(0, lineTotalIncl - discountIncl);

    let lineTaxRate = taxRate;
    if (taxTotal > 0 && lineNetIncl > taxTotal) {
      lineTaxRate = taxTotal / (lineNetIncl - taxTotal);
    }

    const lineGrossEx = lineTaxRate > 0 ? lineTotalIncl / (1 + lineTaxRate) : lineTotalIncl;
    const lineDiscountEx = lineTaxRate > 0 ? discountIncl / (1 + lineTaxRate) : discountIncl;

    grossSalesExclTaxFromLines += lineGrossEx;
    discountsExclTaxFromLines += lineDiscountEx;

    // 100% discount special: Shopify Analytics includes tax component in both Gross and Discounts
    if (discountIncl > 0 && Math.abs(lineTotalIncl - discountIncl) < 0.01 && lineTaxRate > 0) {
      const extraTax = ((priceIncl * lineTaxRate) / (1 + lineTaxRate)) * qty;
      grossSalesExclTaxFromLines += extraTax;
      discountsExclTaxFromLines += extraTax;
    }
  }
  grossSalesExclTaxFromLines = roundTo2Decimals(grossSalesExclTaxFromLines);
  discountsExclTaxFromLines = roundTo2Decimals(discountsExclTaxFromLines);
  
  // Gross Sales calculation strategy (based on analysis of 62,770 orders):
  // 
  // 1. If total_tax = 0 (from API): CSV uses sum(line_items) directly as Gross Sales
  //    - This happens when: net sales = 0 (100% discount), orders outside Sweden, or special cases
  //    - Since there's no tax, INCL tax = EXCL tax
  // 
  // 2. If total_tax > 0: CSV uses sum_line_items / (1 + tax_rate) where tax_rate is calculated from netto
  //    - tax_rate = total_tax / (subtotal_price - total_tax) = total_tax / netto (before refunds)
  //    - This matches CSV in ~86% of orders with tax
  // 
  // 3. IMPORTANT: Shopify Analytics includes 100% discounted items' tax component in Gross Sales
  //    - For 100% discounted items (price = discount), add tax component: price × tax_rate / (1 + tax_rate)
  //    - CSV Gross Sales = API Gross Sales + sum(tax components of 100% discounted items)
  //    - This matches 100% of orders with 100% discounted items (analysis 2025-01-27)
  // 
  // 4. Fallback: use subtotal_excl_tax when we can't calculate tax rate
  let grossSales = 0;
  
  if (totalTax === 0) {
    // API says no tax: use sum(line_items) directly (matches CSV behavior)
    // Analysis shows all orders with API total_tax = 0 also have CSV tax = 0
    if (grossSalesInclTax > 0) {
      grossSales = grossSalesInclTax;
    }
  } else if (taxRate > 0 && grossSalesInclTax > 0) {
    // IMPORTANT: When tax_rate deviates significantly from 25% AND order has discounts,
    // Shopify Analytics uses subtotal_price INCL tax directly
    // Analysis (2025-01-27): Orders with tax_rate deviation > 0.1% from 25% AND discounts use subtotal_price directly
    // Using threshold 0.001 (0.1%) correctly identifies 58/64 mismatches and all 537 perfect matches (99% accuracy)
    // BUT: Only applies when order has discounts (all 64 mismatches had discounts, orders without discounts use different logic)
    const taxRateDeviationFrom25 = Math.abs(taxRate - 0.25);
    const USE_SUBTOTAL_PRICE_THRESHOLD = 0.001; // 0.1% deviation
    const hasDiscounts = subtotalExclTax > 0 && (grossSalesInclTax - subtotalExclTax - totalTax) < -0.01; // Check if discounts exist
    
    // Calculate total discounts from line items as fallback
    let totalDiscountsAmount = 0;
    for (const lineItem of order.line_items || []) {
      totalDiscountsAmount += parseFloat(lineItem.total_discount || '0');
    }
    const orderHasDiscounts = totalDiscountsAmount > 0.01 || (order.total_discounts && parseFloat(order.total_discounts) > 0.01);
    
    // Test if subtotal_price × (1 + tax_rate) ≈ sum(line_items)
    // This indicates that subtotal_price is closer to the expected value
    const subtotalPriceTimesOnePlusTaxRate = subtotalPrice * (1 + taxRate);
    const diffBetweenSubtotalAndSum = Math.abs(subtotalPriceTimesOnePlusTaxRate - grossSalesInclTax);
    // Analysis shows that for orders with discounts and tax_rate deviation, CSV uses subtotal_price
    // when the mathematical relationship is reasonably close (within 1 kr for rounding)
    // Testing with 10.0 kr threshold decreased accuracy (87.66% → 87.29%)
    // This threshold (1.0 kr) balances accuracy vs. avoiding false positives
    const SUBTOTAL_MATCHES_SUM_THRESHOLD = 1.0; // Allow 1 kr difference for rounding
    
    // Use subtotal_price when:
    // 1. Tax rate deviates from 25% AND order has discounts (original condition)
    // 2. AND subtotal_price × (1 + tax_rate) ≈ sum(line_items) (mathematical relationship)
    // This ensures we only use subtotal_price when it's mathematically consistent
    if (taxRateDeviationFrom25 > USE_SUBTOTAL_PRICE_THRESHOLD && 
        subtotalPrice > 0 && 
        orderHasDiscounts &&
        diffBetweenSubtotalAndSum < SUBTOTAL_MATCHES_SUM_THRESHOLD) {
      // Tax rate deviates from 25% AND order has discounts AND subtotal_price is mathematically consistent
      // Use subtotal_price INCL tax directly (matches CSV behavior)
      grossSales = subtotalPrice;
    } else {
      // Tax rate is close to 25%: use standard calculation
      // Has tax: convert from INCL tax to EXCL tax using tax_rate calculated from netto
      // tax_rate = total_tax / (subtotal_price - total_tax) = total_tax / netto (before refunds)
      grossSales = grossSalesExclTaxFromLines;
    }
  } else if (subtotalExclTax > 0) {
    // Fallback: use subtotal_excl_tax when we can't calculate tax rate but have subtotal
    grossSales = subtotalExclTax;
  } else if (grossSalesInclTax > 0) {
    // Final fallback: assume Gross Sales is already EXCL tax
    grossSales = grossSalesInclTax;
  }
  grossSales = roundTo2Decimals(grossSales);
  
  // Convert Discounts from INCL tax to EXCL tax
  // Discounts EXCL tax = Discounts INCL tax / (1 + tax_rate)
  // Shopify Analytics shows discounts EXCL tax
  let discounts = 0;
  // Prefer line-level conversion to handle mixed tax rates.
  // Falls back naturally if taxRate=0 (then line computations are INCL=EXCL).
  discounts = discountsExclTaxFromLines;
  discounts = roundTo2Decimals(discounts);
  
  // Net Sales EXCL tax BEFORE refunds
  // = subtotalPrice - totalTax
  const netSalesExclTaxBeforeRefunds = roundTo2Decimals(subtotalPrice - totalTax);

  // Note: order day is used later to zero Gross/Discounts outside the period; refunds are filtered separately.

  // Calculate Returns EXCL tax
  // IMPORTANT: Returns have NO order-level field in Shopify GraphQL API (unlike discounts)
  // Shopify API does NOT provide totalRefundedSet or similar field on Order object
  // Therefore, we use refunds data (refund_line_items + refund.transactions).
  //
  // Verified with `Dag`-dimension export (2025-01-08):
  // - Discounts are allocated to order day
  // - Returns are allocated to refund day
  // - Refund day rows show Returns (net) and Taxes separately
  //
  // Our best match to Shopify Analytics:
  // - Prefer refund REFUND/SUCCESS transaction totals (represents refund financial impact)
  // - If refund has refund_line_items, subtract refunded tax computed from original order line item taxLines
  // - If refund has no line items, treat as non-taxed adjustment unless we can infer otherwise
  // 
  // CRITICAL: Refunds are filtered by report period (refund.created_at), NOT order.processed_at
  // This matches Shopify Analytics CSV export behavior - only refunds within the report period are included
  let returns = 0;
  if (order.refunds && order.refunds.length > 0) {
    for (const refund of order.refunds) {
      // Filter refunds by date period if provided (matches Shopify Analytics CSV behavior)
      if (datePeriod) {
        const refundDate = getRefundEffectiveDate(refund).split('T')[0]; // Get date part (YYYY-MM-DD)
        if (datePeriod.from && refundDate < datePeriod.from) {
          continue; // Refund is before period start
        }
        if (datePeriod.to && refundDate > datePeriod.to) {
          continue; // Refund is after period end
        }
      }

      const refundTxTotal = sumRefundTransactionsAmount(refund);
      const hasRefundLineItems = refund.refund_line_items && refund.refund_line_items.length > 0;

      if (refundTxTotal > 0) {
        if (hasRefundLineItems) {
          const refundedTax = calculateRefundedTaxFromLineItems(refund, order.line_items);
          returns += refundTxTotal - refundedTax;
        } else {
          // No line items. This can be shipping/fee OR a product refund where Shopify didn't attach line items.
          //
          // If the order also contains a "full refund shell" (no SUCCESS tx but with line items),
          // use that shell to infer the refunded tax component and convert txTotal to net.
          const fullRefundTaxHint = getFullRefundTaxHintFromOrder(order);
          if (fullRefundTaxHint && fullRefundTaxHint > 0) {
            returns += Math.max(0, refundTxTotal - fullRefundTaxHint);
          } else {
            returns += refundTxTotal;
          }
        }
        continue;
      }

      // No successful refund transaction.
      // Verified in `Dag` exports: these cases frequently appear as tax-only adjustments
      // (Returer ~= refunded tax, Skatter negative), not as full net returns.
      if (hasRefundLineItems) {
        const refundedTax = calculateRefundedTaxFromLineItems(refund, order.line_items);
        const fullRefund = isFullRefundForOrder(refund, order.line_items);
        // If we already have any successful refund transaction on this order, and this refund is a full-refund "shell"
        // without a transaction, it often represents a non-financial return event and should not affect analytics totals.
        if (fullRefund && orderHasAnySuccessfulRefundTransaction(order)) {
          // ignore
        } else if (fullRefund) {
          returns += refundedTax;
        } else {
          // Partial refunds without SUCCESS transactions behave like net returns per refunded items.
          const subtotalInclTax = sumRefundLineItemsSubtotalInclTax(refund, order.line_items);
          returns += Math.max(0, subtotalInclTax - refundedTax);
        }
      }
    }
  }
  returns = roundTo2Decimals(returns);

  // If a report period is provided, Shopify Analytics "Dag" exports only include:
  // - Gross/Discounts on the order day (typically processed_at)
  // - Returns on the refund day
  //
  // Therefore: if the order day is outside the report period, Gross/Discounts should be 0,
  // but Returns may still be non-zero due to refunds within the period.
  if (datePeriod?.from || datePeriod?.to) {
    const orderDay = getOrderReportDay(order);
    if (datePeriod.from && orderDay < datePeriod.from) {
      grossSales = 0;
      discounts = 0;
    } else if (datePeriod.to && orderDay > datePeriod.to) {
      grossSales = 0;
      discounts = 0;
    }
  }

  // Net Sales EXCL tax = gross_sales - discounts - returns
  // This matches Shopify Analytics formula: Net Sales = Gross Sales - Discounts - Returns
  const netSales = roundTo2Decimals(grossSales - discounts - returns);

  return {
    orderId: order.id.toString(),
    grossSales, // Gross sales EXCL tax (SUM(line_item.price × quantity))
    discounts, // Discounts (sum of line_item.total_discount)
    returns, // Returns EXCL tax (from refund_line_items)
    netSales, // Net Sales EXCL tax = grossSales - discounts - returns
  };
}

/**
 * Calculates Shopify-like Gross Sales, Net Sales, Discounts, and Returns.
 * 
 * This function mirrors Shopify Analytics / Finance reports calculations:
 * - **Gross Sales**: Product selling price × ordered quantity (line items only)
 * - **Discounts**: Sum of all line item discounts (line_items[].total_discount)
 * - **Returns**: Value of returned items from refunds (refund_line_items)
 * - **Net Sales**: Gross Sales - Discounts - Returns
 * 
 * **Order filtering:**
 * - Only includes orders with financial_status: paid, partially_paid, partially_refunded, or refunded
 * - Orders with cancelled_at are included (Shopify Finance reports handle cancellations via refunds)
 * 
 * **CRITICAL - Refunds Date Filtering:**
 * - If datePeriod is provided, refunds are filtered by refund.created_at (NOT order.processed_at)
 * - Only refunds where refund.created_at is within the datePeriod are included in Returns calculation
 * - This matches Shopify Analytics CSV export behavior
 * - Example: For period 1-30 December, only refunds created in December are included
 * 
 * **Assumptions/Interpretations:**
 * - We use refund_line_items.subtotal if available, otherwise calculate from line_item.price × quantity
 * - If refund_line_item.line_item?.price exists, we prefer that over original order line item price
 * - All amounts are rounded to 2 decimals to avoid floating-point precision issues
 * - Currency conversion is not handled - assumes all orders are in the same currency
 * 
 * @param orders - Array of Shopify order objects (REST API structure)
 * @param datePeriod - Optional date period to filter refunds (refund.created_at must be within this period)
 * @returns Sales calculation result with summary and per-order breakdown
 * 
 * @example
 * ```typescript
 * const orders: ShopifyOrder[] = [...];
 * const result = calculateShopifyLikeSales(orders);
 * console.log(result.summary.grossSales); // Total gross sales
 * console.log(result.summary.netSales);   // Total net sales
 * ```
 */
export function calculateShopifyLikeSales(
  orders: ShopifyOrder[],
  datePeriod?: { from?: string; to?: string },
): SalesResult {
  // Shopify Analytics behavior: Only filter is gross_sales > 0
  // No filtering on financial_status, is_refund, or any other criteria
  // Calculate sales for ALL orders, then filter by gross_sales > 0 in the result
  
  // Calculate per-order breakdowns for all orders
  // IMPORTANT: Keep all orders in perOrder array to maintain index alignment with input orders
  // Filtering happens only in summary aggregation
  // CRITICAL: Pass datePeriod to calculateOrderSales to filter refunds by report period
  const perOrder: OrderSalesBreakdown[] = orders.map((order) =>
    calculateOrderSales(order, datePeriod),
  );

  // Filter for aggregation (only orders with gross_sales > 0)
  const ordersWithGrossSales = perOrder.filter((breakdown) => breakdown.grossSales > 0);

  // Aggregate totals (only from orders with gross_sales > 0)
  const summary: SalesAggregation = {
    grossSales: roundTo2Decimals(
      ordersWithGrossSales.reduce((sum, order) => sum + order.grossSales, 0),
    ),
    discounts: roundTo2Decimals(
      ordersWithGrossSales.reduce((sum, order) => sum + order.discounts, 0),
    ),
    returns: roundTo2Decimals(
      ordersWithGrossSales.reduce((sum, order) => sum + order.returns, 0),
    ),
    netSales: 0, // Will calculate below
  };

  // Net sales = gross - discounts - returns (rounded separately)
  summary.netSales = roundTo2Decimals(
    summary.grossSales - summary.discounts - summary.returns,
  );

  return {
    summary,
    perOrder, // Return ALL orders to maintain index alignment
  };
}

/**
 * Calculates daily sales aggregation from orders using Shopify Mode.
 * 
 * **Shopify Mode:**
 * - Sales: Uses order.createdAt for date grouping
 * - Refunds: Uses refund.createdAt for date grouping
 * - Includes cancelled orders (handled via refunds)
 * - Includes orders without successful transactions (only checks financial_status)
 * 
 * @param orders - Array of Shopify orders with transaction details
 * @param mode - Sales mode (always 'shopify' now)
 * @param timezone - Timezone for date conversion (default: 'Europe/Stockholm')
 * @param orderCustomerMap - Optional map of order_id -> is_new_customer boolean for calculating newCustomerNetSales (legacy)
 * @param orderCustomerClassification - Map of order_id -> customer classification (preferred)
 * @param reportingPeriodStart - YYYY-MM-DD format for Shopify Mode customer.createdAt check
 * @param reportingPeriodEnd - YYYY-MM-DD format for Shopify Mode customer.createdAt check
 * @returns Array of daily sales rows
 */
export function calculateDailySales(
  orders: ShopifyOrderWithTransactions[],
  mode: SalesMode, // Always 'shopify' now
  timezone: string = 'Europe/Stockholm',
  orderCustomerMap?: Map<string, boolean>, // Legacy parameter for backward compatibility
  orderCustomerClassification?: Map<string, OrderCustomerClassification>, // New parameter with full classification
  reportingPeriodStart?: string, // YYYY-MM-DD format for Shopify Mode customer.createdAt check
  reportingPeriodEnd?: string, // YYYY-MM-DD format for Shopify Mode customer.createdAt check
): DailySalesRow[] {
  // Filter orders (Shopify mode only now)
  const includedOrders = orders.filter((order) => shouldIncludeOrder(order, mode));
  
  // Map to aggregate daily data
  const dailyMap = new Map<string, DailySalesRow>();
  
  const datePeriod =
    reportingPeriodStart || reportingPeriodEnd
      ? { from: reportingPeriodStart, to: reportingPeriodEnd }
      : undefined;

  for (const order of includedOrders) {
    // Calculate order sales breakdown, applying report-period behavior (zero out gross/discounts outside period).
    const orderSales = calculateOrderSales(order, datePeriod);

    // Shopify Analytics "Dag": allocate order metrics to the order report day (processed_at preferred).
    const orderDate = getOrderReportDay(order);
    
    if (!orderDate) {
      // Skip if no valid event date (should not happen in Shopify mode, but kept for safety)
      continue;
    }
    
    // Get or create daily row for order date
    let dailyRow = dailyMap.get(orderDate);
    if (!dailyRow) {
      dailyRow = {
        date: orderDate,
        netSalesExclTax: 0,
        grossSalesExclTax: 0,
        refundsExclTax: 0,
        discountsExclTax: 0,
        ordersCount: 0,
        currency: order.currency,
        newCustomerNetSales: 0,
        returningCustomerNetSales: 0,
        guestNetSales: 0,
      };
      dailyMap.set(orderDate, dailyRow);
    }
    
    // Add order-day metrics (before refunds). Refunds are allocated separately by refund day.
    const subtotalPrice = order.subtotal_price ? parseFloat(order.subtotal_price) : 0;
    const totalTax = order.total_tax ? parseFloat(order.total_tax || '0') : 0;
    const netSalesExclTaxBeforeRefunds = roundTo2Decimals(subtotalPrice - totalTax);
    
    // orderSales.grossSales and orderSales.discounts are already EXCL tax.
    const grossSalesExclTax = orderSales.grossSales;
    const discountsExclTax = orderSales.discounts;
    
    const orderDayInPeriod =
      !datePeriod ||
      ((!datePeriod.from || orderDate >= datePeriod.from) &&
        (!datePeriod.to || orderDate <= datePeriod.to));

    if (orderDayInPeriod) {
      dailyRow.netSalesExclTax += netSalesExclTaxBeforeRefunds;
      dailyRow.grossSalesExclTax! += grossSalesExclTax;
      dailyRow.discountsExclTax! += discountsExclTax;
      dailyRow.ordersCount += 1;
    }
    
    // Classify customer type (Shopify Mode only now)
    let customerType: CustomerTypeShopifyMode = 'UNKNOWN';
    let isGuest = false;
    
    if (orderCustomerClassification) {
      const classification = orderCustomerClassification.get(order.id.toString());
      if (classification) {
        customerType = classification.shopifyMode;
        isGuest = classification.shopifyMode === 'GUEST';
      }
    } else if (orderCustomerMap) {
      // Legacy mode: fallback to boolean map
      const isNewCustomer = orderCustomerMap.get(order.id.toString()) === true;
      customerType = isNewCustomer ? 'FIRST_TIME' : 'RETURNING';
    }
    
    // Add to appropriate customer type net sales bucket
    if (isGuest || customerType === 'GUEST') {
      dailyRow.guestNetSales! += netSalesExclTaxBeforeRefunds;
    } else if (customerType === 'FIRST_TIME') {
      dailyRow.newCustomerNetSales! += netSalesExclTaxBeforeRefunds;
    } else if (customerType === 'RETURNING') {
      dailyRow.returningCustomerNetSales! += netSalesExclTaxBeforeRefunds;
    } else {
      // Unknown - for backward compatibility, use legacy logic if available
      if (orderCustomerMap && orderCustomerMap.get(order.id.toString()) === true) {
        dailyRow.newCustomerNetSales! += netSalesExclTaxBeforeRefunds;
      }
    }
    
    // Process refunds separately (they hit on their own date).
    if (order.refunds && order.refunds.length > 0) {
      for (const refund of order.refunds) {
        const refundDate = getRefundEventDate(refund, order, mode, timezone);
        const refundAmountExclTax = roundTo2Decimals(
          calculateRefundReturnExclTaxForDaily(refund, order, datePeriod),
        );

        if (refundAmountExclTax > 0) {
          // Get or create daily row for refund date
          let refundDailyRow = dailyMap.get(refundDate);
          if (!refundDailyRow) {
            refundDailyRow = {
              date: refundDate,
              netSalesExclTax: 0,
              grossSalesExclTax: 0,
              refundsExclTax: 0,
              discountsExclTax: 0,
              ordersCount: 0,
              currency: order.currency,
              newCustomerNetSales: 0,
              returningCustomerNetSales: 0,
              guestNetSales: 0,
            };
            dailyMap.set(refundDate, refundDailyRow);
          }
          
          // Subtract refund from net sales on refund date
          // Gross Sales and Discounts are NOT affected by refunds
          refundDailyRow.netSalesExclTax -= refundAmountExclTax;
          refundDailyRow.refundsExclTax! += refundAmountExclTax;
          
          // Subtract from appropriate customer type net sales bucket
          if (isGuest || customerType === 'GUEST') {
            refundDailyRow.guestNetSales! -= refundAmountExclTax;
          } else if (customerType === 'FIRST_TIME') {
            refundDailyRow.newCustomerNetSales! -= refundAmountExclTax;
          } else if (customerType === 'RETURNING') {
            refundDailyRow.returningCustomerNetSales! -= refundAmountExclTax;
          } else {
            // Legacy fallback
            if (orderCustomerMap && orderCustomerMap.get(order.id.toString()) === true) {
              refundDailyRow.newCustomerNetSales! -= refundAmountExclTax;
            }
          }
        }
      }
    }
  }
  
  // Round all values and return sorted array
  const result = Array.from(dailyMap.values()).map((row) => ({
    ...row,
    netSalesExclTax: roundTo2Decimals(row.netSalesExclTax),
    grossSalesExclTax: roundTo2Decimals(row.grossSalesExclTax || 0),
    refundsExclTax: roundTo2Decimals(row.refundsExclTax || 0),
    discountsExclTax: roundTo2Decimals(row.discountsExclTax || 0),
    newCustomerNetSales: roundTo2Decimals(row.newCustomerNetSales || 0),
    returningCustomerNetSales: roundTo2Decimals(row.returningCustomerNetSales || 0),
    guestNetSales: roundTo2Decimals(row.guestNetSales || 0),
  }));
  
  // Sort by date
  result.sort((a, b) => a.date.localeCompare(b.date));
  
  return result;
}

/**
 * Test data examples
 * 
 * Usage:
 * ```typescript
 * import { calculateShopifyLikeSales, type ShopifyOrder } from './sales';
 * 
 * const testOrders: ShopifyOrder[] = [
 *   // Order 1: No discounts, no refunds
 *   {
 *     id: '1001',
 *     created_at: '2025-11-01T10:00:00Z',
 *     currency: 'SEK',
 *     financial_status: 'paid',
 *     cancelled_at: null,
 *     line_items: [
 *       { id: '1', price: '100.00', quantity: 2, total_discount: '0.00' },
 *       { id: '2', price: '50.00', quantity: 1, total_discount: '0.00' },
 *     ],
 *   },
 *   // Order 2: With discounts
 *   {
 *     id: '1002',
 *     created_at: '2025-11-02T10:00:00Z',
 *     currency: 'SEK',
 *     financial_status: 'paid',
 *     cancelled_at: null,
 *     line_items: [
 *       { id: '3', price: '200.00', quantity: 1, total_discount: '20.00' },
 *       { id: '4', price: '150.00', quantity: 2, total_discount: '30.00' },
 *     ],
 *   },
 *   // Order 3: Partially refunded
 *   {
 *     id: '1003',
 *     created_at: '2025-11-03T10:00:00Z',
 *     currency: 'SEK',
 *     financial_status: 'partially_refunded',
 *     cancelled_at: null,
 *     line_items: [
 *       { id: '5', price: '300.00', quantity: 2, total_discount: '0.00' },
 *     ],
 *     refunds: [
 *       {
 *         id: 'refund1',
 *         created_at: '2025-11-03T12:00:00Z',
 *         refund_line_items: [
 *           {
 *             line_item_id: '5',
 *             quantity: 1,
 *             subtotal: '300.00', // Or can be calculated from line_item.price
 *             line_item: { price: '300.00' },
 *           },
 *         ],
 *       },
 *     ],
 *   },
 * ];
 * 
 * const result = calculateShopifyLikeSales(testOrders);
 * 
 * // Expected results:
 * // Order 1: grossSales = 250.00, discounts = 0.00, returns = 0.00, netSales = 250.00
 * // Order 2: grossSales = 500.00, discounts = 50.00, returns = 0.00, netSales = 450.00
 * // Order 3: grossSales = 600.00, discounts = 0.00, returns = 300.00, netSales = 300.00
 * // Summary: grossSales = 1350.00, discounts = 50.00, returns = 300.00, netSales = 1000.00
 * ```
 */

