/**
 * Shopify GraphQL API Client
 * 
 * Provides functions to fetch orders using Shopify's Admin GraphQL API,
 * with support for originalUnitPriceSet.shopMoney.amount as required for
 * 100% matching with Shopify Sales/Finance reports.
 */

import { normalizeShopDomain, getShopifyAccessToken } from './shopify';

const SHOPIFY_API_VERSION = '2023-10';

export type GraphQLCustomer = {
  id: string;
  email?: string | null;
  numberOfOrders?: string; // Total number of orders this customer has placed (including this one) - returned as string from Shopify API
  createdAt?: string | null; // Customer creation date
};

export type GraphQLAddress = {
  countryCode?: string | null;
  country?: string | null;
};

export type GraphQLOrder = {
  id: string;
  name: string;
  legacyResourceId: string; // Order ID as string (e.g., "1234567890")
  createdAt: string;
  processedAt?: string | null;
  updatedAt?: string | null;
  cancelledAt?: string | null;
  test: boolean;
  currencyCode: string;
  customer?: GraphQLCustomer | null;
  billingAddress?: GraphQLAddress | null;
  shippingAddress?: GraphQLAddress | null;
  totalPriceSet?: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  subtotalPriceSet?: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  totalDiscountsSet?: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  totalTaxSet?: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  transactions?: Array<{
    id: string;
    kind: string;
    status: string;
    processedAt: string | null;
    gateway: string | null;
    amountSet: {
      shopMoney: {
        amount: string;
        currencyCode: string;
      };
    };
    paymentMethod: string | null;
  }>;
  lineItems: {
    edges: Array<{
      node: {
        id: string;
        sku: string | null;
        name: string;
        quantity: number;
        originalUnitPriceSet: {
          shopMoney: {
            amount: string;
            currencyCode: string;
          };
        };
        discountedUnitPriceSet?: {
          shopMoney: {
            amount: string;
            currencyCode: string;
          };
        };
        discountAllocations: Array<{
          allocatedAmountSet: {
            shopMoney: {
              amount: string;
              currencyCode: string;
            };
          };
        }>;
        taxLines?: Array<{
          priceSet: {
            shopMoney: {
              amount: string;
              currencyCode: string;
            };
          };
        }>;
      };
    }>;
  };
  refunds: Array<{
    id: string;
    createdAt: string;
    refundLineItems: {
      edges: Array<{
        node: {
          quantity: number;
          subtotalSet?: {
            shopMoney: {
              amount: string;
              currencyCode: string;
            };
          };
          lineItem: {
            id: string;
            sku: string | null;
            name: string;
            originalUnitPriceSet: {
              shopMoney: {
                amount: string;
                currencyCode: string;
              };
            };
          };
        };
      }>;
    };
  }>;
};

