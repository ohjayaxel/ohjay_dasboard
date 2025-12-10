/**
 * Shopify Data Research Script
 * 
 * Undersöker och demonstrerar hur man hämtar och beräknar korrekt data
 * från Shopify GraphQL API för:
 * - Bruttoförsäljning
 * - Nettoförsäljning
 * - Returer
 * - Rabatter
 * - Skatter
 * 
 * Uppdelat per:
 * - Produkt (SKU/variant)
 * - Land (country)
 * - Kundtyp (ny kund vs återkommande kund)
 */

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrdersGraphQL, type GraphQLOrder } from '@/lib/integrations/shopify-graphql';

// Configuration
const STORE_TIMEZONE = 'Europe/Stockholm';

// Load environment variables
const envPath = require('path').resolve(process.cwd(), 'env', 'local.prod.sh');
try {
  const envFile = require('fs').readFileSync(envPath, 'utf-8');
  envFile.split('\n').forEach((line: string) => {
    if (line && !line.startsWith('#') && line.includes('=')) {
      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=').replace(/^["']|["']$/g, '').trim();
      if (key && value) {
        process.env[key.trim()] = value;
      }
    }
  });
} catch (e) {
  console.warn('Could not load env file, using existing environment variables');
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Converts a date string to YYYY-MM-DD format in the shop's timezone
 * 
 * INSIGHT: We use transaction.processedAt instead of order.createdAt because:
 * - An order can be created on one date but the transaction processed on another
 * - For financial reporting, we care about when the payment was processed
 * - This ensures events are grouped by when money actually changed hands
 */
function toLocalDate(dateString: string, timezone: string = STORE_TIMEZONE): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

/**
 * Parses a money amount string to a number
 */
function parseMoneyAmount(amount: string): number {
  return parseFloat(amount) || 0;
}

/**
 * Rounds a number to 2 decimal places to avoid floating-point precision issues
 */
function roundTo2Decimals(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Gets country from order (prefers billing address, falls back to shipping address)
 */
function getCountryFromOrder(order: GraphQLOrder): string | null {
  if (order.billingAddress?.countryCode) {
    return order.billingAddress.countryCode.toUpperCase();
  }
  if (order.billingAddress?.country) {
    return order.billingAddress.country;
  }
  if (order.shippingAddress?.countryCode) {
    return order.shippingAddress.countryCode.toUpperCase();
  }
  if (order.shippingAddress?.country) {
    return order.shippingAddress.country;
  }
  return null;
}

/**
 * Determines if a customer is new based on customer.numberOfOrders
 * 
 * INSIGHT: Shopify returns numberOfOrders as a STRING, not a number.
 * - numberOfOrders === "1" means this is the customer's first order (NEW CUSTOMER)
 * - numberOfOrders > "1" means they have ordered before (RETURNING CUSTOMER)
 * - If customer is null or numberOfOrders is missing, it's likely a guest checkout
 */
function determineIsNewCustomer(order: GraphQLOrder): boolean | null {
  if (!order.customer?.numberOfOrders) {
    return null; // Guest checkout or no customer data
  }
  const numOrders = parseInt(order.customer.numberOfOrders, 10);
  if (isNaN(numOrders)) {
    return null;
  }
  return numOrders === 1; // New customer if this is their first order
}

/**
 * Extracts product key from line item (SKU or line item ID as fallback)
 */
function getProductKey(lineItem: { sku: string | null; id: string }): string {
  return lineItem.sku || lineItem.id;
}

// ============================================================================
// DATA STRUCTURES
// ============================================================================

type LineItemData = {
  productKey: string;
  productName: string;
  quantity: number;
  gross_sales: number;
  discounts: number;
  tax: number;
  net_sales: number;
};

type OrderData = {
  orderId: string;
  orderName: string;
  eventDate: string;
  country: string | null;
  customerType: 'NEW' | 'RETURNING' | 'GUEST';
  currency: string;
  lineItems: LineItemData[];
  refunds: {
    productKey: string;
    productName: string;
    quantity: number;
    refundAmount: number;
  }[];
  totalGrossSales: number;
  totalDiscounts: number;
  totalTax: number;
  totalNetSales: number;
  totalReturns: number;
};

// ============================================================================
// CALCULATION FUNCTIONS
// ============================================================================

/**
 * Processes a single order and calculates all metrics
 * 
 * INSIGHTS:
 * 1. Gross sales = originalUnitPriceSet.shopMoney.amount × quantity
 *    - This is the price before any discounts or taxes
 * 
 * 2. Discounts = sum of discountAllocations (excluding tax)
 *    - Shopify includes tax in discount amounts, so we divide by 1.25 to exclude 25% VAT
 *    - Discounts can be on line-level (discountAllocations) or order-level (totalDiscountsSet)
 *    - Order-level discounts need to be distributed proportionally across line items
 * 
 * 3. Tax = sum of taxLines.priceSet.shopMoney.amount
 *    - Tax is already calculated and included in the order total
 * 
 * 4. Net sales = gross_sales - discounts
 *    - This represents the actual revenue (excluding tax)
 * 
 * 5. Returns = refund amounts from refundLineItems
 *    - Returns use the original line item price, not the discounted price
 */
export function processOrder(order: GraphQLOrder, timezone: string = STORE_TIMEZONE): OrderData | null {
  // Exclude cancelled orders
  if (order.cancelledAt) {
    return null;
  }
  
  // Filter for successful transactions
  const successfulTransactions = (order.transactions || []).filter(
    (txn) =>
      (txn.kind === 'SALE' || txn.kind === 'CAPTURE') &&
      txn.status === 'SUCCESS' &&
      txn.processedAt,
  );

  if (successfulTransactions.length === 0) {
    return null; // Skip orders without successful transactions
  }

  // Use transaction.processedAt for event date (not order.createdAt)
  const transactionTimestamp = successfulTransactions[0].processedAt!;
  const eventDate = toLocalDate(transactionTimestamp, timezone);

  const country = getCountryFromOrder(order);
  const customerTypeResult = determineIsNewCustomer(order);
  const customerType =
    customerTypeResult === null ? 'GUEST' : customerTypeResult ? 'NEW' : 'RETURNING';

  // NEW CALCULATION METHOD: Use Shopify's fields directly
  // subtotalPriceSet = ordersumma efter rabatter, INKL moms
  // totalTaxSet = total moms på ordern
  const subtotalPriceSet = order.subtotalPriceSet
    ? parseMoneyAmount(order.subtotalPriceSet.shopMoney.amount)
    : 0;
  
  // Get total tax - use totalTaxSet if available, otherwise sum taxLines
  let totalTax: number;
  if (order.totalTaxSet) {
    totalTax = parseMoneyAmount(order.totalTaxSet.shopMoney.amount);
  } else {
    // Fallback: sum taxLines if totalTaxSet not available
    totalTax = 0;
    for (const edge of order.lineItems.edges) {
      const lineItem = edge.node;
      if (lineItem.taxLines && lineItem.taxLines.length > 0) {
        for (const taxLine of lineItem.taxLines) {
          totalTax += parseMoneyAmount(taxLine.priceSet.shopMoney.amount);
        }
      }
    }
  }
  totalTax = roundTo2Decimals(totalTax);

  // Net Sales EXCL tax BEFORE refunds
  // = subtotalPriceSet - totalTax
  const netSalesExclTaxBeforeRefunds = roundTo2Decimals(subtotalPriceSet - totalTax);

  // Process line items for display/aggregation purposes
  // Calculate gross sales (for reference, still using original prices)
  let totalGrossSales = 0;
  const lineItemsData: LineItemData[] = [];

  for (const edge of order.lineItems.edges) {
    const lineItem = edge.node;
    const grossLine = roundTo2Decimals(
      parseMoneyAmount(lineItem.originalUnitPriceSet.shopMoney.amount) * lineItem.quantity,
    );
    totalGrossSales += grossLine;

    // Calculate discounts (INCL tax) for display
    let lineDiscountsInclTax = 0;
    for (const allocation of lineItem.discountAllocations) {
      lineDiscountsInclTax += parseMoneyAmount(allocation.allocatedAmountSet.shopMoney.amount);
    }
    lineDiscountsInclTax = roundTo2Decimals(lineDiscountsInclTax);

    // Calculate tax from taxLines
    let lineTax = 0;
    if (lineItem.taxLines && lineItem.taxLines.length > 0) {
      for (const taxLine of lineItem.taxLines) {
        lineTax += parseMoneyAmount(taxLine.priceSet.shopMoney.amount);
      }
    }
    lineTax = roundTo2Decimals(lineTax);

    // For line items, we calculate net sales proportionally
    // This is for display/aggregation purposes only
    // The order-level net_sales uses the correct Shopify method
    const lineGrossExclTax = roundTo2Decimals(grossLine - lineTax);
    // Note: We don't calculate line-level net_sales_excl_tax here since discounts
    // are distributed at order level. For accurate breakdown, we'd need to know
    // how Shopify distributes discounts, but for order totals we use the correct method.
    const lineNetSales = roundTo2Decimals(grossLine - lineDiscountsInclTax);

    lineItemsData.push({
      productKey: getProductKey(lineItem),
      productName: lineItem.name,
      quantity: lineItem.quantity,
      gross_sales: grossLine, // INCL tax
      discounts: lineDiscountsInclTax, // INCL tax (for display)
      tax: lineTax,
      net_sales: lineNetSales, // INCL tax (for display, not used for order totals)
    });
  }

  // Process refunds - use subtotalSet (EXCL tax) if available
  const refunds: OrderData['refunds'] = [];
  let totalRefundsExclTax = 0;
  
  for (const refund of order.refunds) {
    for (const refundLineItemEdge of refund.refundLineItems.edges) {
      const refundLineItem = refundLineItemEdge.node;
      const originalLineItem = refundLineItem.lineItem;

      if (!originalLineItem) {
        continue;
      }

      // Use subtotalSet (EXCL tax) if available, otherwise fallback to original price calculation
      let refundAmountExclTax: number;
      if (refundLineItem.subtotalSet) {
        refundAmountExclTax = parseMoneyAmount(refundLineItem.subtotalSet.shopMoney.amount);
      } else {
        // Fallback: use original price * quantity (this might be INCL tax, so less accurate)
        const originalPrice = parseMoneyAmount(originalLineItem.originalUnitPriceSet.shopMoney.amount);
        refundAmountExclTax = originalPrice * refundLineItem.quantity;
      }
      
      refundAmountExclTax = roundTo2Decimals(refundAmountExclTax);
      totalRefundsExclTax += refundAmountExclTax;

      refunds.push({
        productKey: getProductKey(originalLineItem),
        productName: originalLineItem.name,
        quantity: refundLineItem.quantity,
        refundAmount: refundAmountExclTax,
      });
    }
  }
  
  totalRefundsExclTax = roundTo2Decimals(totalRefundsExclTax);

  // Net Sales EXCL tax AFTER refunds
  const netSalesExclTaxAfterRefunds = roundTo2Decimals(
    netSalesExclTaxBeforeRefunds - totalRefundsExclTax
  );

  // Calculate total discounts (INCL tax) for display
  const totalDiscounts = order.totalDiscountsSet
    ? parseMoneyAmount(order.totalDiscountsSet.shopMoney.amount)
    : 0;

  // Return values using the new calculation method
  const totalNetSales = netSalesExclTaxAfterRefunds;
  const totalReturns = totalRefundsExclTax;

  return {
    orderId: order.id,
    orderName: order.name,
    eventDate,
    country,
    customerType,
    currency: order.currencyCode,
    lineItems: lineItemsData,
    refunds,
    totalGrossSales, // Gross sales INCL tax (for reference)
    totalDiscounts, // Total discounts INCL tax (for reference)
    totalTax, // Total tax
    totalNetSales, // Net sales EXCL tax AFTER refunds (NEW METHOD: subtotalPriceSet - totalTax - refunds)
    totalReturns, // Returns EXCL tax (NEW METHOD: sum of refundLineItems.subtotalSet)
  };
}

// ============================================================================
// AGGREGATION FUNCTIONS
// ============================================================================

type AggregationKey = {
  date: string;
  productKey?: string;
  country?: string | null;
  customerType: string;
  currency: string;
};

type AggregationResult = AggregationKey & {
  orders: number;
  gross_sales: number;
  discounts: number;
  returns: number;
  tax: number;
  net_sales: number;
};

/**
 * Aggregates order data by various dimensions
 */
function aggregateData(
  ordersData: OrderData[],
  groupBy: 'product-country-customer' | 'country-customer' | 'customer' | 'total',
): AggregationResult[] {
  const byKey = new Map<string, AggregationResult>();
  const orderIdsByKey = new Map<string, Set<string>>();

  for (const orderData of ordersData) {
    // For non-product aggregations, use order-level totals directly
    if (groupBy !== 'product-country-customer') {
      let key: AggregationKey;
      let keyString: string;

      if (groupBy === 'country-customer') {
        key = {
          date: orderData.eventDate,
          country: orderData.country,
          customerType: orderData.customerType,
          currency: orderData.currency,
        };
        keyString = `${key.date}|${key.country || 'NULL'}|${key.customerType}|${key.currency}`;
      } else if (groupBy === 'customer') {
        key = {
          date: orderData.eventDate,
          customerType: orderData.customerType,
          currency: orderData.currency,
        };
        keyString = `${key.date}|${key.customerType}|${key.currency}`;
      } else {
        // total
        key = {
          date: orderData.eventDate,
          customerType: 'ALL',
          currency: orderData.currency,
        };
        keyString = `${key.date}|${key.customerType}|${key.currency}`;
      }

      if (!byKey.has(keyString)) {
        byKey.set(keyString, {
          ...key,
          orders: 0,
          gross_sales: 0,
          discounts: 0,
          returns: 0,
          tax: 0,
          net_sales: 0,
        });
        orderIdsByKey.set(keyString, new Set());
      }

      const agg = byKey.get(keyString)!;
      const orderIds = orderIdsByKey.get(keyString)!;

      if (!orderIds.has(orderData.orderId)) {
        orderIds.add(orderData.orderId);
        agg.orders++;
        
        // Use order-level totals (correct calculation)
        agg.gross_sales += orderData.totalGrossSales;
        agg.discounts += orderData.totalDiscounts;
        agg.tax += orderData.totalTax;
        agg.net_sales += orderData.totalNetSales; // Already EXCL tax after refunds
        agg.returns += orderData.totalReturns; // Already EXCL tax
      }
    } else {
      // For product-level aggregation, we need to distribute order-level totals proportionally
      // Calculate order-level net sales (before refunds) for proportional distribution
      const orderNetSalesBeforeRefunds = orderData.totalGrossSales - orderData.totalDiscounts - orderData.totalTax;
      
      for (const lineItem of orderData.lineItems) {
        let key: AggregationKey = {
          date: orderData.eventDate,
          productKey: lineItem.productKey,
          country: orderData.country,
          customerType: orderData.customerType,
          currency: orderData.currency,
        };
        let keyString = `${key.date}|${key.productKey}|${key.country || 'NULL'}|${key.customerType}|${key.currency}`;

        if (!byKey.has(keyString)) {
          byKey.set(keyString, {
            ...key,
            orders: 0,
            gross_sales: 0,
            discounts: 0,
            returns: 0,
            tax: 0,
            net_sales: 0,
          });
          orderIdsByKey.set(keyString, new Set());
        }

        const agg = byKey.get(keyString)!;
        const orderIds = orderIdsByKey.get(keyString)!;

        if (!orderIds.has(orderData.orderId)) {
          orderIds.add(orderData.orderId);
          agg.orders++;
        }

        // For product-level, distribute proportionally based on gross sales
        const lineProportion = orderData.totalGrossSales > 0 
          ? lineItem.gross_sales / orderData.totalGrossSales 
          : 0;
        
        agg.gross_sales += lineItem.gross_sales;
        agg.discounts += lineItem.discounts; // INCL tax for display
        agg.tax += lineItem.tax;
        // Distribute order-level net sales proportionally
        agg.net_sales += roundTo2Decimals(orderNetSalesBeforeRefunds * lineProportion);
      }

      // Process refunds for product-level
      for (const refund of orderData.refunds) {
        let key: AggregationKey = {
          date: orderData.eventDate,
          productKey: refund.productKey,
          country: orderData.country,
          customerType: orderData.customerType,
          currency: orderData.currency,
        };
        let keyString = `${key.date}|${refund.productKey}|${orderData.country || 'NULL'}|${orderData.customerType}|${orderData.currency}`;

        if (!byKey.has(keyString)) {
          byKey.set(keyString, {
            ...key,
            orders: 0,
            gross_sales: 0,
            discounts: 0,
            returns: 0,
            tax: 0,
            net_sales: 0,
          });
        }

        const agg = byKey.get(keyString)!;
        agg.returns += refund.refundAmount; // Already EXCL tax
        agg.net_sales -= refund.refundAmount; // Returns reduce net sales
      }
    }
  }

  // Round all values
  for (const agg of byKey.values()) {
    agg.gross_sales = roundTo2Decimals(agg.gross_sales);
    agg.discounts = roundTo2Decimals(agg.discounts);
    agg.returns = roundTo2Decimals(agg.returns);
    agg.tax = roundTo2Decimals(agg.tax);
    agg.net_sales = roundTo2Decimals(agg.net_sales);
  }

  return Array.from(byKey.values()).sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.customerType !== b.customerType) return a.customerType.localeCompare(b.customerType);
    if (a.productKey && b.productKey && a.productKey !== b.productKey) return a.productKey.localeCompare(b.productKey);
    if ((a.country || '') !== (b.country || '')) return (a.country || '').localeCompare(b.country || '');
    return a.currency.localeCompare(b.currency);
  });
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Reads reference CSV file with expected values
 * CSV format should be:
 *   dimension,dimension_value,orders,gross_sales,net_sales,discounts,tax,returns
 * 
 * Examples:
 *   customer_type,NEW,42,52581.02,41030.57,0,0,0
 *   customer_type,RETURNING,119,93026.80,81679.77,0,0,0
 *   country_customer_type,SE|NEW,34,54084.80,44407.70,0,0,0
 *   total,ALL,161,145607.82,122710.34,0,0,0
 */
