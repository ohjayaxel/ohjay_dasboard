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
  currency: string;
  financial_status: string;
  cancelled_at: string | null;
  subtotal_price?: string; // Subtotal after discounts, INCL tax (equivalent to subtotalPriceSet in GraphQL)
  total_tax?: string; // Total tax on order (equivalent to totalTaxSet in GraphQL)
  line_items: {
    id: number | string;
    price: string; // Price per unit, as string
    quantity: number;
    total_discount: string; // Discount on this line item, as string
  }[];
  total_discounts?: string; // Order-level total discounts (preferred over summing line_items)
  refunds?: {
    id: number | string;
    created_at: string;
    refund_line_items: {
      line_item_id: number | string;
      quantity: number;
      subtotal?: string; // Refund amount EXCL tax (equivalent to refundLineItems.subtotalSet in GraphQL)
      line_item?: {
        price: string;
      };
    }[];
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

/**
 * Converts a date string to YYYY-MM-DD format in the shop's timezone
 */
function toLocalDate(dateString: string, timezone: string = 'Europe/Stockholm'): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
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

/**
 * Calculates sales metrics for a single Shopify order.
 * 
 * NEW CALCULATION METHOD (matching Shopify Analytics):
 * - Net Sales EXCL tax = subtotal_price - total_tax - refunds (EXCL tax)
 * - Uses Shopify's own fields as source of truth
 * 
 * @param order - Shopify order object
 * @returns Per-order sales breakdown
 */
export function calculateOrderSales(order: ShopifyOrder): OrderSalesBreakdown {
  // Calculate Gross Sales: sum of (price × quantity) for all line items (INCL tax)
  // This is for reference/display purposes only
  let grossSales = 0;
  for (const lineItem of order.line_items) {
    const price = parseFloat(lineItem.price);
    const quantity = lineItem.quantity;
    grossSales += price * quantity;
  }
  grossSales = roundTo2Decimals(grossSales);

  // Calculate Discounts: prefer order.total_discounts if available (includes both line-item and order-level discounts)
  // This is for reference/display purposes only (INCL tax)
  let discounts = 0;
  if (order.total_discounts !== undefined && order.total_discounts !== null) {
    discounts = parseFloat(order.total_discounts || '0');
  } else {
    // Fallback: sum line-item discounts
    for (const lineItem of order.line_items) {
      discounts += parseFloat(lineItem.total_discount || '0');
    }
  }
  discounts = roundTo2Decimals(discounts);

  // NEW METHOD: Calculate Net Sales EXCL tax using Shopify's fields
  // subtotal_price = ordersumma efter rabatter, INKL moms
  // total_tax = total moms på ordern
  const subtotalPrice = order.subtotal_price
    ? parseFloat(order.subtotal_price)
    : 0;
  
  const totalTax = order.total_tax
    ? parseFloat(order.total_tax || '0')
    : 0;
  
  // Net Sales EXCL tax BEFORE refunds
  // = subtotalPrice - totalTax
  const netSalesExclTaxBeforeRefunds = roundTo2Decimals(subtotalPrice - totalTax);

  // Calculate Returns EXCL tax: use refund_line_items[].subtotal if available
  // subtotal field contains refund amount EXCL tax
  let returns = 0;
  if (order.refunds && order.refunds.length > 0) {
    for (const refund of order.refunds) {
      for (const refundLineItem of refund.refund_line_items) {
        // Prefer subtotal field (EXCL tax), otherwise calculate from price
        if (refundLineItem.subtotal) {
          returns += parseFloat(refundLineItem.subtotal);
        } else {
          // Fallback: calculate from line_item.price or original order line item
          const subtotal = calculateRefundLineItemSubtotal(
            refundLineItem,
            order.line_items,
          );
          returns += subtotal;
        }
      }
    }
  }
  returns = roundTo2Decimals(returns);

  // Net Sales EXCL tax AFTER refunds
  const netSales = roundTo2Decimals(netSalesExclTaxBeforeRefunds - returns);

  return {
    orderId: order.id.toString(),
    grossSales, // Gross sales INCL tax (for reference)
    discounts, // Discounts INCL tax (for reference)
    returns, // Returns EXCL tax
    netSales, // Net Sales EXCL tax AFTER refunds (NEW METHOD)
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
 * **Assumptions/Interpretations:**
 * - We use refund_line_items.subtotal if available, otherwise calculate from line_item.price × quantity
 * - If refund_line_item.line_item?.price exists, we prefer that over original order line item price
 * - All amounts are rounded to 2 decimals to avoid floating-point precision issues
 * - Currency conversion is not handled - assumes all orders are in the same currency
 * 
 * @param orders - Array of Shopify order objects (REST API structure)
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
export function calculateShopifyLikeSales(orders: ShopifyOrder[]): SalesResult {
  // Filter orders to only include those with valid financial status
  const validOrders = orders.filter((order) => {
    const hasValidStatus = VALID_FINANCIAL_STATUSES.has(order.financial_status);
    
    // Note: We include orders with cancelled_at because Shopify Finance reports
    // handle cancellations through refunds. If an order is cancelled, it should
    // have a refund that will offset the gross sales, resulting in net sales = 0.
    // If you want to exclude cancelled orders entirely, uncomment:
    // if (order.cancelled_at) return false;
    
    return hasValidStatus;
  });

  // Calculate per-order breakdowns
  const perOrder: OrderSalesBreakdown[] = validOrders.map((order) =>
    calculateOrderSales(order),
  );

  // Aggregate totals
  const summary: SalesAggregation = {
    grossSales: roundTo2Decimals(
      perOrder.reduce((sum, order) => sum + order.grossSales, 0),
    ),
    discounts: roundTo2Decimals(
      perOrder.reduce((sum, order) => sum + order.discounts, 0),
    ),
    returns: roundTo2Decimals(
      perOrder.reduce((sum, order) => sum + order.returns, 0),
    ),
    netSales: 0, // Will calculate below
  };

  // Net sales = gross - discounts - returns (rounded separately)
  summary.netSales = roundTo2Decimals(
    summary.grossSales - summary.discounts - summary.returns,
  );

  return {
    summary,
    perOrder,
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
  
  for (const order of includedOrders) {
    // Calculate order sales breakdown
    const orderSales = calculateOrderSales(order);
    
    // Get event date for this order (always uses order.createdAt for Shopify mode)
    const orderDate = getOrderEventDate(order, mode, timezone);
    
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
    
    // Shopify mode: Add net_sales_excl_tax_before_refunds on order date
    // Financial mode: Add net_sales_excl_tax_before_refunds on transaction date
    const subtotalPrice = order.subtotal_price ? parseFloat(order.subtotal_price) : 0;
    const totalTax = order.total_tax ? parseFloat(order.total_tax || '0') : 0;
    const netSalesExclTaxBeforeRefunds = roundTo2Decimals(subtotalPrice - totalTax);
    
    // Calculate Gross Sales INCL tax: sum of all line item prices
    // Use orderSales.grossSales which is already calculated from line items
    const grossSalesInclTax = orderSales.grossSales;
    
    // Calculate total discounts INCL tax
    const totalDiscountsInclTax = orderSales.discounts;
    
    // Calculate Discounts EXCL tax
    let discountsExclTax = 0;
    if (subtotalPrice > 0 && totalTax > 0) {
      const taxRateOnSubtotal = totalTax / subtotalPrice;
      discountsExclTax = totalDiscountsInclTax / (1 + taxRateOnSubtotal);
    } else {
      discountsExclTax = totalDiscountsInclTax;
    }
    
    // Calculate refunds for this order (needed for Gross Sales calculation)
    let orderTotalRefundsExclTax = 0;
    if (order.refunds && order.refunds.length > 0) {
      for (const refund of order.refunds) {
        for (const refundLineItem of refund.refund_line_items) {
          if (refundLineItem.subtotal) {
            orderTotalRefundsExclTax += parseFloat(refundLineItem.subtotal);
          } else {
            const subtotal = calculateRefundLineItemSubtotal(
              refundLineItem,
              order.line_items,
            );
            orderTotalRefundsExclTax += subtotal;
          }
        }
      }
    }
    orderTotalRefundsExclTax = roundTo2Decimals(orderTotalRefundsExclTax);
    
    // Calculate Gross Sales EXCL tax
    // Gross Sales EXCL tax = Net Sales EXCL tax (after refunds) + Discounts EXCL tax + Returns EXCL tax
    const netSalesExclTaxAfterRefunds = netSalesExclTaxBeforeRefunds - orderTotalRefundsExclTax;
    const grossSalesExclTax = netSalesExclTaxAfterRefunds + discountsExclTax + orderTotalRefundsExclTax;
    
    // Add sales value on the determined date
    dailyRow.netSalesExclTax += netSalesExclTaxBeforeRefunds;
    dailyRow.grossSalesExclTax! += grossSalesExclTax;
    dailyRow.discountsExclTax! += discountsExclTax;
    dailyRow.ordersCount += 1;
    
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
    
    // Process refunds separately (they hit on their own date)
    // Note: Refunds only affect Net Sales and Returns, not Gross Sales or Discounts
    if (order.refunds && order.refunds.length > 0) {
      for (const refund of order.refunds) {
        const refundDate = getRefundEventDate(refund, order, mode, timezone);
        
        // Calculate refund amount EXCL tax
        let refundAmountExclTax = 0;
        for (const refundLineItem of refund.refund_line_items) {
          if (refundLineItem.subtotal) {
            refundAmountExclTax += parseFloat(refundLineItem.subtotal);
          } else {
            const subtotal = calculateRefundLineItemSubtotal(
              refundLineItem,
              order.line_items,
            );
            refundAmountExclTax += subtotal;
          }
        }
        refundAmountExclTax = roundTo2Decimals(refundAmountExclTax);
        
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

