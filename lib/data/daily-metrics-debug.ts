/**
 * Daily Metrics Comparison Helper
 * 
 * This module provides diagnostic utilities to compare the old aggregation logic
 * (based on kpi_daily + shopify_daily_sales) with the new semantic layer views
 * (v_daily_metrics).
 * 
 * This is a debugging/diagnostic tool to help build confidence in the semantic layer
 * before switching over frontend code.
 */

import { getOverviewData, type OverviewDataPoint } from './agg';
import { getDailyMetricsFromView, type DailyMetricsRow } from './daily-metrics';

/**
 * Parameters for comparing daily metrics layers
 */
export type CompareDailyMetricsLayersParams = {
  tenantId: string;
  from: string; // 'YYYY-MM-DD'
  to: string;   // 'YYYY-MM-DD'
};

/**
 * Comparison result row showing old vs new values and deltas
 */
export type DailyMetricsComparisonRow = {
  date: string;
  old: {
    net_sales: number | null;
    new_customer_net_sales: number | null;
    total_marketing_spend: number | null;
    amer: number | null;
  };
  semantic: {
    net_sales: number | null;
    new_customer_net_sales: number | null;
    total_marketing_spend: number | null;
    amer: number | null;
  };
  deltas: {
    net_sales: number | null;
    new_customer_net_sales: number | null;
    total_marketing_spend: number | null;
    amer: number | null;
  };
};

/**
 * Comparison result containing all rows and summary statistics
 */
export type DailyMetricsComparisonResult = {
  rows: DailyMetricsComparisonRow[];
  summary: {
    totalDates: number;
    matchingDates: number;
    datesWithDeltas: number;
    maxDeltaNetSales: number | null;
    maxDeltaMarketingSpend: number | null;
    maxDeltaAmer: number | null;
  };
};

/**
 * Helper to compute delta between two values
 */
function computeDelta(
  semantic: number | null,
  old: number | null,
): number | null {
  if (semantic === null && old === null) return null;
  if (semantic === null) return null; // Can't compute delta if semantic is null
  if (old === null) return semantic; // If old is null, delta is semantic value
  return semantic - old;
}

/**
 * Helper to map OverviewDataPoint (old) to comparison format
 */
function mapOldToComparison(point: OverviewDataPoint): {
  net_sales: number | null;
  new_customer_net_sales: number | null;
  total_marketing_spend: number | null;
  amer: number | null;
} {
  return {
    net_sales: point.net_sales ?? null,
    new_customer_net_sales: point.new_customer_net_sales ?? null,
    total_marketing_spend: point.marketing_spend ?? null,
    amer: point.amer ?? null,
  };
}

/**
 * Helper to map DailyMetricsRow (semantic) to comparison format
 */
function mapSemanticToComparison(row: DailyMetricsRow): {
  net_sales: number | null;
  new_customer_net_sales: number | null;
  total_marketing_spend: number | null;
  amer: number | null;
} {
  return {
    net_sales: row.net_sales ?? null,
    new_customer_net_sales: row.new_customer_net_sales ?? null,
    total_marketing_spend: row.total_marketing_spend ?? null,
    amer: row.amer ?? null,
  };
}

/**
 * Compares the old aggregation logic with the new semantic layer view.
 * 
 * This function:
 * 1. Fetches data using the old logic (getOverviewData from lib/data/agg.ts)
 * 2. Fetches data using the new semantic layer (getDailyMetricsFromView)
 * 3. Joins them by date and computes deltas
 * 
 * @param params - Comparison parameters
 * @returns Comparison result with rows showing old vs new values and deltas
 */