function readReferenceCSV(filePath: string): Map<string, {
  orders: number;
  gross_sales: number;
  net_sales: number;
  discounts: number;
  tax: number;
  returns: number;
}> {
  const fs = require('fs');
  const path = require('path');
  
  const fullPath = path.resolve(process.cwd(), filePath);
  
  if (!fs.existsSync(fullPath)) {
    console.log(`⚠️  Reference CSV file not found: ${fullPath}`);
    return new Map();
  }
  
  const content = fs.readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n').filter((line: string) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('#');
  });
  
  // Skip header if it exists
  if (lines.length > 0 && lines[0].toLowerCase().includes('dimension')) {
    lines.shift();
  }
  
  const reference = new Map<string, {
    orders: number;
    gross_sales: number;
    net_sales: number;
    discounts: number;
    tax: number;
    returns: number;
  }>();
  
  for (const line of lines) {
    const parts = line.split(',').map((p: string) => p.trim());
    if (parts.length >= 8) {
      const dimension = parts[0];
      const dimensionValue = parts[1];
      
      // Create key based on dimension type
      let key: string;
      if (dimension === 'customer_type') {
        key = `customer_type|${dimensionValue}`;
      } else if (dimension === 'country_customer_type') {
        // Format: SE|NEW
        key = `country_customer_type|${dimensionValue}`;
      } else if (dimension === 'product_country_customer_type') {
        // Format: 22895|SE|NEW
        key = `product_country_customer_type|${dimensionValue}`;
      } else if (dimension === 'total') {
        key = `total|ALL`;
      } else {
        key = `${dimension}|${dimensionValue}`;
      }
      
      reference.set(key, {
        orders: parseFloat(parts[2]) || 0,
        gross_sales: parseFloat(parts[3]) || 0,
        net_sales: parseFloat(parts[4]) || 0,
        discounts: parseFloat(parts[5]) || 0,
        tax: parseFloat(parts[6]) || 0,
        returns: parseFloat(parts[7]) || 0,
      });
    }
  }
  
  return reference;
}

