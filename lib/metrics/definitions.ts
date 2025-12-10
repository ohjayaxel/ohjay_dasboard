/**
 * Metrics Definitions - Semantic Layer Catalog
 * 
 * This file provides a canonical catalog of key metrics used in the analytics platform.
 * It serves as a semantic layer documentation that maps metric IDs to their definitions,
 * source views/tables, and human-readable descriptions.
 * 
 * This is a read-only catalog - metric calculations are performed in SQL views or
 * application code. This file exists to provide:
 * - Single source of truth for metric naming
 * - Documentation for metric meanings
 * - Type safety for metric IDs
 * - Reference for where metrics come from
 * 
 * @module lib/metrics/definitions
 */

/**
 * Metric ID type - defines all valid metric identifiers in the system
 */
export type MetricId =
  | 'marketing_spend_total'
  | 'marketing_spend_meta'
  | 'marketing_spend_google_ads'
  | 'amer'
  | 'net_sales'
  | 'gross_sales'
  | 'new_customer_net_sales'
  | 'returning_customer_net_sales'
  | 'guest_net_sales'
  | 'orders';

/**
 * Metric definition interface
 */
export interface MetricDefinition {
  /** Unique identifier for the metric (used in code and APIs) */
  id: MetricId;
  
  /** Human-readable label for display in UI */
  label: string;
  
  /** Detailed description of what the metric represents */
  description: string;
  
  /** Source view or table where this metric is available */
  sourceView: string;
  
  /** Column name in the source view/table */
  column: string;
  
  /** Unit of measurement (currency, ratio, count, etc.) */
  unit: 'currency' | 'ratio' | 'count' | 'percentage';
}

/**
 * Canonical metric definitions catalog
 * 
 * This array contains all defined metrics in the semantic layer.
 * Metrics are organized by source view for clarity.
 */
export const metricDefinitions: MetricDefinition[] = [
  // ============================================================================
  // Marketing Spend Metrics (from v_marketing_spend_daily)
  // ============================================================================
  {
    id: 'marketing_spend_total',
    label: 'Total Marketing Spend',
    description:
      'Sum of marketing spend across all advertising channels (Meta + Google Ads) for a given tenant and date.',
    sourceView: 'v_marketing_spend_daily',
    column: 'total_marketing_spend',
    unit: 'currency',
  },
  {
    id: 'marketing_spend_meta',
    label: 'Meta Spend',
    description:
      'Marketing spend from Meta Ads (Facebook/Instagram) only. This represents ad spend in the account currency.',
    sourceView: 'v_marketing_spend_daily',
    column: 'meta_spend',
    unit: 'currency',
  },
  {
    id: 'marketing_spend_google_ads',
    label: 'Google Ads Spend',
    description:
      'Marketing spend from Google Ads only. This represents ad spend in the account currency (originally stored as cost_micros / 1,000,000).',
    sourceView: 'v_marketing_spend_daily',
    column: 'google_ads_spend',
    unit: 'currency',
  },

  // ============================================================================
  // Sales Metrics (from v_daily_metrics, sourced from shopify_daily_sales)
  // ============================================================================
  {
    id: 'net_sales',
    label: 'Net Sales',
    description:
      'Total net sales per day from Shopify (gross sales minus discounts and refunds, excluding tax). Uses Shopify Mode calculation which matches Shopify Analytics.',
    sourceView: 'v_daily_metrics',
    column: 'net_sales',
    unit: 'currency',
  },
  {
    id: 'gross_sales',
    label: 'Gross Sales',
    description:
      'Total gross sales per day from Shopify before discounts and refunds (excluding tax).',
    sourceView: 'v_daily_metrics',
    column: 'gross_sales',
    unit: 'currency',
  },
  {
    id: 'new_customer_net_sales',
    label: 'New Customer Net Sales',
    description:
      'Net sales from new/first-time customers only. Used for calculating aMER and customer acquisition metrics.',
    sourceView: 'v_daily_metrics',
    column: 'new_customer_net_sales',
    unit: 'currency',
  },
  {
    id: 'returning_customer_net_sales',
    label: 'Returning Customer Net Sales',
    description: 'Net sales from returning customers only.',
    sourceView: 'v_daily_metrics',
    column: 'returning_customer_net_sales',
    unit: 'currency',
  },
  {
    id: 'guest_net_sales',
    label: 'Guest Net Sales',
    description: 'Net sales from guest checkouts (orders without a customer_id).',
    sourceView: 'v_daily_metrics',
    column: 'guest_net_sales',
    unit: 'currency',
  },
  {
    id: 'orders',
    label: 'Orders',
    description: 'Number of orders placed on a given day.',
    sourceView: 'v_daily_metrics',
    column: 'orders',
    unit: 'count',
  },

  // ============================================================================
  // Calculated Metrics (from v_daily_metrics)
  // ============================================================================
  {
    id: 'amer',
    label: 'aMER',
    description:
      'Adjusted Marketing Efficiency Ratio: new customer net sales divided by total marketing spend. Measures how efficiently marketing spend generates revenue from new customers. Higher values indicate better efficiency.',
    sourceView: 'v_daily_metrics',
    column: 'amer',
    unit: 'ratio',
  },
];