export async function compareDailyMetricsLayers(
  params: CompareDailyMetricsLayersParams,
): Promise<DailyMetricsComparisonResult> {
  // Fetch both old and new data in parallel
  const [oldData, semanticData] = await Promise.all([
    getOverviewData({
      tenantId: params.tenantId,
      from: params.from,
      to: params.to,
    }),
    getDailyMetricsFromView({
      tenantId: params.tenantId,
      from: params.from,
      to: params.to,
    }),
  ]);

  // Build maps by date for efficient lookup
  const oldByDate = new Map<string, OverviewDataPoint>();
  for (const point of oldData.series) {
    oldByDate.set(point.date, point);
  }

  const semanticByDate = new Map<string, DailyMetricsRow>();
  for (const row of semanticData) {
    semanticByDate.set(row.date, row);
  }

  // Get all unique dates from both sources
  const allDates = new Set<string>();
  for (const date of oldByDate.keys()) {
    allDates.add(date);
  }
  for (const date of semanticByDate.keys()) {
    allDates.add(date);
  }
  const sortedDates = Array.from(allDates).sort();

  // Build comparison rows
  const rows: DailyMetricsComparisonRow[] = [];

  for (const date of sortedDates) {
    const oldPoint = oldByDate.get(date);
    const semanticRow = semanticByDate.get(date);

    const oldValues = oldPoint ? mapOldToComparison(oldPoint) : {
      net_sales: null,
      new_customer_net_sales: null,
      total_marketing_spend: null,
      amer: null,
    };

    const semanticValues = semanticRow ? mapSemanticToComparison(semanticRow) : {
      net_sales: null,
      new_customer_net_sales: null,
      total_marketing_spend: null,
      amer: null,
    };

    // Compute deltas
    const deltas = {
      net_sales: computeDelta(semanticValues.net_sales, oldValues.net_sales),
      new_customer_net_sales: computeDelta(
        semanticValues.new_customer_net_sales,
        oldValues.new_customer_net_sales,
      ),
      total_marketing_spend: computeDelta(
        semanticValues.total_marketing_spend,
        oldValues.total_marketing_spend,
      ),
      amer: computeDelta(semanticValues.amer, oldValues.amer),
    };

    rows.push({
      date,
      old: oldValues,
      semantic: semanticValues,
      deltas,
    });
  }

  // Compute summary statistics
  const datesWithDeltas = rows.filter(
    (row) =>
      row.deltas.net_sales !== null ||
      row.deltas.new_customer_net_sales !== null ||
      row.deltas.total_marketing_spend !== null ||
      row.deltas.amer !== null,
  ).length;

  const matchingDates = rows.filter((row) => {
    return (
      (row.deltas.net_sales === null ||
        Math.abs(row.deltas.net_sales) < 0.01)
    ) && (
      row.deltas.new_customer_net_sales === null ||
      Math.abs(row.deltas.new_customer_net_sales) < 0.01
    ) && (
      row.deltas.total_marketing_spend === null ||
      Math.abs(row.deltas.total_marketing_spend) < 0.01
    ) && (
      row.deltas.amer === null ||
      Math.abs(row.deltas.amer) < 0.01
    );
  }).length;

  const allDeltasNetSales = rows
    .map((r) => r.deltas.net_sales)
    .filter((d): d is number => d !== null);
  const allDeltasMarketingSpend = rows
    .map((r) => r.deltas.total_marketing_spend)
    .filter((d): d is number => d !== null);
  const allDeltasAmer = rows
    .map((r) => r.deltas.amer)
    .filter((d): d is number => d !== null);

  const summary = {
    totalDates: rows.length,
    matchingDates,
    datesWithDeltas,
    maxDeltaNetSales:
      allDeltasNetSales.length > 0
        ? Math.max(...allDeltasNetSales.map(Math.abs))
        : null,
    maxDeltaMarketingSpend:
      allDeltasMarketingSpend.length > 0
        ? Math.max(...allDeltasMarketingSpend.map(Math.abs))
        : null,
    maxDeltaAmer:
      allDeltasAmer.length > 0
        ? Math.max(...allDeltasAmer.map(Math.abs))
        : null,
  };

  return { rows, summary };
}
