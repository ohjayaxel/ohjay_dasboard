import { NextResponse } from 'next/server';

import { sendSlackMessage } from '@/lib/notifications/slack';

/**
 * Test endpoint to verify Slack webhook integration
 * This endpoint attempts to send a test message to Slack and returns the result
 */
export async function GET() {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const isConfigured = !!webhookUrl && webhookUrl.trim().length > 0;

  if (!isConfigured) {
    return NextResponse.json(
      {
        success: false,
        error: 'SLACK_WEBHOOK_URL is not configured',
        webhook_url_preview: null,
      },
      { status: 200 },
    );
  }

  // Send a test message
  const testMessage = {
    text: '🧪 Test message from Analytics Platform',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*🧪 Test Message*\nThis is a test message to verify Slack webhook integration is working correctly.',
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Test sent at: ${new Date().toISOString()}`,
          },
        ],
      },
    ],
  };

  try {
    const sent = await sendSlackMessage(testMessage);

    return NextResponse.json(
      {
        success: sent,
        webhook_url_preview: `${webhookUrl.substring(0, 30)}...${webhookUrl.substring(webhookUrl.length - 10)}`,
        webhook_url_length: webhookUrl.length,
        message: sent
          ? '✅ Test message sent successfully to Slack'
          : '❌ Failed to send test message to Slack',
        test_message: testMessage,
      },
      { status: 200 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        webhook_url_preview: `${webhookUrl.substring(0, 30)}...${webhookUrl.substring(webhookUrl.length - 10)}`,
        webhook_url_length: webhookUrl.length,
        message: '❌ Exception while sending test message',
      },
      { status: 200 },
    );
  }
}