/**
 * Get metric definition by ID
 * 
 * @param id - Metric ID to lookup
 * @returns Metric definition or undefined if not found
 */
export function getMetricDefinition(id: MetricId): MetricDefinition | undefined {
  return metricDefinitions.find((m) => m.id === id);
}

/**
 * Get all metrics for a given source view
 * 
 * @param sourceView - Source view name (e.g., 'v_marketing_spend_daily')
 * @returns Array of metric definitions for that view
 */
export function getMetricsBySourceView(sourceView: string): MetricDefinition[] {
  return metricDefinitions.filter((m) => m.sourceView === sourceView);
}

/**
 * Get all metric IDs as a string array (useful for validation)
 */
export function getAllMetricIds(): string[] {
  return metricDefinitions.map((m) => m.id);
}

/**
 * Check if a metric is backed by a semantic layer view
 * 
 * This utility function determines whether a metric comes from one of our
 * semantic layer views (v_marketing_spend_daily, v_daily_metrics) or from
 * a base table. This can be used to:
 * - Filter which metrics are view-backed
 * - Auto-map metrics to queries based on their source
 * - Validate metric queries
 * 
 * @param id - Metric ID to check
 * @returns true if the metric has a sourceView defined, false otherwise
 */
export function isViewBackedMetric(id: MetricId): boolean {
  const def = getMetricDefinition(id);
  return !!def && !!def.sourceView;
}

/**
 * Canonical metric definitions catalog
 * 
 * This array contains all defined metrics in the semantic layer.
 * Metrics are organized by source view for clarity.
 */
