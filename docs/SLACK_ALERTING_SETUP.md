# Slack Alerting Setup

This document describes how to set up Slack alerts for sync job failures and token expiration warnings.

## Overview

The platform now supports proactive Slack alerts for:
- **Sync job failures**: When sync jobs fail repeatedly (>50% failure rate or 3+ consecutive failures)
- **Token expiration warnings**: When access tokens are about to expire (within 24 hours for check-failure-rate, 7 days for check-token-health)

## Setup Instructions

### 1. Create a Slack Incoming Webhook

1. Go to [Slack Apps](https://api.slack.com/apps)
2. Click "Create New App" → "From scratch"
3. Give it a name (e.g., "Analytics Platform Alerts") and select your workspace
4. Go to "Incoming Webhooks" in the left sidebar
5. Toggle "Activate Incoming Webhooks" to ON
6. Click "Add New Webhook to Workspace"
7. Select the channel where you want to receive alerts (e.g., `#alerts` or `#devops`)
8. Copy the webhook URL (format: `https://hooks.slack.com/services/T.../B.../...`)

### 2. Configure Environment Variable

Add the webhook URL to your Vercel environment variables:

**For Production:**
1. Go to Vercel Dashboard → Your Project → Settings → Environment Variables
2. Add:
   - **Key**: `SLACK_WEBHOOK_URL`
   - **Value**: `https://hooks.slack.com/services/...` (your webhook URL)
   - **Environment**: Production

**For Preview/Development (optional):**
- Same steps, but set Environment to "Preview" or "Development"
- You can use a different channel for dev alerts

### 3. Cron Jobs

Alerts are automatically sent by existing cron jobs:

- **check-failure-rate**: Runs every 6 hours (`0 */6 * * *`)
  - Checks for sync job failures and sends alerts if:
    - >50% failure rate over last 24 hours
    - 3+ consecutive failures
  
- **check-token-health**: Runs daily at 9 AM (`0 9 * * *`)
  - Checks for token expiration and sends alerts if:
    - Token expires within 7 days
    - Token-related errors detected in recent failures

## Alert Examples

### Sync Failure Alert
```
🔵 Sync Failure Alert: Google Ads

Tenant: Skinome
Source: Google Ads

⚠️ 3 consecutive failures detected

Last Failure: 2025-12-11 14:30:00

Check dashboard: https://dashboard.example.com/admin/tenants
```

### Token Expiration Warning
```
🔑 Token Expiration Warning: Google Ads

Tenant: Skinome
Source: Google Ads

⚠️ Access token expires in 23.5 hours
Expires at: 2025-12-12 15:30:00

Please re-authenticate in admin panel: https://dashboard.example.com/admin/tenants/...
```

## Testing

You can test the Slack integration manually:

1. **Test failure alert:**
   ```bash
   curl https://your-app.vercel.app/api/jobs/check-failure-rate
   ```

2. **Test token expiration warning:**
   ```bash
   curl https://your-app.vercel.app/api/jobs/check-token-health
   ```

Note: Alerts are only sent if `SLACK_WEBHOOK_URL` is configured. If not set, the endpoints will still work but won't send Slack notifications (they'll log a warning).

## Troubleshooting

### No alerts received

1. **Check environment variable:**
   - Verify `SLACK_WEBHOOK_URL` is set in Vercel
   - Make sure it's set for the correct environment (Production/Preview)

2. **Check cron jobs:**
   - Verify cron jobs are running in Vercel Dashboard → Cron Jobs
   - Check execution logs for errors

3. **Check Slack webhook:**
   - Test webhook URL directly: `curl -X POST -H 'Content-Type: application/json' -d '{"text":"Test"}' YOUR_WEBHOOK_URL`
   - Verify webhook is still active in Slack App settings

4. **Check application logs:**
   - Look for `[slack]` log entries in Vercel Function Logs
   - Errors will be logged but won't fail the cron jobs

### Too many alerts

- Alerts are rate-limited by cron job frequency (6 hours for failures, daily for tokens)
- Each alert type only sends one message per check
- You can adjust thresholds in the respective route files if needed

## Security

- **Never commit webhook URLs to git**
- Store webhook URLs only in Vercel environment variables
- Webhook URLs grant full posting access to the configured channel
- Rotate webhook URLs if compromised

## Customization

You can customize alert formatting in `lib/notifications/slack.ts`:
- `formatSyncFailureAlert()` - Format sync failure alerts
- `formatTokenExpirationWarning()` - Format token expiration warnings
- `sendSlackMessage()` - Core Slack webhook sending function

