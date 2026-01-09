/**
 * Converts GraphQL orders to REST API-like format for sales calculations
 */

import type { GraphQLOrder } from '@/lib/integrations/shopify-graphql';
import type { ShopifyOrderWithTransactions } from './sales';

/**
 * Converts a GraphQL order to ShopifyOrderWithTransactions format
 */
export function convertGraphQLOrderToShopifyOrder(
  graphqlOrder: GraphQLOrder,
): ShopifyOrderWithTransactions {
  // Extract transactions
  const transactions = (graphqlOrder.transactions || []).map((txn) => ({
    kind: txn.kind,
    status: txn.status,
    processedAt: txn.processedAt || null,
  }));

  // Extract line items
  const lineItems = graphqlOrder.lineItems.edges.map((edge) => {
    const node = edge.node;
    // Calculate total discount for this line item
    let totalDiscount = 0;
    for (const allocation of node.discountAllocations) {
      totalDiscount += parseFloat(allocation.allocatedAmountSet.shopMoney.amount);
    }

    // Sum tax lines for this line item (Shopify provides tax per line item)
    let totalTax = 0;
    for (const taxLine of node.taxLines || []) {
      totalTax += parseFloat(taxLine.priceSet.shopMoney.amount);
    }

    // Extract product ID - use variant ID if available, otherwise product ID
    // read_products scope is now available
    let productId: string | undefined;
    if (node.variant?.id) {
      // Extract numeric ID from GID (e.g., "gid://shopify/ProductVariant/123456" -> "123456")
      productId = node.variant.id.split('/').pop();
    } else if (node.product?.id) {
      // Extract numeric ID from GID (e.g., "gid://shopify/Product/123456" -> "123456")
      productId = node.product.id.split('/').pop();
    }

    return {
      id: node.id,
      product_id: productId, // Product ID for matching with CSV
      price: node.originalUnitPriceSet.shopMoney.amount,
      quantity: node.quantity,
      total_discount: totalDiscount.toFixed(2),
      tax: totalTax.toFixed(2),
    };
  });

  // Extract refunds
  const refunds = graphqlOrder.refunds.map((refund) => ({
    id: refund.id,
    created_at: refund.createdAt,
    total_refunded: refund.totalRefundedSet?.shopMoney?.amount ?? undefined,
    adjustments: refund.orderAdjustments?.edges.map((e) => ({
      reason: e.node.reason ?? null,
      amount: e.node.amountSet?.shopMoney?.amount ?? null,
      tax_amount: e.node.taxAmountSet?.shopMoney?.amount ?? null,
    })),
    refund_line_items: refund.refundLineItems.edges.map((refundEdge) => {
      const refundNode = refundEdge.node;
      const originalLineItem = refundNode.lineItem;

      return {
        line_item_id: originalLineItem.id,
        quantity: refundNode.quantity,
        subtotal: refundNode.subtotalSet
          ? refundNode.subtotalSet.shopMoney.amount
          : undefined,
        line_item: {
          price: originalLineItem.originalUnitPriceSet.shopMoney.amount,
        },
      };
    }),
    transactions: refund.transactions?.edges.map((edge) => ({
      id: edge.node.id,
      kind: edge.node.kind,
      status: edge.node.status,
      processed_at: edge.node.processedAt || null,
      amount: edge.node.amountSet?.shopMoney.amount,
      currency: edge.node.amountSet?.shopMoney.currencyCode,
    })),
  }));

  // Discounts:
  // Prefer order-level totalDiscountsSet when available (includes shipping/order-level discounts that may not appear in line-item allocations).
  // Fallback to summing line item discount allocations.
  const totalDiscounts =
    graphqlOrder.totalDiscountsSet?.shopMoney?.amount !== undefined &&
    graphqlOrder.totalDiscountsSet?.shopMoney?.amount !== null
      ? parseFloat(graphqlOrder.totalDiscountsSet.shopMoney.amount)
      : lineItems.reduce((sum, item) => sum + (parseFloat(item.total_discount) || 0), 0);

  // Infer financial_status from transactions
  let financialStatus = 'pending';
  if (graphqlOrder.cancelledAt) {
    financialStatus = 'voided';
  } else if (transactions.length > 0) {
    const successfulSales = transactions.filter(
      (txn) => (txn.kind === 'SALE' || txn.kind === 'CAPTURE') && txn.status === 'SUCCESS',
    );
    const refunds = transactions.filter(
      (txn) => txn.kind === 'REFUND' && txn.status === 'SUCCESS',
    );
    
    if (refunds.length > 0 && successfulSales.length > 0) {
      financialStatus = 'partially_refunded';
      // Check if fully refunded (would need to compare amounts, defaulting to partially_refunded for safety)
    } else if (successfulSales.length > 0) {
      financialStatus = 'paid';
    } else {
      financialStatus = 'pending';
    }
  }

  const shopifyOrder: ShopifyOrderWithTransactions = {
    id: graphqlOrder.legacyResourceId || graphqlOrder.id,
    created_at: graphqlOrder.createdAt,
    currency: graphqlOrder.currencyCode,
    financial_status: financialStatus,
    cancelled_at: graphqlOrder.cancelledAt || null,
    subtotal_price: graphqlOrder.subtotalPriceSet?.shopMoney.amount,
    total_tax: graphqlOrder.totalTaxSet?.shopMoney.amount,
    total_discounts: (Number.isFinite(totalDiscounts) ? totalDiscounts : 0).toFixed(2),
    line_items: lineItems,
    refunds,
    processed_at: graphqlOrder.processedAt || null,
    transactions,
    test: graphqlOrder.test,
  };

  return shopifyOrder;
}

