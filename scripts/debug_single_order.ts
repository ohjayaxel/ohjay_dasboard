/**
 * Debug Script: Single Order Analysis
 * 
 * Hämtar en specifik order och visar alla tillgängliga metrics för att
 * identifiera var skillnader i beräkningar kommer ifrån.
 */

import { createClient } from '@supabase/supabase-js';
import { fetchShopifyOrderGraphQL, GraphQLOrder } from '../lib/integrations/shopify-graphql';

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
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);

function parseMoneyAmount(amount: string): number {
  return parseFloat(amount) || 0;
}

function roundTo2Decimals(value: number): number {
  return Math.round(value * 100) / 100;
}

async function main() {
  const args = process.argv.slice(2);
  const orderIdArg = args.find((arg) => arg.startsWith('--order-id='))?.split('=')[1];
  const orderNumberArg = args.find((arg) => arg.startsWith('--order-number='))?.split('=')[1];
  const tenantSlug = args.find((arg) => arg.startsWith('--tenant='))?.split('=')[1] || 'skinome';
  
  if (!orderIdArg && !orderNumberArg) {
    console.error('Usage: pnpm tsx scripts/debug_single_order.ts --order-id=7064943231319 --tenant=skinome');
    console.error('   or: pnpm tsx scripts/debug_single_order.ts --order-number=#140000 --tenant=skinome');
    process.exit(1);
  }
  
  console.log('='.repeat(80));
  console.log('Single Order Debug Analysis');
  console.log('='.repeat(80));
  console.log(`Tenant: ${tenantSlug}`);
  if (orderIdArg) {
    console.log(`Order ID: ${orderIdArg}`);
  }
  if (orderNumberArg) {
    console.log(`Order Number: ${orderNumberArg}`);
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
  
  // Fetch the order
  let order: GraphQLOrder | null = null;
  
  if (orderIdArg) {
    // Try to fetch by legacy resource ID (numeric ID)
    const legacyId = orderIdArg.replace(/^gid:\/\/shopify\/Order\//, '');
    console.log(`Fetching order by ID: ${legacyId}...`);
    
    // Try GraphQL query with ID
    order = await fetchShopifyOrderGraphQL({
      tenantId: tenant.id,
      shopDomain,
      orderId: `gid://shopify/Order/${legacyId}`,
    });
    
    // If that doesn't work, try numeric ID directly
    if (!order) {
      order = await fetchShopifyOrderGraphQL({
        tenantId: tenant.id,
        shopDomain,
        orderId: legacyId,
      });
    }
  }
  
  if (!order) {
    console.error('❌ Could not fetch order. Trying alternative methods...');
    // Could also try fetching by order number via REST API or wider GraphQL query
    process.exit(1);
  }
  
  console.log(`✅ Fetched order: ${order.name}`);
  console.log('');
  
  // ============================================================================
  // ORDER-LEVEL METRICS
  // ============================================================================
  
  console.log('='.repeat(80));
  console.log('ORDER-LEVEL METRICS');
  console.log('='.repeat(80));
  console.log('');
  
  console.log(`Order ID: ${order.id}`);
  console.log(`Order Name: ${order.name}`);
  console.log(`Legacy Resource ID: ${order.legacyResourceId}`);
  console.log(`Created At: ${order.createdAt}`);
  console.log(`Processed At: ${order.processedAt || 'N/A'}`);
  console.log(`Updated At: ${order.updatedAt}`);
  console.log(`Cancelled At: ${order.cancelledAt || 'N/A'}`);
  console.log(`Test Order: ${order.test}`);
  console.log(`Currency: ${order.currencyCode}`);
  console.log('');
  
  // Total prices
  const totalPrice = order.totalPriceSet
    ? parseMoneyAmount(order.totalPriceSet.shopMoney.amount)
    : 0;
  const subtotalPrice = order.subtotalPriceSet
    ? parseMoneyAmount(order.subtotalPriceSet.shopMoney.amount)
    : 0;
  const totalDiscountsSet = order.totalDiscountsSet
    ? parseMoneyAmount(order.totalDiscountsSet.shopMoney.amount)
    : 0;
  
  console.log('Order Totals (from Shopify):');
  console.log(`  totalPriceSet.shopMoney.amount: ${totalPrice.toFixed(2)} ${order.currencyCode}`);
  console.log(`  subtotalPriceSet.shopMoney.amount: ${subtotalPrice.toFixed(2)} ${order.currencyCode}`);
  console.log(`  totalDiscountsSet.shopMoney.amount: ${totalDiscountsSet.toFixed(2)} ${order.currencyCode}`);
  console.log('');
  
  // Transactions
  console.log('Transactions:');
  if (order.transactions && order.transactions.length > 0) {
    for (const txn of order.transactions) {
      const txnAmount = parseMoneyAmount(txn.amountSet.shopMoney.amount);
      console.log(`  - ${txn.kind} / ${txn.status}`);
      console.log(`    Amount: ${txnAmount.toFixed(2)} ${txn.amountSet.shopMoney.currencyCode}`);
      console.log(`    Processed At: ${txn.processedAt || 'N/A'}`);
      console.log(`    Gateway: ${txn.gateway || 'N/A'}`);
      console.log(`    Payment Method: ${txn.paymentMethod || 'N/A'}`);
      console.log('');
    }
  } else {
    console.log('  No transactions');
    console.log('');
  }
  
  // ============================================================================
  // LINE ITEMS - DETAILED BREAKDOWN
  // ============================================================================
  
  console.log('='.repeat(80));
  console.log('LINE ITEMS - DETAILED BREAKDOWN');
  console.log('='.repeat(80));
  console.log('');
  
  let totalLineGrossInclTax = 0;
  let totalLineTax = 0;
  let totalLineDiscountsInclTax = 0;
  let totalLineDiscountsExclTax = 0;
  
  for (let i = 0; i < order.lineItems.edges.length; i++) {
    const edge = order.lineItems.edges[i];
    const lineItem = edge.node;
    
    console.log(`Line Item ${i + 1}:`);
    console.log(`  ID: ${lineItem.id}`);
    console.log(`  Name: ${lineItem.name}`);
    console.log(`  SKU: ${lineItem.sku || 'N/A'}`);
    console.log(`  Quantity: ${lineItem.quantity}`);
    console.log('');
    
    // Original unit price
    const originalUnitPrice = parseMoneyAmount(lineItem.originalUnitPriceSet.shopMoney.amount);
    const lineGrossInclTax = originalUnitPrice * lineItem.quantity;
    totalLineGrossInclTax += lineGrossInclTax;
    
    console.log(`  originalUnitPriceSet.shopMoney.amount: ${originalUnitPrice.toFixed(2)} ${lineItem.originalUnitPriceSet.shopMoney.currencyCode}`);
    console.log(`  Line Gross (price × quantity, INCL tax): ${lineGrossInclTax.toFixed(2)} ${order.currencyCode}`);
    console.log('');
    
    // Discounted unit price
    if (lineItem.discountedUnitPriceSet) {
      const discountedUnitPrice = parseMoneyAmount(lineItem.discountedUnitPriceSet.shopMoney.amount);
      const lineNetAfterDiscounts = discountedUnitPrice * lineItem.quantity;
      console.log(`  discountedUnitPriceSet.shopMoney.amount: ${discountedUnitPrice.toFixed(2)} ${lineItem.discountedUnitPriceSet.shopMoney.currencyCode}`);
      console.log(`  Line Net After Discounts (discounted price × quantity): ${lineNetAfterDiscounts.toFixed(2)} ${order.currencyCode}`);
      console.log('');
    }
    
    // Discount allocations
    console.log(`  Discount Allocations (${lineItem.discountAllocations.length}):`);
    let lineDiscountsInclTax = 0;
    for (const allocation of lineItem.discountAllocations) {
      const discountAmount = parseMoneyAmount(allocation.allocatedAmountSet.shopMoney.amount);
      lineDiscountsInclTax += discountAmount;
      console.log(`    - ${discountAmount.toFixed(2)} ${allocation.allocatedAmountSet.shopMoney.currencyCode} (INCL tax)`);
    }
    totalLineDiscountsInclTax += lineDiscountsInclTax;
    
    // Calculate discount excl tax (assuming we can infer tax rate from tax lines)
    if (lineDiscountsInclTax > 0 && lineItem.taxLines && lineItem.taxLines.length > 0) {
      // Calculate actual tax rate from this line item
      let lineTax = 0;
      for (const taxLine of lineItem.taxLines) {
        lineTax += parseMoneyAmount(taxLine.priceSet.shopMoney.amount);
      }
      
      // Gross excl tax = gross incl tax - tax
      const lineGrossExclTax = lineGrossInclTax - lineTax;
      
      // Calculate tax rate
      const taxRate = lineGrossExclTax > 0 ? lineTax / lineGrossExclTax : 0;
      const discountExclTax = lineDiscountsInclTax / (1 + taxRate);
      
      console.log(`    Total Line Discounts (INCL tax): ${lineDiscountsInclTax.toFixed(2)} ${order.currencyCode}`);
      console.log(`    Tax Rate: ${(taxRate * 100).toFixed(2)}%`);
      console.log(`    Total Line Discounts (EXCL tax): ${discountExclTax.toFixed(2)} ${order.currencyCode}`);
      totalLineDiscountsExclTax += discountExclTax;
    } else {
      // Fallback: assume 25% VAT
      const discountExclTax = lineDiscountsInclTax / 1.25;
      console.log(`    Total Line Discounts (INCL tax): ${lineDiscountsInclTax.toFixed(2)} ${order.currencyCode}`);
      console.log(`    Total Line Discounts (EXCL tax, assuming 25% VAT): ${discountExclTax.toFixed(2)} ${order.currencyCode}`);
      totalLineDiscountsExclTax += discountExclTax;
    }
    console.log('');
    
    // Tax lines
    console.log(`  Tax Lines (${lineItem.taxLines?.length || 0}):`);
    let lineTax = 0;
    if (lineItem.taxLines && lineItem.taxLines.length > 0) {
      for (const taxLine of lineItem.taxLines) {
        const taxAmount = parseMoneyAmount(taxLine.priceSet.shopMoney.amount);
        lineTax += taxAmount;
        console.log(`    - ${taxAmount.toFixed(2)} ${taxLine.priceSet.shopMoney.currencyCode}`);
      }
      totalLineTax += lineTax;
      console.log(`    Total Line Tax: ${lineTax.toFixed(2)} ${order.currencyCode}`);
    } else {
      console.log(`    No tax lines`);
    }
    console.log('');
    
    // Calculate net sales for this line
    const lineGrossExclTax = lineGrossInclTax - lineTax;
    const lineDiscountsExclTax = lineDiscountsInclTax / (1 + (lineTax / (lineGrossExclTax || 1)));
    const lineNetSales = lineGrossExclTax - lineDiscountsExclTax;
    
    console.log(`  CALCULATED METRICS FOR THIS LINE:`);
    console.log(`    Gross Sales (INCL tax): ${lineGrossInclTax.toFixed(2)} ${order.currencyCode}`);
    console.log(`    Tax: ${lineTax.toFixed(2)} ${order.currencyCode}`);
    console.log(`    Gross Sales (EXCL tax): ${lineGrossExclTax.toFixed(2)} ${order.currencyCode}`);
    console.log(`    Discounts (INCL tax): ${lineDiscountsInclTax.toFixed(2)} ${order.currencyCode}`);
    console.log(`    Discounts (EXCL tax): ${lineDiscountsExclTax.toFixed(2)} ${order.currencyCode}`);
    console.log(`    Net Sales (EXCL tax): ${lineNetSales.toFixed(2)} ${order.currencyCode}`);
    console.log('');
    console.log('─'.repeat(80));
    console.log('');
  }
  
  // ============================================================================
  // TOTALS SUMMARY
  // ============================================================================
  
  console.log('='.repeat(80));
  console.log('TOTALS SUMMARY');
  console.log('='.repeat(80));
  console.log('');
  
  console.log('FROM LINE ITEMS:');
  console.log(`  Total Gross Sales (INCL tax): ${totalLineGrossInclTax.toFixed(2)} ${order.currencyCode}`);
  console.log(`  Total Tax: ${totalLineTax.toFixed(2)} ${order.currencyCode}`);
  console.log(`  Total Gross Sales (EXCL tax): ${(totalLineGrossInclTax - totalLineTax).toFixed(2)} ${order.currencyCode}`);
  console.log(`  Total Discounts (INCL tax): ${totalLineDiscountsInclTax.toFixed(2)} ${order.currencyCode}`);
  console.log(`  Total Discounts (EXCL tax): ${totalLineDiscountsExclTax.toFixed(2)} ${order.currencyCode}`);
  console.log(`  Total Net Sales (EXCL tax): ${(totalLineGrossInclTax - totalLineTax - totalLineDiscountsExclTax).toFixed(2)} ${order.currencyCode}`);
  console.log('');
  
  console.log('FROM ORDER TOTALS:');
  console.log(`  totalPriceSet: ${totalPrice.toFixed(2)} ${order.currencyCode}`);
  console.log(`  subtotalPriceSet: ${subtotalPrice.toFixed(2)} ${order.currencyCode}`);
  console.log(`  totalDiscountsSet: ${totalDiscountsSet.toFixed(2)} ${order.currencyCode}`);
  console.log('');
  
  // Calculate order-level discount
  const orderLevelDiscount = totalDiscountsSet - totalLineDiscountsInclTax;
  console.log('ORDER-LEVEL DISCOUNTS:');
  console.log(`  Total Discounts (from order): ${totalDiscountsSet.toFixed(2)} ${order.currencyCode} (INCL tax)`);
  console.log(`  Line-Level Discounts (sum): ${totalLineDiscountsInclTax.toFixed(2)} ${order.currencyCode} (INCL tax)`);
  console.log(`  Order-Level Discount: ${orderLevelDiscount.toFixed(2)} ${order.currencyCode} (INCL tax)`);
  console.log(`  Order-Level Discount (EXCL tax, assuming 25%): ${(orderLevelDiscount / 1.25).toFixed(2)} ${order.currencyCode}`);
  console.log('');
  
  // Verify calculations
  console.log('VERIFICATION - Different Calculation Methods:');
  console.log('');
  
  // Method 1: Current method (Gross EXCL tax - Discounts EXCL tax)
  const method1_NetSalesExclTax = totalLineGrossInclTax - totalLineTax - totalLineDiscountsExclTax;
  console.log('Method 1 (Current): Gross EXCL tax - Discounts EXCL tax');
  console.log(`  Gross Sales (EXCL tax): ${(totalLineGrossInclTax - totalLineTax).toFixed(2)} ${order.currencyCode}`);
  console.log(`  Discounts (EXCL tax): ${totalLineDiscountsExclTax.toFixed(2)} ${order.currencyCode}`);
  console.log(`  Net Sales (EXCL tax): ${method1_NetSalesExclTax.toFixed(2)} ${order.currencyCode}`);
  console.log('');
  
  // Method 2: Shopify's way (Subtotal INCL tax - Tax)
  // subtotalPriceSet = Gross Sales (INCL tax) - Discounts (INCL tax)
  // Net Sales (EXCL tax) = subtotalPriceSet - Tax
  const method2_NetSalesExclTax = subtotalPrice - totalLineTax;
  console.log('Method 2 (Shopify Analytics): Subtotal INCL tax - Tax');
  console.log(`  subtotalPriceSet (INCL tax, after discounts): ${subtotalPrice.toFixed(2)} ${order.currencyCode}`);
  console.log(`  Tax: ${totalLineTax.toFixed(2)} ${order.currencyCode}`);
  console.log(`  Net Sales (EXCL tax): ${method2_NetSalesExclTax.toFixed(2)} ${order.currencyCode}`);
  console.log('');
  
  // Method 3: Verify subtotalPriceSet calculation
  const calculatedSubtotal = totalLineGrossInclTax - totalLineDiscountsInclTax;
  console.log('Method 3: Verify subtotalPriceSet calculation');
  console.log(`  Gross Sales (INCL tax): ${totalLineGrossInclTax.toFixed(2)} ${order.currencyCode}`);
  console.log(`  Discounts (INCL tax): ${totalLineDiscountsInclTax.toFixed(2)} ${order.currencyCode}`);
  console.log(`  Calculated Subtotal: ${calculatedSubtotal.toFixed(2)} ${order.currencyCode}`);
  console.log(`  Shopify subtotalPriceSet: ${subtotalPrice.toFixed(2)} ${order.currencyCode}`);
  const subtotalDiff = Math.abs(calculatedSubtotal - subtotalPrice);
  if (subtotalDiff < 0.01) {
    console.log(`  ✅ Subtotal calculation matches!`);
  } else {
    console.log(`  ⚠️  Subtotal difference: ${subtotalDiff.toFixed(2)} ${order.currencyCode}`);
  }
  console.log('');
  
  // Compare methods
  const diffBetweenMethods = Math.abs(method1_NetSalesExclTax - method2_NetSalesExclTax);
  console.log('COMPARISON:');
  console.log(`  Method 1 (Current): ${method1_NetSalesExclTax.toFixed(2)} ${order.currencyCode}`);
  console.log(`  Method 2 (Shopify): ${method2_NetSalesExclTax.toFixed(2)} ${order.currencyCode}`);
  console.log(`  Difference: ${diffBetweenMethods.toFixed(2)} ${order.currencyCode}`);
  console.log('');
  
  if (diffBetweenMethods > 0.01) {
    console.log('🔍 ANALYSIS:');
    console.log(`  The difference comes from how we calculate discounts EXCL tax.`);
    console.log(`  We divide discounts by (1 + tax_rate), but this might not be accurate if`);
    console.log(`  discounts are calculated differently or if tax rates vary within the order.`);
    console.log('');
    console.log(`  CORRECT CALCULATION FOR SHOPIFY ANALYTICS:`);
    console.log(`    Net Sales (EXCL tax) = subtotalPriceSet - totalTax`);
    console.log(`    = ${subtotalPrice.toFixed(2)} - ${totalLineTax.toFixed(2)}`);
    console.log(`    = ${method2_NetSalesExclTax.toFixed(2)} ${order.currencyCode}`);
    console.log('');
  }
  
  // ============================================================================
  // REFUNDS
  // ============================================================================
  
  if (order.refunds && order.refunds.length > 0) {
    console.log('='.repeat(80));
    console.log('REFUNDS');
    console.log('='.repeat(80));
    console.log('');
    
    for (let i = 0; i < order.refunds.length; i++) {
      const refund = order.refunds[i];
      console.log(`Refund ${i + 1}:`);
      console.log(`  ID: ${refund.id}`);
      console.log(`  Created At: ${refund.createdAt}`);
      console.log(`  Refund Line Items: ${refund.refundLineItems.edges.length}`);
      
      for (const refundEdge of refund.refundLineItems.edges) {
        const refundLineItem = refundEdge.node;
        const originalPrice = parseMoneyAmount(refundLineItem.lineItem.originalUnitPriceSet.shopMoney.amount);
        const refundAmount = originalPrice * refundLineItem.quantity;
        console.log(`    - ${refundLineItem.lineItem.name} (SKU: ${refundLineItem.lineItem.sku || 'N/A'})`);
        console.log(`      Quantity: ${refundLineItem.quantity}`);
        console.log(`      Original Price: ${originalPrice.toFixed(2)} ${order.currencyCode}`);
        console.log(`      Refund Amount: ${refundAmount.toFixed(2)} ${order.currencyCode}`);
      }
      console.log('');
    }
  }
  
  // ============================================================================
  // RAW JSON (for detailed inspection)
  // ============================================================================
  
  console.log('='.repeat(80));
  console.log('RAW ORDER JSON (first 5000 chars)');
  console.log('='.repeat(80));
  console.log('');
  console.log(JSON.stringify(order, null, 2).substring(0, 5000));
  if (JSON.stringify(order, null, 2).length > 5000) {
    console.log(`\n... (truncated, total length: ${JSON.stringify(order, null, 2).length} chars)`);
  }
  console.log('');
}

main().catch(console.error);

