/**
 * Unit tests for Shopify sales calculation functions
 */

import { describe, it, expect } from 'vitest';
import {
  calculateShopifyLikeSales,
  type ShopifyOrder,
  type SalesResult,
} from './sales';

describe('calculateShopifyLikeSales', () => {
  it('should calculate sales for order without discounts or refunds', () => {
    const orders: ShopifyOrder[] = [
      {
        id: '1001',
        created_at: '2025-11-01T10:00:00Z',
        currency: 'SEK',
        financial_status: 'paid',
        cancelled_at: null,
        line_items: [
          { id: '1', price: '100.00', quantity: 2, total_discount: '0.00' },
          { id: '2', price: '50.00', quantity: 1, total_discount: '0.00' },
        ],
      },
    ];

    const result = calculateShopifyLikeSales(orders);

    expect(result.summary.grossSales).toBe(250.0); // 100*2 + 50*1
    expect(result.summary.discounts).toBe(0.0);
    expect(result.summary.returns).toBe(0.0);
    expect(result.summary.netSales).toBe(250.0); // 250 - 0 - 0

    expect(result.perOrder).toHaveLength(1);
    expect(result.perOrder[0]).toEqual({
      orderId: '1001',
      grossSales: 250.0,
      discounts: 0.0,
      returns: 0.0,
      netSales: 250.0,
    });
  });

  it('should calculate sales for order with discounts', () => {
    const orders: ShopifyOrder[] = [
      {
        id: '1002',
        created_at: '2025-11-02T10:00:00Z',
        currency: 'SEK',
        financial_status: 'paid',
        cancelled_at: null,
        line_items: [
          { id: '3', price: '200.00', quantity: 1, total_discount: '20.00' },
          { id: '4', price: '150.00', quantity: 2, total_discount: '30.00' },
        ],
      },
    ];

    const result = calculateShopifyLikeSales(orders);

    expect(result.summary.grossSales).toBe(500.0); // 200*1 + 150*2
    expect(result.summary.discounts).toBe(50.0); // 20 + 30
    expect(result.summary.returns).toBe(0.0);
    expect(result.summary.netSales).toBe(450.0); // 500 - 50 - 0

    expect(result.perOrder[0]).toEqual({
      orderId: '1002',
      grossSales: 500.0,
      discounts: 50.0,
      returns: 0.0,
      netSales: 450.0,
    });
  });

  it('should calculate sales for partially refunded order', () => {
    const orders: ShopifyOrder[] = [
      {
        id: '1003',
        created_at: '2025-11-03T10:00:00Z',
        currency: 'SEK',
        financial_status: 'partially_refunded',
        cancelled_at: null,
        line_items: [
          { id: '5', price: '300.00', quantity: 2, total_discount: '0.00' },
        ],
        refunds: [
          {
            id: 'refund1',
            created_at: '2025-11-03T12:00:00Z',
            refund_line_items: [
              {
                line_item_id: '5',
                quantity: 1,
                subtotal: '300.00',
                line_item: { price: '300.00' },
              },
            ],
          },
        ],
      },
    ];

    const result = calculateShopifyLikeSales(orders);

    expect(result.summary.grossSales).toBe(600.0); // 300*2
    expect(result.summary.discounts).toBe(0.0);
    expect(result.summary.returns).toBe(300.0); // 1 item refunded
    expect(result.summary.netSales).toBe(300.0); // 600 - 0 - 300

    expect(result.perOrder[0]).toEqual({
      orderId: '1003',
      grossSales: 600.0,
      discounts: 0.0,
      returns: 300.0,
      netSales: 300.0,
    });
  });

  it('should calculate refunds from line_item.price when subtotal is missing', () => {
    const orders: ShopifyOrder[] = [
      {
        id: '1004',
        created_at: '2025-11-04T10:00:00Z',
        currency: 'SEK',
        financial_status: 'paid',
        cancelled_at: null,
        line_items: [
          { id: '6', price: '250.00', quantity: 3, total_discount: '0.00' },
        ],
        refunds: [
          {
            id: 'refund2',
            created_at: '2025-11-04T12:00:00Z',
            refund_line_items: [
              {
                line_item_id: '6',
                quantity: 1,
                // No subtotal provided, should use line_item.price
                line_item: { price: '250.00' },
              },
            ],
          },
        ],
      },
    ];

    const result = calculateShopifyLikeSales(orders);

    expect(result.summary.grossSales).toBe(750.0); // 250*3
    expect(result.summary.returns).toBe(250.0); // 250*1 (calculated from line_item.price)
    expect(result.summary.netSales).toBe(500.0); // 750 - 0 - 250
  });

  it('should calculate refunds from original line_item price when line_item.price is missing', () => {
    const orders: ShopifyOrder[] = [
      {
        id: '1005',
        created_at: '2025-11-05T10:00:00Z',
        currency: 'SEK',
        financial_status: 'paid',
        cancelled_at: null,
        line_items: [
          { id: '7', price: '180.00', quantity: 2, total_discount: '0.00' },
        ],
        refunds: [
          {
            id: 'refund3',
            created_at: '2025-11-05T12:00:00Z',
            refund_line_items: [
              {
                line_item_id: '7',
                quantity: 1,
                // No subtotal, no line_item.price - should use original line_item
              },
            ],
          },
        ],
      },
    ];

    const result = calculateShopifyLikeSales(orders);

    expect(result.summary.grossSales).toBe(360.0); // 180*2
    expect(result.summary.returns).toBe(180.0); // 180*1 (from original line_item)
    expect(result.summary.netSales).toBe(180.0); // 360 - 0 - 180
  });

  it('should aggregate multiple orders correctly', () => {
    const orders: ShopifyOrder[] = [
      {
        id: '1001',
        created_at: '2025-11-01T10:00:00Z',
        currency: 'SEK',
        financial_status: 'paid',
        cancelled_at: null,
        line_items: [
          { id: '1', price: '100.00', quantity: 2, total_discount: '0.00' },
          { id: '2', price: '50.00', quantity: 1, total_discount: '0.00' },
        ],
      },
      {
        id: '1002',
        created_at: '2025-11-02T10:00:00Z',
        currency: 'SEK',
        financial_status: 'paid',
        cancelled_at: null,
        line_items: [
          { id: '3', price: '200.00', quantity: 1, total_discount: '20.00' },
          { id: '4', price: '150.00', quantity: 2, total_discount: '30.00' },
        ],
      },
      {
        id: '1003',
        created_at: '2025-11-03T10:00:00Z',
        currency: 'SEK',
        financial_status: 'partially_refunded',
        cancelled_at: null,
        line_items: [
          { id: '5', price: '300.00', quantity: 2, total_discount: '0.00' },
        ],
        refunds: [
          {
            id: 'refund1',
            created_at: '2025-11-03T12:00:00Z',
            refund_line_items: [
              {
                line_item_id: '5',
                quantity: 1,
                subtotal: '300.00',
                line_item: { price: '300.00' },
              },
            ],
          },
        ],
      },
    ];

    const result = calculateShopifyLikeSales(orders);

    expect(result.summary.grossSales).toBe(1350.0); // 250 + 500 + 600
    expect(result.summary.discounts).toBe(50.0); // 0 + 50 + 0
    expect(result.summary.returns).toBe(300.0); // 0 + 0 + 300
    expect(result.summary.netSales).toBe(1000.0); // 1350 - 50 - 300

    expect(result.perOrder).toHaveLength(3);
  });

  it('should exclude orders with invalid financial_status', () => {
    const orders: ShopifyOrder[] = [
      {
        id: '1001',
        created_at: '2025-11-01T10:00:00Z',
        currency: 'SEK',
        financial_status: 'paid',
        cancelled_at: null,
        line_items: [
          { id: '1', price: '100.00', quantity: 1, total_discount: '0.00' },
        ],
      },
      {
        id: '1002',
        created_at: '2025-11-02T10:00:00Z',
        currency: 'SEK',
        financial_status: 'pending', // Should be excluded
        cancelled_at: null,
        line_items: [
          { id: '2', price: '200.00', quantity: 1, total_discount: '0.00' },
        ],
      },
      {
        id: '1003',
        created_at: '2025-11-03T10:00:00Z',
        currency: 'SEK',
        financial_status: 'unpaid', // Should be excluded
        cancelled_at: null,
        line_items: [
          { id: '3', price: '300.00', quantity: 1, total_discount: '0.00' },
        ],
      },
    ];

    const result = calculateShopifyLikeSales(orders);

    expect(result.perOrder).toHaveLength(1); // Only order 1001
    expect(result.summary.grossSales).toBe(100.0); // Only order 1001
  });

  it('should include cancelled orders (they are handled via refunds)', () => {
    const orders: ShopifyOrder[] = [
      {
        id: '1001',
        created_at: '2025-11-01T10:00:00Z',
        currency: 'SEK',
        financial_status: 'paid',
        cancelled_at: '2025-11-01T11:00:00Z', // Cancelled but paid
        line_items: [
          { id: '1', price: '100.00', quantity: 1, total_discount: '0.00' },
        ],
        refunds: [
          {
            id: 'refund1',
            created_at: '2025-11-01T11:00:00Z',
            refund_line_items: [
              {
                line_item_id: '1',
                quantity: 1,
                subtotal: '100.00',
                line_item: { price: '100.00' },
              },
            ],
          },
        ],
      },
    ];

    const result = calculateShopifyLikeSales(orders);

    // Cancelled order is included, but refund offsets it
    expect(result.summary.grossSales).toBe(100.0);
    expect(result.summary.returns).toBe(100.0);
    expect(result.summary.netSales).toBe(0.0); // 100 - 0 - 100
  });

  it('should handle floating-point precision correctly', () => {
    const orders: ShopifyOrder[] = [
      {
        id: '1001',
        created_at: '2025-11-01T10:00:00Z',
        currency: 'SEK',
        financial_status: 'paid',
        cancelled_at: null,
        line_items: [
          { id: '1', price: '33.33', quantity: 3, total_discount: '10.00' },
          { id: '2', price: '66.67', quantity: 1, total_discount: '5.50' },
        ],
      },
    ];

    const result = calculateShopifyLikeSales(orders);

    // 33.33*3 = 99.99, 66.67*1 = 66.67, total = 166.66
    expect(result.summary.grossSales).toBe(166.66);
    expect(result.summary.discounts).toBe(15.5); // 10.00 + 5.50
    expect(result.summary.netSales).toBe(151.16); // 166.66 - 15.5 = 151.16

    // All values should be properly rounded to 2 decimals
    expect(result.summary.grossSales.toString().split('.')[1]?.length || 0).toBeLessThanOrEqual(2);
    expect(result.summary.discounts.toString().split('.')[1]?.length || 0).toBeLessThanOrEqual(2);
    expect(result.summary.netSales.toString().split('.')[1]?.length || 0).toBeLessThanOrEqual(2);
  });
});

