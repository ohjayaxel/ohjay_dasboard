/**
 * @fileoverview
 * Sales calculation functions that mirror Shopify Analytics/Finance reports.
 * 
 * These functions calculate Gross Sales, Net Sales, Discounts, and Returns
 * using the same logic as Shopify's Finance reports:
 * - Gross Sales = product selling price × ordered quantity (line items only)
 * - Discounts = sum of all line item discounts
 * - Returns = value of returned items from refunds
 * - Net Sales = Gross Sales - Discounts - Returns
 * 
 * No shipping, taxes, or fees are included in these calculations.
 */

/**
 * Shopify Order structure (REST API-like)
 */
export type ShopifyOrder = {
  id: number | string;
  created_at: string;
  currency: string;
  financial_status: string;
  cancelled_at: string | null;
  line_items: {
    id: number | string;
    price: string; // Price per unit, as string
    quantity: number;
    total_discount: string; // Discount on this line item, as string
  }[];
  refunds?: {
    id: number | string;
    created_at: string;
    refund_line_items: {
      line_item_id: number | string;
      quantity: number;
      subtotal?: string; // If available, otherwise calculate
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
 * @param order - Shopify order object
 * @returns Per-order sales breakdown
 */
function calculateOrderSales(order: ShopifyOrder): OrderSalesBreakdown {
  // Calculate Gross Sales: sum of (price × quantity) for all line items
  let grossSales = 0;
  for (const lineItem of order.line_items) {
    const price = parseFloat(lineItem.price);
    const quantity = lineItem.quantity;
    grossSales += price * quantity;
  }
  grossSales = roundTo2Decimals(grossSales);

  // Calculate Discounts: sum of total_discount for all line items
  let discounts = 0;
  for (const lineItem of order.line_items) {
    discounts += parseFloat(lineItem.total_discount || '0');
  }
  discounts = roundTo2Decimals(discounts);

  // Calculate Returns: sum of refund_line_items values
  let returns = 0;
  if (order.refunds && order.refunds.length > 0) {
    for (const refund of order.refunds) {
      for (const refundLineItem of refund.refund_line_items) {
        const subtotal = calculateRefundLineItemSubtotal(
          refundLineItem,
          order.line_items,
        );
        returns += subtotal;
      }
    }
  }
  returns = roundTo2Decimals(returns);

  // Calculate Net Sales
  const netSales = roundTo2Decimals(grossSales - discounts - returns);

  return {
    orderId: order.id.toString(),
    grossSales,
    discounts,
    returns,
    netSales,
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