export type GraphQLOrdersResponse = {
  data: {
    orders: {
      edges: Array<{
        cursor: string;
        node: GraphQLOrder;
      }>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number | null;
      throttleStatus?: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
};

const ORDERS_QUERY = `
  query OrdersForPeriod($cursor: String, $query: String) {
    orders(first: 100, after: $cursor, query: $query) {
      edges {
        cursor
        node {
          id
          name
          legacyResourceId
          createdAt
          processedAt
          updatedAt
          cancelledAt
          test
          currencyCode
          customer {
            id
            email
            numberOfOrders
            createdAt
          }
          billingAddress {
            countryCode
            country
          }
          shippingAddress {
            countryCode
            country
          }
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          subtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalDiscountsSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalTaxSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          transactions(first: 50) {
            id
            kind
            status
            processedAt
            gateway
            amountSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            paymentMethod
          }
          lineItems(first: 250) {
            edges {
              node {
                id
                sku
                name
                quantity
                originalUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                discountedUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                discountAllocations {
                  allocatedAmountSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                }
                taxLines {
                  priceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
          refunds(first: 50) {
            id
            createdAt
            refundLineItems(first: 250) {
              edges {
                node {
                  quantity
                  subtotalSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  lineItem {
                    id
                    sku
                    name
                    originalUnitPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * Fetches orders from Shopify using GraphQL API with pagination support
 */
export async function fetchShopifyOrdersGraphQL(params: {
  tenantId: string;
  shopDomain: string;
  since?: string;
  until?: string;
  excludeTest?: boolean;
  accessToken?: string; // Optional: pass directly to avoid getShopifyAccessToken call
}): Promise<GraphQLOrder[]> {
  const accessToken = params.accessToken || await getShopifyAccessToken(params.tenantId);
  if (!accessToken) {
    throw new Error('No access token found for this tenant');
  }

  const normalizedShop = normalizeShopDomain(params.shopDomain);
  const allOrders: GraphQLOrder[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  // Build query string for date filtering
  const queryParts: string[] = [];
  if (params.since) {
    queryParts.push(`created_at:>='${params.since}'`);
  }
  if (params.until) {
    queryParts.push(`created_at:<='${params.until}T23:59:59'`);
  }
  if (params.excludeTest !== false) {
    queryParts.push(`-test:true`);
  }
  const queryString = queryParts.length > 0 ? queryParts.join(' AND ') : undefined;

  console.log(`[shopify-graphql] Fetching orders from ${normalizedShop}...`);

  while (hasNextPage) {
    const variables: Record<string, unknown> = {};
    if (cursor) {
      variables.cursor = cursor;
    }
    if (queryString) {
      variables.query = queryString;
    }

    const url = `https://${normalizedShop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        query: ORDERS_QUERY,
        variables,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Shopify GraphQL API error: ${response.status} ${body}`);
    }

    const result = (await response.json()) as GraphQLOrdersResponse | { errors?: Array<{ message: string }> };

    if ('errors' in result && result.errors) {
      throw new Error(`Shopify GraphQL errors: ${result.errors.map((e) => e.message).join(', ')}`);
    }

    if (!('data' in result)) {
      throw new Error('Invalid GraphQL response structure');
    }

    const data = result.data;
    
    // DEBUG: Log raw response for first order to verify customer data exists
    if (data.orders.edges.length > 0 && allOrders.length === 0) {
      const firstRawOrder = data.orders.edges[0].node;
      console.log(`[shopify-graphql] DEBUG: First order RAW response - customer exists: ${firstRawOrder.customer ? 'YES' : 'NO'}`);
      if (firstRawOrder.customer) {
        console.log(`[shopify-graphql] DEBUG: First order customer data:`, JSON.stringify({
          id: firstRawOrder.customer.id,
          email: firstRawOrder.customer.email,
          numberOfOrders: firstRawOrder.customer.numberOfOrders,
        }));
      } else {
        console.log(`[shopify-graphql] DEBUG: First order has no customer (guest checkout)`);
      }
    }
    
    const orders = data.orders.edges.map((edge) => edge.node);

    // Filter out test orders if excludeTest is true
    const filteredOrders = params.excludeTest !== false 
      ? orders.filter((order) => !order.test)
      : orders;

    allOrders.push(...filteredOrders);

    // Check rate limiting
    if (result.extensions?.cost?.throttleStatus) {
      const throttleStatus = result.extensions.cost.throttleStatus;
      if (throttleStatus.currentlyAvailable < 100) {
        // Wait if we're close to rate limit
        const restoreRate = throttleStatus.restoreRate;
        const waitTime = Math.ceil((1000 - throttleStatus.currentlyAvailable) / restoreRate) * 1000;
        console.log(`[shopify-graphql] Rate limit approaching, waiting ${waitTime}ms...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    hasNextPage = data.orders.pageInfo.hasNextPage;
    cursor = data.orders.pageInfo.endCursor;

    console.log(`[shopify-graphql] Fetched ${filteredOrders.length} orders (total: ${allOrders.length})...`);
  }

  console.log(`[shopify-graphql] Completed fetching ${allOrders.length} orders`);
  return allOrders;
}

/**
 * Fetches a single order by ID using GraphQL API
 */
export async function fetchShopifyOrderGraphQL(params: {
  tenantId: string;
  shopDomain: string;
  orderId: string;
}): Promise<GraphQLOrder | null> {
  const accessToken = await getShopifyAccessToken(params.tenantId);
  if (!accessToken) {
    throw new Error('No access token found for this tenant');
  }

  const normalizedShop = normalizeShopDomain(params.shopDomain);
  
  // Use query to fetch specific order by ID
  const queryString = `id:${params.orderId}`;
  
  const url = `https://${normalizedShop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({
      query: ORDERS_QUERY,
      variables: {
        query: queryString,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Shopify GraphQL API error: ${response.status} ${body}`);
  }

  const result = (await response.json()) as GraphQLOrdersResponse | { errors?: Array<{ message: string }> };

  if ('errors' in result && result.errors) {
    throw new Error(`Shopify GraphQL errors: ${result.errors.map((e) => e.message).join(', ')}`);
  }

  if (!('data' in result)) {
    throw new Error('Invalid GraphQL response structure');
  }

  const data = result.data;
  if (data.orders.edges.length === 0) {
    return null;
  }

  return data.orders.edges[0].node;
}