export const metricDefinitions: MetricDefinition[] = [
  // ============================================================================
  // Marketing Spend Metrics (from v_marketing_spend_daily)
  // ============================================================================
  {
    id: 'marketing_spend_total',
    label: 'Total Marketing Spend',
    description:
      'Sum of marketing spend across all advertising channels (Meta + Google Ads) for a given tenant and date.',
    sourceView: 'v_marketing_spend_daily',
    column: 'total_marketing_spend',
    unit: 'currency',
  },
  {
    id: 'marketing_spend_meta',
    label: 'Meta Spend',
    description:
      'Marketing spend from Meta Ads (Facebook/Instagram) only. This represents ad spend in the account currency.',
    sourceView: 'v_marketing_spend_daily',
    column: 'meta_spend',
    unit: 'currency',
  },
  {
    id: 'marketing_spend_google_ads',
    label: 'Google Ads Spend',
    description:
      'Marketing spend from Google Ads only. This represents ad spend in the account currency (originally stored as cost_micros / 1,000,000).',
    sourceView: 'v_marketing_spend_daily',
    column: 'google_ads_spend',
    unit: 'currency',
  },

  // ============================================================================
  // Sales Metrics (from v_daily_metrics, sourced from shopify_daily_sales)
  // ============================================================================
  {
    id: 'net_sales',
    label: 'Net Sales',
    description:
      'Total net sales per day from Shopify (gross sales minus discounts and refunds, excluding tax). Uses Shopify Mode calculation which matches Shopify Analytics.',
    sourceView: 'v_daily_metrics',
    column: 'net_sales',
    unit: 'currency',
  },
  {
    id: 'gross_sales',
    label: 'Gross Sales',
    description:
      'Total gross sales per day from Shopify before discounts and refunds (excluding tax).',
    sourceView: 'v_daily_metrics',
    column: 'gross_sales',
    unit: 'currency',
  },
  {
    id: 'new_customer_net_sales',
    label: 'New Customer Net Sales',
    description:
      'Net sales from new/first-time customers only. Used for calculating aMER and customer acquisition metrics.',
    sourceView: 'v_daily_metrics',
    column: 'new_customer_net_sales',
    unit: 'currency',
  },
  {
    id: 'returning_customer_net_sales',
    label: 'Returning Customer Net Sales',
    description: 'Net sales from returning customers only.',
    sourceView: 'v_daily_metrics',
    column: 'returning_customer_net_sales',
    unit: 'currency',
  },
  {
    id: 'guest_net_sales',
    label: 'Guest Net Sales',
    description: 'Net sales from guest checkouts (orders without a customer_id).',
    sourceView: 'v_daily_metrics',
    column: 'guest_net_sales',
    unit: 'currency',
  },
  {
    id: 'orders',
    label: 'Orders',
    description: 'Number of orders placed on a given day.',
    sourceView: 'v_daily_metrics',
    column: 'orders',
    unit: 'count',
  },

  // ============================================================================
  // Calculated Metrics (from v_daily_metrics)
  // ============================================================================
  {
    id: 'amer',
    label: 'aMER',
    description:
      'Adjusted Marketing Efficiency Ratio: new customer net sales divided by total marketing spend. Measures how efficiently marketing spend generates revenue from new customers. Higher values indicate better efficiency.',
    sourceView: 'v_daily_metrics',
    column: 'amer',
    unit: 'ratio',
  },
];

/**
 * Get metric definition by ID
 * 
 * @param id - Metric ID to lookup
 * @returns Metric definition or undefined if not found
 */
export function getMetricDefinition(id: MetricId): MetricDefinition | undefined {
  return metricDefinitions.find((m) => m.id === id);
}

/**
 * Get all metrics for a given source view
 * 
 * @param sourceView - Source view name (e.g., 'v_marketing_spend_daily')
 * @returns Array of metric definitions for that view
 */
export function getMetricsBySourceView(sourceView: string): MetricDefinition[] {
  return metricDefinitions.filter((m) => m.sourceView === sourceView);
}

/**
 * Get all metric IDs as a string array (useful for validation)
 */
export function getAllMetricIds(): string[] {
  return metricDefinitions.map((m) => m.id);
}

/**
 * Check if a metric is backed by a semantic layer view
 * 
 * This function determines whether a metric comes from one of our semantic layer views
 * (e.g., v_marketing_spend_daily, v_daily_metrics) as opposed to a raw table.
 * 
 * This is useful for:
 * - Filtering which metrics are available from semantic views
 * - Auto-mapping metrics to view queries
 * - Determining whether to use semantic layer or direct table queries
 * 
 * @param id - Metric ID to check
 * @returns true if the metric is backed by a view, false otherwise
 */
export function isViewBackedMetric(id: MetricId): boolean {
  const def = getMetricDefinition(id);
  return !!def && !!def.sourceView;
}


