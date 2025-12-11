/**
 * Slack notifications utility
 * 
 * Sends alerts to Slack via webhook when sync jobs fail or encounter critical issues.
 */

type SlackMessage = {
  text?: string;
  blocks?: Array<{
    type: string;
    text?: {
      type: string;
      text: string;
    };
    elements?: Array<{
      type: string;
      text: string;
      style?: string;
    }>;
    fields?: Array<{
      type: string;
      text: string;
    }>;
  }>;
};

/**
 * Send a message to Slack via webhook
 */
export async function sendSlackMessage(message: SlackMessage): Promise<boolean> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  
  if (!webhookUrl) {
    console.warn('[slack] SLACK_WEBHOOK_URL not configured, skipping Slack notification');
    return false;
  }

  console.log(`[slack] Sending message to Slack webhook (URL: ${webhookUrl.substring(0, 40)}...)`);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`[slack] Failed to send message: ${response.status} ${responseText}`);
      return false;
    }

    console.log(`[slack] Successfully sent message to Slack (response: ${responseText.trim()})`);
    return true;
  } catch (error) {
    console.error('[slack] Exception sending message:', error);
    return false;
  }
}

/**
 * Format a sync failure alert for Slack
 */
export function formatSyncFailureAlert(params: {
  source: string;
  tenantId: string;
  tenantName?: string;
  failureRate?: number;
  totalJobs?: number;
  failedJobs?: number;
  consecutiveFailures?: number;
  lastFailureAt?: string;
  errorMessage?: string;
}): SlackMessage {
  const { source, tenantId, tenantName, failureRate, totalJobs, failedJobs, consecutiveFailures, lastFailureAt, errorMessage } = params;

  const sourceEmoji: Record<string, string> = {
    google_ads: '🔵',
    meta: '🔷',
    shopify: '🟢',
  };

  const emoji = sourceEmoji[source] || '⚠️';
  const sourceDisplay = source.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  // Build blocks for rich formatting
  const blocks: SlackMessage['blocks'] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} Sync Failure Alert: ${sourceDisplay}`,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Tenant:*\n${tenantName || tenantId}`,
        },
        {
          type: 'mrkdwn',
          text: `*Source:*\n${sourceDisplay}`,
        },
      ],
    },
  ];

  if (consecutiveFailures !== undefined && consecutiveFailures >= 3) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*⚠️ ${consecutiveFailures} consecutive failures detected*`,
      },
    });
  }

  if (failureRate !== undefined && totalJobs !== undefined) {
    const percentage = (failureRate * 100).toFixed(1);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Failure Rate:* ${percentage}% (${failedJobs}/${totalJobs} jobs failed)`,
      },
    });
  }

  if (lastFailureAt) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Last Failure:* ${new Date(lastFailureAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}`,
      },
    });
  }

  if (errorMessage) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:*\n\`\`\`${errorMessage.substring(0, 500)}${errorMessage.length > 500 ? '...' : ''}\`\`\``,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Check dashboard: ${process.env.NEXT_PUBLIC_BASE_URL || 'https://dashboard.example.com'}/admin/tenants`,
      },
    ],
  });

  return {
    blocks,
  };
}

/**
 * Format a token expiration warning for Slack
 */
export function formatTokenExpirationWarning(params: {
  source: string;
  tenantId: string;
  tenantName?: string;
  expiresAt: string;
  hoursUntilExpiration?: number;
}): SlackMessage {
  const { source, tenantId, tenantName, expiresAt, hoursUntilExpiration } = params;

  const sourceEmoji: Record<string, string> = {
    google_ads: '🔵',
    meta: '🔷',
    shopify: '🟢',
  };

  const emoji = sourceEmoji[source] || '⚠️';
  const sourceDisplay = source.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  const hoursText = hoursUntilExpiration !== undefined
    ? `${hoursUntilExpiration.toFixed(1)} hours`
    : 'unknown';

  return {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🔑 Token Expiration Warning: ${sourceDisplay}`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Tenant:*\n${tenantName || tenantId}`,
          },
          {
            type: 'mrkdwn',
            text: `*Source:*\n${sourceDisplay}`,
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*⚠️ Access token expires in ${hoursText}*\n*Expires at:* ${new Date(expiresAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Please re-authenticate in admin panel: ${process.env.NEXT_PUBLIC_BASE_URL || 'https://dashboard.example.com'}/admin/tenants/${tenantId}/integrations`,
          },
        ],
      },
    ],
  };
}

