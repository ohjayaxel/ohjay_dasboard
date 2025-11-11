import { logger } from '@/lib/logger'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

import {
  MetaInsightsStorageAdapter,
  NormalizedInsightRow,
  UpsertDailyContext,
  hashBreakdowns,
} from '@/lib/integrations/metaInsightsRunner'

const UPSERT_BATCH_SIZE = 500

function toDatabaseRow(row: NormalizedInsightRow, context: UpsertDailyContext) {
  const breakdownsHash = hashBreakdowns(row.breakdowns)

  return {
    tenant_id: context.tenantId,
    ad_account_id: row.accountId,
    campaign_id: row.campaignId,
    campaign_name: row.campaignName,
    adset_id: row.adsetId,
    adset_name: row.adsetName,
    ad_id: row.adId,
    ad_name: row.adName,
    entity_id: row.entityId,
    date: row.dateStart,
    date_stop: row.dateStop,
    level: context.level,
    action_report_time: context.actionReportTime,
    attribution_window: context.attributionWindow,
    breakdowns_key: context.breakdownsKey || null,
    breakdowns_hash: breakdownsHash,
    breakdowns: row.breakdowns,
    actions: row.actions,
    action_values: row.actionValues,
    spend: row.spend,
    impressions: row.impressions,
    reach: row.reach,
    clicks: row.clicks,
    unique_clicks: row.uniqueClicks,
    inline_link_clicks: row.inlineLinkClicks,
    conversions: row.conversions,
    purchases: row.purchases,
    add_to_cart: row.addToCart,
    leads: row.leads,
    revenue: row.revenue,
    purchase_roas: row.purchaseRoas,
    cost_per_action_type: row.costPerActionType,
    cpm: row.cpm,
    cpc: row.cpc,
    ctr: row.ctr,
    frequency: row.frequency,
    objective: row.objective,
    effective_status: row.effectiveStatus,
    configured_status: row.configuredStatus,
    buying_type: row.buyingType,
    daily_budget: row.dailyBudget,
    lifetime_budget: row.lifetimeBudget,
    currency: row.currency,
  }
}

export class SupabaseMetaInsightsStorage implements MetaInsightsStorageAdapter {
  async upsertDaily(rows: NormalizedInsightRow[], context: UpsertDailyContext): Promise<void> {
    if (rows.length === 0) {
      return
    }

    const client = getSupabaseServiceClient()

    for (let cursor = 0; cursor < rows.length; cursor += UPSERT_BATCH_SIZE) {
      const batch = rows.slice(cursor, cursor + UPSERT_BATCH_SIZE).map((row) => toDatabaseRow(row, context))

      const { error } = await client
        .from('meta_insights_daily')
        .upsert(batch, {
          onConflict: 'tenant_id,date,level,entity_id,action_report_time,attribution_window,breakdowns_hash',
        })

      if (error) {
        logger.error(
          {
            tenantId: context.tenantId,
            accountId: context.accountId,
            level: context.level,
            actionReportTime: context.actionReportTime,
            attributionWindow: context.attributionWindow,
            breakdownsKey: context.breakdownsKey,
            error,
          },
          'Failed to upsert meta_insights_daily batch',
        )
        throw new Error(`Failed to upsert meta insights daily: ${error.message}`)
      }
    }
  }
}

export function createMetaInsightsStorageAdapter(): MetaInsightsStorageAdapter {
  return new SupabaseMetaInsightsStorage()
}