async function main() {
  // Parse CLI arguments
  const args = process.argv.slice(2);
  const tenantSlug = args.find((arg) => arg.startsWith('--tenant='))?.split('=')[1] || 'skinome';
  const dateArg = args.find((arg) => arg.startsWith('--date='))?.split('=')[1] || '2025-11-30';
  const referenceCSV = args.find((arg) => arg.startsWith('--reference='))?.split('=')[1];

  console.log('='.repeat(80));
  console.log('Shopify Data Research Script');
  console.log('='.repeat(80));
  console.log(`Tenant: ${tenantSlug}`);
  console.log(`Date: ${dateArg}`);
  console.log(`Timezone: ${STORE_TIMEZONE}`);
  if (referenceCSV) {
    console.log(`Reference CSV: ${referenceCSV}`);
  }
  console.log('='.repeat(80));
  console.log('');

  // Get tenant and connection
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name, slug')
    .eq('slug', tenantSlug)
    .maybeSingle();

  if (!tenant) {
    console.error(`❌ Tenant "${tenantSlug}" not found`);
    process.exit(1);
  }

  console.log(`✅ Found tenant: ${tenant.name} (${tenant.slug})\n`);

  const { data: connection } = await supabase
    .from('connections')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('source', 'shopify')
    .maybeSingle();

  if (!connection) {
    console.error('❌ Shopify connection not found');
    process.exit(1);
  }

  const shopDomain = connection.meta?.store_domain || connection.meta?.shop;
  console.log(`✅ Found Shopify connection: ${shopDomain}\n`);

  // Check stored scopes in connection metadata
  console.log('='.repeat(80));
  console.log('SCOPE VERIFICATION');
  console.log('='.repeat(80));
  console.log('');
  
  const storedScopes = connection.meta?.scope || connection.meta?.scopes;
  console.log('Stored scopes in connection metadata:');
  if (storedScopes) {
    if (typeof storedScopes === 'string') {
      const scopeList = storedScopes.split(',').map((s: string) => s.trim());
      console.log(`  ${scopeList.join(', ')}`);
      console.log(`  ✓ read_orders: ${scopeList.includes('read_orders') ? 'YES ✅' : 'NO ❌'}`);
      console.log(`  ✓ read_customers: ${scopeList.includes('read_customers') ? 'YES ✅' : 'NO ❌'}`);
    } else if (Array.isArray(storedScopes)) {
      console.log(`  ${storedScopes.join(', ')}`);
      console.log(`  ✓ read_orders: ${storedScopes.includes('read_orders') ? 'YES ✅' : 'NO ❌'}`);
      console.log(`  ✓ read_customers: ${storedScopes.includes('read_customers') ? 'YES ✅' : 'NO ❌'}`);
    } else {
      console.log(`  ${JSON.stringify(storedScopes)} (unknown format)`);
    }
  } else {
    console.log('  ⚠️  No scope information found in metadata');
  }
  console.log('');

  // Step 1: Fetch orders in wider range
  // INSIGHT: Events are grouped by transaction.processedAt (converted to local time),
  // not order.createdAt. An order created on 2025-11-29 might have a transaction
  // processed on 2025-11-30 in local time.
  const startDateObj = new Date(dateArg + 'T00:00:00Z');
  const endDateObj = new Date(dateArg + 'T23:59:59Z');

  // Fetch orders from 1 day before to 1 day after to catch all relevant orders
  const fetchStartDate = new Date(startDateObj);
  fetchStartDate.setDate(fetchStartDate.getDate() - 1);
  const fetchEndDate = new Date(endDateObj);
  fetchEndDate.setDate(fetchEndDate.getDate() + 1);

  const fetchStartDateStr = fetchStartDate.toISOString().slice(0, 10);
  const fetchEndDateStr = fetchEndDate.toISOString().slice(0, 10);

  console.log(`📥 Fetching orders from ${fetchStartDateStr} to ${fetchEndDateStr} (wide range)...`);
  console.log('   Reason: Events are grouped by transaction.processedAt, not order.createdAt\n');

  const orders = await fetchShopifyOrdersGraphQL({
    tenantId: tenant.id,
    shopDomain,
    since: fetchStartDateStr,
    until: fetchEndDateStr,
    excludeTest: true,
  });

  console.log(`✅ Fetched ${orders.length} orders\n`);

  // Debug: Check customer data in fetched orders
  let ordersWithCustomerId = 0;
  let ordersWithNumberOfOrders = 0;
  let sampleOrdersWithCustomer: Array<{ name: string; customerId: string; numberOfOrders: string }> = [];
  
  for (const order of orders.slice(0, 50)) { // Check first 50 orders
    if (order.customer?.id) {
      ordersWithCustomerId++;
      if (order.customer?.numberOfOrders) {
        ordersWithNumberOfOrders++;
        if (sampleOrdersWithCustomer.length < 5) {
          sampleOrdersWithCustomer.push({
            name: order.name,
            customerId: order.customer.id.substring(0, 30) + '...',
            numberOfOrders: order.customer.numberOfOrders,
          });
        }
      }
    }
  }

  console.log('='.repeat(80));
  console.log('CUSTOMER DATA CHECK IN FETCHED ORDERS');
  console.log('='.repeat(80));
  console.log('');
  console.log(`First 50 orders checked:`);
  console.log(`  - Orders with customer.id: ${ordersWithCustomerId}`);
  console.log(`  - Orders with customer.numberOfOrders: ${ordersWithNumberOfOrders}`);
  if (sampleOrdersWithCustomer.length > 0) {
    console.log('');
    console.log('Sample orders with customer data:');
    for (const sample of sampleOrdersWithCustomer) {
      const numOrders = parseInt(sample.numberOfOrders, 10);
      const customerType = !isNaN(numOrders) && numOrders === 1 ? 'NEW' : 'RETURNING';
      console.log(`  ${sample.name}: customerId=${sample.customerId}, numberOfOrders="${sample.numberOfOrders}" (${customerType})`);
    }
  }
  console.log('');

  if (orders.length === 0) {
    console.log('⚠️  No orders found for this date range');
    return;
  }

  // Step 2: Process orders and filter to target date
  console.log('🔨 Processing orders...');
  
  // Debug: Check orders before processing
  let ordersWithoutTransactions = 0;
  let ordersWithTransactions = 0;
  let ordersOnTargetDate = 0;
  let ordersOnOtherDates = 0;
  const ordersByDate = new Map<string, number>();
  
  for (const order of orders) {
    const successfulTransactions = (order.transactions || []).filter(
      (txn) =>
        (txn.kind === 'SALE' || txn.kind === 'CAPTURE') &&
        txn.status === 'SUCCESS' &&
        txn.processedAt,
    );
    
    if (successfulTransactions.length === 0) {
      ordersWithoutTransactions++;
      continue;
    }
    
    ordersWithTransactions++;
    const transactionTimestamp = successfulTransactions[0].processedAt!;
    const eventDate = toLocalDate(transactionTimestamp, STORE_TIMEZONE);
    
    const count = ordersByDate.get(eventDate) || 0;
    ordersByDate.set(eventDate, count + 1);
    
    if (eventDate === dateArg) {
      ordersOnTargetDate++;
    } else {
      ordersOnOtherDates++;
    }
  }
  
  console.log(`📊 Orders analysis:`);
  console.log(`  - Total orders fetched: ${orders.length}`);
  console.log(`  - Orders with successful transactions: ${ordersWithTransactions}`);
  console.log(`  - Orders without transactions: ${ordersWithoutTransactions}`);
  console.log(`  - Orders on target date (${dateArg}): ${ordersOnTargetDate}`);
  console.log(`  - Orders on other dates: ${ordersOnOtherDates}`);
  console.log(`  - Date distribution:`);
  const sortedDates = Array.from(ordersByDate.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [date, count] of sortedDates) {
    console.log(`    ${date}: ${count} orders`);
  }
  console.log('');
  
  const ordersData: OrderData[] = [];
  for (const order of orders) {
    const orderData = processOrder(order, STORE_TIMEZONE);
    if (orderData && orderData.eventDate === dateArg) {
      ordersData.push(orderData);
    }
  }

  console.log(`✅ Processed ${ordersData.length} orders for ${dateArg}\n`);

  if (ordersData.length === 0) {
    console.log(`⚠️  No orders found for ${dateArg}`);
    return;
  }

  // Debug: Analyze customer data
  console.log('='.repeat(80));
  console.log('DEBUG: CUSTOMER DATA ANALYSIS');
  console.log('='.repeat(80));
  console.log('');
  
  let ordersWithCustomer = 0;
  let ordersWithCustomerData = 0;
  let newCustomers = 0;
  let returningCustomers = 0;
  let guestCheckouts = 0;
  
  const customerDetails: Array<{
    orderName: string;
    customerId: string | null;
    numberOfOrders: string | null;
    customerType: string;
  }> = [];
  
  for (const orderData of ordersData) {
    const originalOrder = orders.find((o) => o.id === orderData.orderId);
    if (!originalOrder) continue;
    
    customerDetails.push({
      orderName: orderData.orderName,
      customerId: originalOrder.customer?.id || null,
      numberOfOrders: originalOrder.customer?.numberOfOrders || null,
      customerType: orderData.customerType,
    });
    
    if (originalOrder.customer?.id) {
      ordersWithCustomer++;
      if (originalOrder.customer?.numberOfOrders) {
        ordersWithCustomerData++;
        const numOrders = parseInt(originalOrder.customer.numberOfOrders, 10);
        if (numOrders === 1) {
          newCustomers++;
        } else if (numOrders > 1) {
          returningCustomers++;
        }
      }
    } else {
      guestCheckouts++;
    }
  }
  
  console.log(`Total orders processed: ${ordersData.length}`);
  console.log(`  - Orders with customer.id: ${ordersWithCustomer}`);
  console.log(`  - Orders with customer.numberOfOrders: ${ordersWithCustomerData}`);
  console.log(`  - NEW customers (numberOfOrders=1): ${newCustomers}`);
  console.log(`  - RETURNING customers (numberOfOrders>1): ${returningCustomers}`);
  console.log(`  - GUEST checkouts: ${guestCheckouts}`);
  console.log('');
  
  // Show first 10 orders with customer data details
  const ordersWithCustomerInfo = customerDetails.filter(d => d.customerId);
  if (ordersWithCustomerInfo.length > 0) {
    console.log(`First ${Math.min(10, ordersWithCustomerInfo.length)} orders with customer data:`);
    for (const detail of ordersWithCustomerInfo.slice(0, 10)) {
      console.log(`  ${detail.orderName}: customerId=${detail.customerId?.substring(0, 20)}..., numberOfOrders="${detail.numberOfOrders}", type=${detail.customerType}`);
    }
    console.log('');
  }
  
  // Show first 5 guest checkouts
  const guestOrders = customerDetails.filter(d => !d.customerId);
  if (guestOrders.length > 0) {
    console.log(`First ${Math.min(5, guestOrders.length)} guest checkouts:`);
    for (const detail of guestOrders.slice(0, 5)) {
      console.log(`  ${detail.orderName}: customerId=null, numberOfOrders=null, type=${detail.customerType}`);
    }
    console.log('');
  }
  
  console.log('='.repeat(80));
  console.log('');

  // Step 3: Demonstrate data structure with examples
  console.log('='.repeat(80));
  console.log('1. DATA STRUCTURE DEMONSTRATION');
  console.log('='.repeat(80));
  console.log('');

  // Show first order as example
  const exampleOrder = ordersData[0];
  const originalOrder = orders.find((o) => o.id === exampleOrder.orderId)!;

  console.log(`📦 Example Order: ${exampleOrder.orderName} (${exampleOrder.orderId})`);
  console.log('');
  console.log('GraphQL Response Structure:');
  console.log(`  Order ID: ${originalOrder.id}`);
  console.log(`  Order Name: ${originalOrder.name}`);
  console.log(`  Created At: ${originalOrder.createdAt}`);
  console.log(`  Processed At: ${originalOrder.processedAt}`);
  console.log(`  Currency: ${originalOrder.currencyCode}`);
  console.log(`  Customer ID: ${originalOrder.customer?.id || 'N/A (Guest)'}`);
  console.log(`  Customer numberOfOrders: ${originalOrder.customer?.numberOfOrders || 'N/A'}`);
  console.log(`  Customer Type: ${exampleOrder.customerType}`);
  console.log(`  Country: ${exampleOrder.country || 'N/A'}`);
  console.log(`  Event Date: ${exampleOrder.eventDate} (from transaction.processedAt converted to ${STORE_TIMEZONE})`);
  console.log('');

  console.log('Line Items:');
  for (let i = 0; i < Math.min(3, exampleOrder.lineItems.length); i++) {
    const item = exampleOrder.lineItems[i];
    const originalLineItem = originalOrder.lineItems.edges.find((e) => getProductKey(e.node) === item.productKey)?.node;
    console.log(`  ${i + 1}. ${item.productName}`);
    console.log(`     SKU: ${originalLineItem?.sku || 'N/A'}`);
    console.log(`     Quantity: ${item.quantity}`);
    console.log(`     Gross Sales: ${item.gross_sales.toFixed(2)} ${exampleOrder.currency}`);
    console.log(`     Discounts: ${item.discounts.toFixed(2)} ${exampleOrder.currency}`);
    console.log(`     Tax: ${item.tax.toFixed(2)} ${exampleOrder.currency}`);
    console.log(`     Net Sales: ${item.net_sales.toFixed(2)} ${exampleOrder.currency}`);
    console.log('');
  }

  if (exampleOrder.refunds.length > 0) {
    console.log('Refunds:');
    for (const refund of exampleOrder.refunds) {
      console.log(`  - ${refund.productName}: ${refund.quantity} × ${(refund.refundAmount / refund.quantity).toFixed(2)} = ${refund.refundAmount.toFixed(2)} ${exampleOrder.currency}`);
    }
    console.log('');
  }

  // Step 4: Demonstrate calculations
  console.log('='.repeat(80));
  console.log('2. CALCULATION DEMONSTRATION');
  console.log('='.repeat(80));
  console.log('');

  if (exampleOrder.lineItems.length > 0) {
    const firstItem = exampleOrder.lineItems[0];
    const originalLineItem = originalOrder.lineItems.edges[0].node;
    console.log(`Calculation for: ${firstItem.productName}`);
    console.log('');

    const originalPrice = parseMoneyAmount(originalLineItem.originalUnitPriceSet.shopMoney.amount);
    console.log(`1. Gross Sales Calculation:`);
    console.log(`   originalUnitPriceSet.shopMoney.amount = ${originalPrice}`);
    console.log(`   quantity = ${firstItem.quantity}`);
    console.log(`   gross_sales = ${originalPrice} × ${firstItem.quantity} = ${firstItem.gross_sales.toFixed(2)}`);
    console.log('');

    if (firstItem.discounts > 0) {
      console.log(`2. Discount Calculation:`);
      console.log(`   discountAllocations contains amounts INCLUDING tax (25% VAT)`);
      console.log(`   To exclude tax: divide by 1.25`);
      let totalDiscountInclTax = 0;
      for (const allocation of originalLineItem.discountAllocations) {
        const amount = parseMoneyAmount(allocation.allocatedAmountSet.shopMoney.amount);
        totalDiscountInclTax += amount;
        console.log(`     - Allocation: ${amount.toFixed(2)} (incl. tax)`);
      }
      console.log(`   Total discount (incl. tax): ${totalDiscountInclTax.toFixed(2)}`);
      console.log(`   Discount (excl. tax): ${totalDiscountInclTax.toFixed(2)} / 1.25 = ${firstItem.discounts.toFixed(2)}`);
      console.log('');
    }

    if (firstItem.tax > 0) {
      console.log(`3. Tax Calculation:`);
      console.log(`   Sum of taxLines.priceSet.shopMoney.amount:`);
      let totalTax = 0;
      if (originalLineItem.taxLines) {
        for (const taxLine of originalLineItem.taxLines) {
          const amount = parseMoneyAmount(taxLine.priceSet.shopMoney.amount);
          totalTax += amount;
          console.log(`     - Tax line: ${amount.toFixed(2)}`);
        }
      }
      console.log(`   Total tax: ${firstItem.tax.toFixed(2)}`);
      console.log('');
    }

    console.log(`4. Net Sales Calculation:`);
    console.log(`   net_sales = gross_sales - discounts`);
    console.log(`   net_sales = ${firstItem.gross_sales.toFixed(2)} - ${firstItem.discounts.toFixed(2)} = ${firstItem.net_sales.toFixed(2)}`);
    console.log('');

    console.log(`5. Customer Type Determination:`);
    console.log(`   customer.numberOfOrders = "${originalOrder.customer?.numberOfOrders || 'N/A'}"`);
    if (originalOrder.customer?.numberOfOrders) {
      const numOrders = parseInt(originalOrder.customer.numberOfOrders, 10);
      console.log(`   Parsed as number: ${numOrders}`);
      console.log(`   ${numOrders === 1 ? 'NEW customer (first order)' : 'RETURNING customer (has ordered before)'}`);
    } else {
      console.log(`   GUEST checkout (no customer data)`);
    }
    console.log('');
  }

  // Step 5: Aggregate and show results
  console.log('='.repeat(80));
  console.log('3. AGGREGATED RESULTS');
  console.log('='.repeat(80));
  console.log('');

  // By customer type
  console.log('📊 By Customer Type:');
  const byCustomer = aggregateData(ordersData, 'customer');
  for (const agg of byCustomer) {
    console.log(`  ${agg.customerType}:`);
    console.log(`    Orders: ${agg.orders}`);
    console.log(`    Gross Sales: ${agg.gross_sales.toFixed(2)} ${agg.currency}`);
    console.log(`    Discounts: ${agg.discounts.toFixed(2)} ${agg.currency}`);
    console.log(`    Tax: ${agg.tax.toFixed(2)} ${agg.currency}`);
    console.log(`    Returns: ${agg.returns.toFixed(2)} ${agg.currency}`);
    console.log(`    Net Sales: ${agg.net_sales.toFixed(2)} ${agg.currency}`);
    console.log('');
  }

  // By country and customer type
  console.log('🌍 By Country and Customer Type:');
  const byCountryCustomer = aggregateData(ordersData, 'country-customer');
  for (const agg of byCountryCustomer.slice(0, 10)) {
    console.log(`  ${agg.country || 'Unknown'}, ${agg.customerType}:`);
    console.log(`    Orders: ${agg.orders}`);
    console.log(`    Gross Sales: ${agg.gross_sales.toFixed(2)} ${agg.currency}`);
    console.log(`    Net Sales: ${agg.net_sales.toFixed(2)} ${agg.currency}`);
  }
  if (byCountryCustomer.length > 10) {
    console.log(`  ... and ${byCountryCustomer.length - 10} more combinations`);
  }
  console.log('');

  // By product, country, and customer type
  console.log('📦 By Product, Country, and Customer Type (top 10):');
  const byProduct = aggregateData(ordersData, 'product-country-customer');
  for (const agg of byProduct.slice(0, 10)) {
    console.log(`  Product: ${agg.productKey}, Country: ${agg.country || 'Unknown'}, ${agg.customerType}:`);
    console.log(`    Orders: ${agg.orders}, Gross: ${agg.gross_sales.toFixed(2)} ${agg.currency}, Net: ${agg.net_sales.toFixed(2)} ${agg.currency}`);
  }
  if (byProduct.length > 10) {
    console.log(`  ... and ${byProduct.length - 10} more combinations`);
  }
  console.log('');

  // Total
  console.log('📈 TOTAL:');
  const totals = aggregateData(ordersData, 'total');
  for (const total of totals) {
    console.log(`  Orders: ${total.orders}`);
    console.log(`  Gross Sales: ${total.gross_sales.toFixed(2)} ${total.currency}`);
    console.log(`  Discounts: ${total.discounts.toFixed(2)} ${total.currency}`);
    console.log(`  Tax: ${total.tax.toFixed(2)} ${total.currency}`);
    console.log(`  Returns: ${total.returns.toFixed(2)} ${total.currency}`);
    console.log(`  Net Sales: ${total.net_sales.toFixed(2)} ${total.currency}`);
  }
  console.log('');

  // Step 6: Compare with reference CSV if provided
  if (referenceCSV) {
    console.log('='.repeat(80));
    console.log('5. COMPARISON WITH REFERENCE CSV');
    console.log('='.repeat(80));
    console.log('');
    
    const referenceData = readReferenceCSV(referenceCSV);
    
    if (referenceData.size === 0) {
      console.log(`⚠️  Could not read reference CSV from: ${referenceCSV}`);
      console.log('   Make sure the file exists and has the correct format.');
      console.log('   Expected format: dimension,dimension_value,orders,gross_sales,net_sales,discounts,tax,returns');
      console.log('');
    } else {
      console.log(`✅ Loaded ${referenceData.size} reference values from ${referenceCSV}\n`);
      
      // Compare by customer type
      console.log('📊 Comparison by Customer Type:');
      console.log('');
      
      const customerTypeResults = aggregateData(ordersData, 'customer');
      
      for (const result of customerTypeResults) {
        const key = `customer_type|${result.customerType}`;
        const ref = referenceData.get(key);
        
        if (ref) {
          const ordersDiff = result.orders - ref.orders;
          const grossDiff = result.gross_sales - ref.gross_sales;
          const netDiff = result.net_sales - ref.net_sales;
          const discountDiff = result.discounts - ref.discounts;
          const taxDiff = result.tax - ref.tax;
          const returnsDiff = result.returns - ref.returns;
          
          const hasAnyDiff = ordersDiff !== 0 || 
            Math.abs(grossDiff) > 0.01 || 
            Math.abs(netDiff) > 0.01 || 
            Math.abs(discountDiff) > 0.01 ||
            Math.abs(taxDiff) > 0.01 ||
            Math.abs(returnsDiff) > 0.01;
          
          console.log(`${result.customerType}:`);
          if (hasAnyDiff) {
            console.log(`  Orders:    ${result.orders} (ref: ${ref.orders}) ${ordersDiff !== 0 ? `❌ Diff: ${ordersDiff > 0 ? '+' : ''}${ordersDiff}` : '✅'}`);
            console.log(`  Gross:     ${result.gross_sales.toFixed(2)} (ref: ${ref.gross_sales.toFixed(2)}) ${Math.abs(grossDiff) > 0.01 ? `❌ Diff: ${grossDiff > 0 ? '+' : ''}${grossDiff.toFixed(2)}` : '✅'}`);
            console.log(`  Net:       ${result.net_sales.toFixed(2)} (ref: ${ref.net_sales.toFixed(2)}) ${Math.abs(netDiff) > 0.01 ? `❌ Diff: ${netDiff > 0 ? '+' : ''}${netDiff.toFixed(2)}` : '✅'}`);
            console.log(`  Discounts: ${result.discounts.toFixed(2)} (ref: ${ref.discounts.toFixed(2)}) ${Math.abs(discountDiff) > 0.01 ? `❌ Diff: ${discountDiff > 0 ? '+' : ''}${discountDiff.toFixed(2)}` : '✅'}`);
            console.log(`  Tax:       ${result.tax.toFixed(2)} (ref: ${ref.tax.toFixed(2)}) ${Math.abs(taxDiff) > 0.01 ? `❌ Diff: ${taxDiff > 0 ? '+' : ''}${taxDiff.toFixed(2)}` : '✅'}`);
            console.log(`  Returns:   ${result.returns.toFixed(2)} (ref: ${ref.returns.toFixed(2)}) ${Math.abs(returnsDiff) > 0.01 ? `❌ Diff: ${returnsDiff > 0 ? '+' : ''}${returnsDiff.toFixed(2)}` : '✅'}`);
          } else {
            console.log(`  ✅ All values match!`);
            console.log(`  Orders: ${result.orders}, Gross: ${result.gross_sales.toFixed(2)}, Net: ${result.net_sales.toFixed(2)}`);
          }
          console.log('');
        } else {
          console.log(`${result.customerType}:`);
          console.log(`  ⚠️  No reference data found for this customer type`);
          console.log(`  Orders: ${result.orders}, Gross: ${result.gross_sales.toFixed(2)}, Net: ${result.net_sales.toFixed(2)}`);
          console.log('');
        }
      }
      
      // Compare by country and customer type
      const countryCustomerResults = aggregateData(ordersData, 'country-customer');
      
      if (countryCustomerResults.length > 0) {
        console.log('🌍 Comparison by Country and Customer Type:');
        console.log('');
        
        let hasAnyCountryDiff = false;
        for (const result of countryCustomerResults) {
          const key = `country_customer_type|${result.country || 'NULL'}|${result.customerType}`;
          const ref = referenceData.get(key);
          
          if (ref) {
            const ordersDiff = result.orders - ref.orders;
            const grossDiff = result.gross_sales - ref.gross_sales;
            const netDiff = result.net_sales - ref.net_sales;
            
            const hasDiff = ordersDiff !== 0 || Math.abs(grossDiff) > 0.01 || Math.abs(netDiff) > 0.01;
            
            if (hasDiff) {
              hasAnyCountryDiff = true;
              console.log(`${result.country || 'NULL'}, ${result.customerType}:`);
              console.log(`  Orders: ${result.orders} (ref: ${ref.orders}) ${ordersDiff !== 0 ? `❌ Diff: ${ordersDiff > 0 ? '+' : ''}${ordersDiff}` : '✅'}`);
              console.log(`  Gross:  ${result.gross_sales.toFixed(2)} (ref: ${ref.gross_sales.toFixed(2)}) ${Math.abs(grossDiff) > 0.01 ? `❌ Diff: ${grossDiff > 0 ? '+' : ''}${grossDiff.toFixed(2)}` : '✅'}`);
              console.log(`  Net:    ${result.net_sales.toFixed(2)} (ref: ${ref.net_sales.toFixed(2)}) ${Math.abs(netDiff) > 0.01 ? `❌ Diff: ${netDiff > 0 ? '+' : ''}${netDiff.toFixed(2)}` : '✅'}`);
              console.log('');
            }
          }
        }
        
        if (!hasAnyCountryDiff && referenceData.size > 0) {
          console.log('  ℹ️  No country-level reference data to compare, or all values match');
          console.log('');
        }
      }
      
      // Compare by product, country, and customer type
      const productResults = aggregateData(ordersData, 'product-country-customer');
      
      if (productResults.length > 0) {
        console.log('📦 Comparison by Product, Country, and Customer Type:');
        console.log('');
        
        let hasAnyProductDiff = false;
        let productDiffs: Array<{
          productKey: string;
          country: string;
          customerType: string;
          orders: number;
          gross: number;
          net: number;
          refOrders: number;
          refGross: number;
          refNet: number;
        }> = [];
        
        for (const result of productResults) {
          const key = `product_country_customer_type|${result.productKey}|${result.country || 'NULL'}|${result.customerType}`;
          const ref = referenceData.get(key);
          
          if (ref) {
            const ordersDiff = result.orders - ref.orders;
            const grossDiff = result.gross_sales - ref.gross_sales;
            const netDiff = result.net_sales - ref.net_sales;
            
            const hasDiff = ordersDiff !== 0 || Math.abs(grossDiff) > 0.01 || Math.abs(netDiff) > 0.01;
            
            if (hasDiff) {
              hasAnyProductDiff = true;
              productDiffs.push({
                productKey: result.productKey,
                country: result.country || 'NULL',
                customerType: result.customerType,
                orders: result.orders,
                gross: result.gross_sales,
                net: result.net_sales,
                refOrders: ref.orders,
                refGross: ref.gross_sales,
                refNet: ref.net_sales,
              });
            }
          }
        }
        
        if (productDiffs.length > 0) {
          // Show top 20 differences
          for (const diff of productDiffs.slice(0, 20)) {
            const ordersDiff = diff.orders - diff.refOrders;
            const grossDiff = diff.gross - diff.refGross;
            const netDiff = diff.net - diff.refNet;
            
            console.log(`Product: ${diff.productKey}, ${diff.country}, ${diff.customerType}:`);
            console.log(`  Orders: ${diff.orders} (ref: ${diff.refOrders}) ${ordersDiff !== 0 ? `❌ Diff: ${ordersDiff > 0 ? '+' : ''}${ordersDiff}` : '✅'}`);
            console.log(`  Gross:  ${diff.gross.toFixed(2)} (ref: ${diff.refGross.toFixed(2)}) ${Math.abs(grossDiff) > 0.01 ? `❌ Diff: ${grossDiff > 0 ? '+' : ''}${grossDiff.toFixed(2)}` : '✅'}`);
            console.log(`  Net:    ${diff.net.toFixed(2)} (ref: ${diff.refNet.toFixed(2)}) ${Math.abs(netDiff) > 0.01 ? `❌ Diff: ${netDiff > 0 ? '+' : ''}${netDiff.toFixed(2)}` : '✅'}`);
            console.log('');
          }
          
          if (productDiffs.length > 20) {
            console.log(`  ... and ${productDiffs.length - 20} more product differences`);
            console.log('');
          }
        } else if (referenceData.size > 0) {
          console.log('  ℹ️  No product-level reference data to compare, or all values match');
          console.log('');
        }
      }
      
      // Compare total
      const totalResult = aggregateData(ordersData, 'total')[0];
      const totalRef = referenceData.get('total|ALL');
      
      if (totalRef) {
        console.log('📈 Total Comparison:');
        console.log('');
        const ordersDiff = totalResult.orders - totalRef.orders;
        const grossDiff = totalResult.gross_sales - totalRef.gross_sales;
        const netDiff = totalResult.net_sales - totalRef.net_sales;
        const discountDiff = totalResult.discounts - totalRef.discounts;
        const taxDiff = totalResult.tax - totalRef.tax;
        
        console.log(`  Orders: ${totalResult.orders} (ref: ${totalRef.orders}) ${ordersDiff !== 0 ? `❌ Diff: ${ordersDiff > 0 ? '+' : ''}${ordersDiff}` : '✅'}`);
        console.log(`  Gross:  ${totalResult.gross_sales.toFixed(2)} (ref: ${totalRef.gross_sales.toFixed(2)}) ${Math.abs(grossDiff) > 0.01 ? `❌ Diff: ${grossDiff > 0 ? '+' : ''}${grossDiff.toFixed(2)}` : '✅'}`);
        console.log(`  Net:    ${totalResult.net_sales.toFixed(2)} (ref: ${totalRef.net_sales.toFixed(2)}) ${Math.abs(netDiff) > 0.01 ? `❌ Diff: ${netDiff > 0 ? '+' : ''}${netDiff.toFixed(2)}` : '✅'}`);
        console.log(`  Discounts: ${totalResult.discounts.toFixed(2)} (ref: ${totalRef.discounts.toFixed(2)}) ${Math.abs(discountDiff) > 0.01 ? `❌ Diff: ${discountDiff > 0 ? '+' : ''}${discountDiff.toFixed(2)}` : '✅'}`);
        console.log(`  Tax: ${totalResult.tax.toFixed(2)} (ref: ${totalRef.tax.toFixed(2)}) ${Math.abs(taxDiff) > 0.01 ? `❌ Diff: ${taxDiff > 0 ? '+' : ''}${taxDiff.toFixed(2)}` : '✅'}`);
        console.log('');
        
        // Analysis of differences
        console.log('🔍 Analysis of Differences:');
        console.log('');
        
        if (Math.abs(grossDiff) > 0.01) {
          const grossDiffPercent = ((grossDiff / totalRef.gross_sales) * 100).toFixed(2);
          console.log(`  Gross Sales Difference: ${grossDiff > 0 ? '+' : ''}${grossDiff.toFixed(2)} (${grossDiffPercent}%)`);
          console.log(`    - Our calculation uses: originalUnitPriceSet.shopMoney.amount × quantity`);
          console.log(`    - This is the price BEFORE discounts (gross sales)`);
          console.log(`    - Reference might use: subtotalPriceSet or discountedUnitPriceSet?`);
          console.log('');
        }
        
        if (Math.abs(netDiff) > 0.01) {
          const netDiffPercent = ((netDiff / totalRef.net_sales) * 100).toFixed(2);
          console.log(`  Net Sales Difference: ${netDiff > 0 ? '+' : ''}${netDiff.toFixed(2)} (${netDiffPercent}%)`);
          console.log(`    - Our calculation: gross_sales - discounts`);
          console.log(`    - Discounts calculated: discountAllocations (excl. tax by dividing by 1.25)`);
          console.log(`    - Reference might exclude tax from net sales?`);
          console.log('');
        }
        
        if (totalRef.discounts === 0 && totalResult.discounts > 0) {
          console.log(`  ⚠️  Reference has 0 discounts, but we found ${totalResult.discounts.toFixed(2)} in discounts`);
          console.log(`    - This suggests reference might not track discounts separately`);
          console.log(`    - Or reference uses net sales that already excludes discounts`);
          console.log('');
        }
        
        if (totalRef.tax === 0 && totalResult.tax > 0) {
          console.log(`  ⚠️  Reference has 0 tax, but we found ${totalResult.tax.toFixed(2)} in tax`);
          console.log(`    - This suggests reference might use net sales EXCLUDING tax`);
          console.log(`    - Or reference uses gross sales EXCLUDING tax`);
          console.log('');
        }
        
        // Check if reference net + discounts + tax = our gross
        const referenceTotal = totalRef.net_sales + totalRef.discounts + totalRef.tax;
        const ourGross = totalResult.gross_sales;
        const diff = Math.abs(referenceTotal - ourGross);
        
        if (diff < 1.0) {
          console.log(`  ✅ Reference net + discounts + tax (${referenceTotal.toFixed(2)}) ≈ Our gross (${ourGross.toFixed(2)})`);
          console.log(`    - This suggests reference uses net sales EXCLUDING tax`);
          console.log(`    - And our gross sales INCLUDES tax in the original price`);
          console.log('');
        }
        
        // Check if reference gross - our discounts - our tax = reference net
        const ourNetFromGross = totalResult.gross_sales - totalResult.discounts - totalResult.tax;
        const netDiff2 = Math.abs(ourNetFromGross - totalRef.net_sales);
        
        if (netDiff2 < 1.0) {
          console.log(`  ✅ Our gross - our discounts - our tax (${ourNetFromGross.toFixed(2)}) ≈ Reference net (${totalRef.net_sales.toFixed(2)})`);
          console.log(`    - This confirms reference net sales = gross - discounts - tax`);
          console.log(`    - But our gross is higher, suggesting different gross calculation`);
          console.log('');
        }
      }
    }
  }

  // Step 6a: Export detailed order-level data to CSV for manual review
  if (args.find((arg) => arg.startsWith('--export-detailed-csv='))) {
    const exportPath = args.find((arg) => arg.startsWith('--export-detailed-csv='))?.split('=')[1] || `scripts/data/detailed_${dateArg.replace(/-/g, '_')}.csv`;
    const fs = require('fs');
    const path = require('path');
    
    const fullPath = path.resolve(process.cwd(), exportPath);
    
    console.log('='.repeat(80));
    console.log('6a. EXPORTING DETAILED ORDER DATA TO CSV');
    console.log('='.repeat(80));
    console.log('');
    
    // CSV header
    let csvContent = 'order_id,order_name,event_date,customer_type,customer_id,customer_number_of_orders,country,currency,';
    csvContent += 'product_key,product_name,quantity,';
    csvContent += 'line_gross_sales,line_discounts,line_tax,line_net_sales,';
    csvContent += 'order_total_gross,order_total_discounts,order_total_tax,order_total_net,';
    csvContent += 'refund_product_key,refund_quantity,refund_amount\n';
    
    // Sort orders by order name for easier review
    const sortedOrdersData = [...ordersData].sort((a, b) => a.orderName.localeCompare(b.orderName));
    
    for (const orderData of sortedOrdersData) {
      const originalOrder = orders.find((o) => o.id === orderData.orderId)!;
      
      // For each line item, create a row
      for (let lineIndex = 0; lineIndex < orderData.lineItems.length; lineIndex++) {
        const lineItem = orderData.lineItems[lineIndex];
        const isFirstLineItem = lineIndex === 0;
        
        csvContent += `"${orderData.orderId}","${orderData.orderName}","${orderData.eventDate}",`;
        csvContent += `${orderData.customerType},"${originalOrder.customer?.id || ''}","${originalOrder.customer?.numberOfOrders || ''}",`;
        csvContent += `${orderData.country || ''},${orderData.currency},`;
        csvContent += `${lineItem.productKey},"${lineItem.productName.replace(/"/g, '""')}",${lineItem.quantity},`;
        csvContent += `${lineItem.gross_sales.toFixed(2)},${lineItem.discounts.toFixed(2)},${lineItem.tax.toFixed(2)},${lineItem.net_sales.toFixed(2)},`;
        
        // Order totals (only on first line item to avoid duplication)
        if (isFirstLineItem) {
          csvContent += `${orderData.totalGrossSales.toFixed(2)},${orderData.totalDiscounts.toFixed(2)},${orderData.totalTax.toFixed(2)},${orderData.totalNetSales.toFixed(2)},`;
        } else {
          csvContent += `,,,`;
        }
        
        // Refunds (check if this line item has refunds)
        const lineItemRefunds = orderData.refunds.filter(r => r.productKey === lineItem.productKey);
        if (lineItemRefunds.length > 0) {
          const refund = lineItemRefunds[0];
          csvContent += `${refund.productKey},${refund.quantity},${refund.refundAmount.toFixed(2)}`;
        } else {
          csvContent += `,,`;
        }
        
        csvContent += '\n';
      }
      
      // If order has refunds without corresponding line items, add them as separate rows
      for (const refund of orderData.refunds) {
        const hasLineItem = orderData.lineItems.some(li => li.productKey === refund.productKey);
        if (!hasLineItem) {
          csvContent += `"${orderData.orderId}","${orderData.orderName}","${orderData.eventDate}",`;
          csvContent += `${orderData.customerType},"${originalOrder.customer?.id || ''}","${originalOrder.customer?.numberOfOrders || ''}",`;
          csvContent += `${orderData.country || ''},${orderData.currency},`;
          csvContent += `,,,`; // product_key, product_name, quantity
          csvContent += `,,,`; // line_gross_sales, line_discounts, line_tax, line_net_sales
          csvContent += `,,,`; // order totals (already shown on first line)
          csvContent += `${refund.productKey},"${refund.productName.replace(/"/g, '""')}",${refund.quantity},${refund.refundAmount.toFixed(2)}\n`;
        }
      }
    }
    
    fs.writeFileSync(fullPath, csvContent, 'utf-8');
    console.log(`✅ Exported detailed order data to: ${fullPath}`);
    console.log(`   - ${sortedOrdersData.length} orders`);
    console.log(`   - ${sortedOrdersData.reduce((sum, o) => sum + o.lineItems.length, 0)} line items`);
    console.log(`   - ${sortedOrdersData.reduce((sum, o) => sum + o.refunds.length, 0)} refunds`);
    console.log('');
  }

  // Step 6b: Export aggregated data to CSV format
  if (args.find((arg) => arg.startsWith('--export-csv='))) {
    const exportPath = args.find((arg) => arg.startsWith('--export-csv='))?.split('=')[1] || `scripts/data/export_${dateArg.replace(/-/g, '_')}.csv`;
    const fs = require('fs');
    const path = require('path');
    
    const fullPath = path.resolve(process.cwd(), exportPath);
    
    console.log('='.repeat(80));
    console.log('6. EXPORTING DATA TO CSV');
    console.log('='.repeat(80));
    console.log('');
    
    const productResults = aggregateData(ordersData, 'product-country-customer');
    const customerResults = aggregateData(ordersData, 'customer');
    const totalResult = aggregateData(ordersData, 'total')[0];
    
    let csvContent = '# Reference CSV for ' + dateArg + '\n';
    csvContent += '# Format: dimension,dimension_value,orders,gross_sales,net_sales,discounts,tax,returns\n';
    csvContent += '#\n';
    csvContent += '# Dimension types:\n';
    csvContent += '#   - customer_type: NEW, RETURNING, GUEST\n';
    csvContent += '#   - country_customer_type: COUNTRY|CUSTOMER_TYPE (e.g., SE|NEW)\n';
    csvContent += '#   - product_country_customer_type: PRODUCT_KEY|COUNTRY|CUSTOMER_TYPE\n';
    csvContent += '#   - total: ALL\n';
    csvContent += '\n';
    
    // Customer type totals
    csvContent += '# Customer Type Totals\n';
    for (const result of customerResults) {
      csvContent += `customer_type,${result.customerType},${result.orders},${result.gross_sales.toFixed(2)},${result.net_sales.toFixed(2)},${result.discounts.toFixed(2)},${result.tax.toFixed(2)},${result.returns.toFixed(2)}\n`;
    }
    csvContent += '\n';
    
    // Country + Customer Type
    const countryCustomerResults = aggregateData(ordersData, 'country-customer');
    if (countryCustomerResults.length > 0) {
      csvContent += '# Country + Customer Type\n';
      for (const result of countryCustomerResults) {
        csvContent += `country_customer_type,${result.country || 'NULL'}|${result.customerType},${result.orders},${result.gross_sales.toFixed(2)},${result.net_sales.toFixed(2)},${result.discounts.toFixed(2)},${result.tax.toFixed(2)},${result.returns.toFixed(2)}\n`;
      }
      csvContent += '\n';
    }
    
    // Product + Country + Customer Type
    if (productResults.length > 0) {
      csvContent += '# Product + Country + Customer Type\n';
      for (const result of productResults) {
        csvContent += `product_country_customer_type,${result.productKey}|${result.country || 'NULL'}|${result.customerType},${result.orders},${result.gross_sales.toFixed(2)},${result.net_sales.toFixed(2)},${result.discounts.toFixed(2)},${result.tax.toFixed(2)},${result.returns.toFixed(2)}\n`;
      }
      csvContent += '\n';
    }
    
    // Total
    csvContent += '# Total\n';
    csvContent += `total,ALL,${totalResult.orders},${totalResult.gross_sales.toFixed(2)},${totalResult.net_sales.toFixed(2)},${totalResult.discounts.toFixed(2)},${totalResult.tax.toFixed(2)},${totalResult.returns.toFixed(2)}\n`;
    
    fs.writeFileSync(fullPath, csvContent, 'utf-8');
    console.log(`✅ Exported data to: ${fullPath}`);
    console.log(`   - ${customerResults.length} customer type totals`);
    console.log(`   - ${countryCustomerResults.length} country + customer type combinations`);
    console.log(`   - ${productResults.length} product + country + customer type combinations`);
    console.log(`   - 1 total`);
    console.log('');
  }

  // Step 7: Document insights
  console.log('='.repeat(80));
  console.log('4. KEY INSIGHTS');
  console.log('='.repeat(80));
  console.log('');
  console.log('1. Date Grouping:');
  console.log('   - Use transaction.processedAt (not order.createdAt) for financial reporting');
  console.log('   - Convert to local timezone for accurate date grouping');
  console.log('   - Fetch orders in wider range (-1 to +1 day) to catch all events');
  console.log('');
  console.log('2. Discounts:');
  console.log('   - Shopify includes tax in discount amounts');
  console.log('   - Divide by 1.25 to exclude 25% VAT');
  console.log('   - Discounts can be line-level or order-level');
  console.log('   - Order-level discounts should be distributed proportionally');
  console.log('');
  console.log('3. Customer Type:');
  console.log('   - numberOfOrders is returned as STRING, not number');
  console.log('   - numberOfOrders === "1" = NEW customer');
  console.log('   - numberOfOrders > "1" = RETURNING customer');
  console.log('   - null/missing = GUEST checkout');
  console.log('');
  console.log('4. Returns:');
  console.log('   - Use original line item price (not discounted price)');
  console.log('   - Returns reduce net sales');
  console.log('   - Dated by refund.createdAt');
  console.log('');
  console.log('5. Tax:');
  console.log('   - Already calculated by Shopify');
  console.log('   - Stored in taxLines per line item');
  console.log('   - Included in order totals');
  console.log('');

  console.log('='.repeat(80));
  console.log('✅ Research complete!');
  console.log('='.repeat(80));
}

// Run the script
main().catch((error) => {
  console.error('❌ Fatal error:', error);
  if (error instanceof Error) {
    console.error('Stack:', error.stack);
  }
  process.exit(1);
});

