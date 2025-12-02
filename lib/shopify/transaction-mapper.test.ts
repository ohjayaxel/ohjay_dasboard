/**
 * Unit tests for Shopify transaction mapper functions
 */

import { describe, it, expect } from 'vitest';
import {
  mapOrderToSaleTransactions,
  mapRefundToReturnTransactions,
  mapOrderToTransactions,
  calculateNetSales,
  type SalesTransaction,
} from './transaction-mapper';
import type { GraphQLOrder } from '@/lib/integrations/shopify-graphql';

describe('transaction-mapper', () => {
  describe('mapOrderToSaleTransactions', () => {
    it('should create SALE transaction for order with single line item', () => {
      const order: GraphQLOrder = {
        id: 'gid://shopify/Order/1001',
        name: '#1001',
        orderNumber: 1001,
        createdAt: '2025-11-28T10:00:00Z',
        test: false,
        currencyCode: 'SEK',
        lineItems: {
          edges: [
            {
              node: {
                id: 'gid://shopify/LineItem/1',
                sku: 'PROD-001',
                name: 'Test Product',
                quantity: 2,
                originalUnitPriceSet: {
                  shopMoney: {
                    amount: '100.00',
                    currencyCode: 'SEK',
                  },
                },
                discountAllocations: [],
              },
            },
          ],
        },
        discountAllocations: [],
        refunds: [],
      };

      const transactions = mapOrderToSaleTransactions(order, 'Europe/Stockholm');

      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toEqual({
        shopify_order_id: 'gid://shopify/Order/1001',
        shopify_order_name: '#1001',
        shopify_order_number: 1001,
        shopify_refund_id: null,
        shopify_line_item_id: 'gid://shopify/LineItem/1',
        event_type: 'SALE',
        event_date: '2025-11-28',
        currency: 'SEK',
        product_sku: 'PROD-001',
        product_title: 'Test Product',
        variant_title: null,
        quantity: 2,
        gross_sales: 200.0, // 100 * 2
        discounts: 0,
        returns: 0,
        shipping: 0,
        tax: 0,
      });
    });

    it('should distribute order-level discounts proportionally', () => {
      const order: GraphQLOrder = {
        id: 'gid://shopify/Order/1002',
        name: '#1002',
        orderNumber: 1002,
        createdAt: '2025-11-28T10:00:00Z',
        test: false,
        currencyCode: 'SEK',
        lineItems: {
          edges: [
            {
              node: {
                id: 'gid://shopify/LineItem/1',
                sku: 'PROD-001',
                name: 'Product 1',
                quantity: 1,
                originalUnitPriceSet: {
                  shopMoney: {
                    amount: '100.00',
                    currencyCode: 'SEK',
                  },
                },
                discountAllocations: [],
              },
            },
            {
              node: {
                id: 'gid://shopify/LineItem/2',
                sku: 'PROD-002',
                name: 'Product 2',
                quantity: 1,
                originalUnitPriceSet: {
                  shopMoney: {
                    amount: '50.00',
                    currencyCode: 'SEK',
                  },
                },
                discountAllocations: [],
              },
            },
          ],
        },
        discountAllocations: [
          {
            allocatedAmountSet: {
              shopMoney: {
                amount: '30.00', // 30 SEK order-level discount
                currencyCode: 'SEK',
              },
            },
          },
        ],
        refunds: [],
      };

      const transactions = mapOrderToSaleTransactions(order, 'Europe/Stockholm');

      expect(transactions).toHaveLength(2);

      // First product: 100 / 150 = 66.67% of total, so 30 * 0.6667 = 20.00 discount
      expect(transactions[0].gross_sales).toBe(100.0);
      expect(transactions[0].discounts).toBeCloseTo(20.0, 2);

      // Second product: 50 / 150 = 33.33% of total, so 30 * 0.3333 = 10.00 discount
      expect(transactions[1].gross_sales).toBe(50.0);
      expect(transactions[1].discounts).toBeCloseTo(10.0, 2);

      // Total discounts should equal order-level discount
      const totalDiscounts = transactions.reduce((sum, t) => sum + t.discounts, 0);
      expect(totalDiscounts).toBeCloseTo(30.0, 2);
    });

    it('should combine line-level and order-level discounts', () => {
      const order: GraphQLOrder = {
        id: 'gid://shopify/Order/1003',
        name: '#1003',
        orderNumber: 1003,
        createdAt: '2025-11-28T10:00:00Z',
        test: false,
        currencyCode: 'SEK',
        lineItems: {
          edges: [
            {
              node: {
                id: 'gid://shopify/LineItem/1',
                sku: 'PROD-001',
                name: 'Product 1',
                quantity: 1,
                originalUnitPriceSet: {
                  shopMoney: {
                    amount: '100.00',
                    currencyCode: 'SEK',
                  },
                },
                discountAllocations: [
                  {
                    allocatedAmountSet: {
                      shopMoney: {
                        amount: '10.00', // Line-level discount
                        currencyCode: 'SEK',
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
        discountAllocations: [
          {
            allocatedAmountSet: {
              shopMoney: {
                amount: '20.00', // Order-level discount
                currencyCode: 'SEK',
              },
            },
          },
        ],
        refunds: [],
      };

      const transactions = mapOrderToSaleTransactions(order, 'Europe/Stockholm');

      expect(transactions).toHaveLength(1);
      // Total discount = line-level (10) + order-level (20) = 30
      expect(transactions[0].discounts).toBeCloseTo(30.0, 2);
    });
  });

  describe('mapRefundToReturnTransactions', () => {
    it('should create RETURN transaction for refund', () => {
      const order: GraphQLOrder = {
        id: 'gid://shopify/Order/1004',
        name: '#1004',
        orderNumber: 1004,
        createdAt: '2025-11-28T10:00:00Z',
        test: false,
        currencyCode: 'SEK',
        lineItems: {
          edges: [
            {
              node: {
                id: 'gid://shopify/LineItem/1',
                sku: 'PROD-001',
                name: 'Test Product',
                quantity: 2,
                originalUnitPriceSet: {
                  shopMoney: {
                    amount: '100.00',
                    currencyCode: 'SEK',
                  },
                },
                discountAllocations: [],
              },
            },
          ],
        },
        discountAllocations: [],
        refunds: [
          {
            id: 'gid://shopify/Refund/1',
            createdAt: '2025-11-29T14:00:00Z',
            refundLineItems: {
              edges: [
                {
                  node: {
                    quantity: 1,
                    lineItem: {
                      id: 'gid://shopify/LineItem/1',
                      sku: 'PROD-001',
                      name: 'Test Product',
                      originalUnitPriceSet: {
                        shopMoney: {
                          amount: '100.00',
                          currencyCode: 'SEK',
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      };

      const transactions = mapRefundToReturnTransactions(order, 'Europe/Stockholm');

      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toEqual({
        shopify_order_id: 'gid://shopify/Order/1004',
        shopify_order_name: '#1004',
        shopify_order_number: 1004,
        shopify_refund_id: 'gid://shopify/Refund/1',
        shopify_line_item_id: 'gid://shopify/LineItem/1',
        event_type: 'RETURN',
        event_date: '2025-11-29', // Refund date, not order date
        currency: 'SEK',
        product_sku: 'PROD-001',
        product_title: 'Test Product',
        variant_title: null,
        quantity: 1,
        gross_sales: 0,
        discounts: 0,
        returns: 100.0, // Original price * quantity
        shipping: 0,
        tax: 0,
      });
    });
  });

  describe('mapOrderToTransactions', () => {
    it('should create both SALE and RETURN transactions', () => {
      const order: GraphQLOrder = {
        id: 'gid://shopify/Order/1005',
        name: '#1005',
        orderNumber: 1005,
        createdAt: '2025-11-28T10:00:00Z',
        test: false,
        currencyCode: 'SEK',
        lineItems: {
          edges: [
            {
              node: {
                id: 'gid://shopify/LineItem/1',
                sku: 'PROD-001',
                name: 'Test Product',
                quantity: 2,
                originalUnitPriceSet: {
                  shopMoney: {
                    amount: '100.00',
                    currencyCode: 'SEK',
                  },
                },
                discountAllocations: [],
              },
            },
          ],
        },
        discountAllocations: [],
        refunds: [
          {
            id: 'gid://shopify/Refund/1',
            createdAt: '2025-11-29T14:00:00Z',
            refundLineItems: {
              edges: [
                {
                  node: {
                    quantity: 1,
                    lineItem: {
                      id: 'gid://shopify/LineItem/1',
                      sku: 'PROD-001',
                      name: 'Test Product',
                      originalUnitPriceSet: {
                        shopMoney: {
                          amount: '100.00',
                          currencyCode: 'SEK',
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      };

      const transactions = mapOrderToTransactions(order, 'Europe/Stockholm');

      // Should have 1 SALE and 1 RETURN transaction
      expect(transactions).toHaveLength(2);

      const saleTransaction = transactions.find((t) => t.event_type === 'SALE');
      const returnTransaction = transactions.find((t) => t.event_type === 'RETURN');

      expect(saleTransaction).toBeDefined();
      expect(saleTransaction?.event_date).toBe('2025-11-28'); // Order date
      expect(saleTransaction?.gross_sales).toBe(200.0);

      expect(returnTransaction).toBeDefined();
      expect(returnTransaction?.event_date).toBe('2025-11-29'); // Refund date
      expect(returnTransaction?.returns).toBe(100.0);
    });
  });

  describe('calculateNetSales', () => {
    it('should calculate net sales correctly', () => {
      expect(calculateNetSales(100, 10, 5)).toBe(85); // 100 - 10 - 5
      expect(calculateNetSales(200, 20, 0)).toBe(180); // 200 - 20
      expect(calculateNetSales(150, 0, 0)).toBe(150); // 150 - 0 - 0
      expect(calculateNetSales(100, 30, 20)).toBe(50); // 100 - 30 - 20
    });
  });
});

