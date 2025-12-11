import { NextResponse } from 'next/server';

/**
 * Debug endpoint to check if SLACK_WEBHOOK_URL is available in runtime
 * This helps diagnose if environment variables are properly set in Vercel
 */
export async function GET() {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const isConfigured = !!webhookUrl && webhookUrl.trim().length > 0;

  return NextResponse.json(
    {
      slack_webhook_configured: isConfigured,
      webhook_url_preview: webhookUrl
        ? `${webhookUrl.substring(0, 30)}...${webhookUrl.substring(webhookUrl.length - 10)}`
        : null,
      webhook_url_length: webhookUrl?.length || 0,
      message: isConfigured
        ? '✅ SLACK_WEBHOOK_URL is configured and available'
        : '❌ SLACK_WEBHOOK_URL is not configured or empty',
    },
    { status: 200 },
  );
}

