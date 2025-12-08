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

    return {
      id: node.id,
      price: node.originalUnitPriceSet.shopMoney.amount,
      quantity: node.quantity,
      total_discount: totalDiscount.toFixed(2),
    };
  });

  // Extract refunds
  const refunds = graphqlOrder.refunds.map((refund) => ({
    id: refund.id,
    created_at: refund.createdAt,
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
  }));

  // Calculate total discounts
  let totalDiscounts = 0;
  for (const item of lineItems) {
    totalDiscounts += parseFloat(item.total_discount);
  }

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
    total_discounts: totalDiscounts.toFixed(2),
    line_items: lineItems,
    refunds,
    processed_at: graphqlOrder.processedAt || null,
    transactions,
    test: graphqlOrder.test,
  };

  return shopifyOrder;
}

