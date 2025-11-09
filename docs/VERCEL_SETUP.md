# Vercel Setup Guide

## Projects

Create two Vercel projects:

1. `oj-dashboard-dev` – connect to `develop` branch (Preview/Development).
2. `oj-dashboard-prod` – connect to `main` branch (Production).

Recommended region: `fra1` for reduced latency in EU.

Enable Preview Deployments on the dev project.

## Environment Variables

Populate the Vercel environment variables using the templates:

- **Preview / Development** → `env/.env.dev.example`
- **Production** → `env/.env.prod.example`

Copy each variable into the corresponding environment tab in Vercel Project Settings.

## Cron Jobs

Configure Vercel Cron Jobs for each project:

| Endpoint | Schedule |
| --- | --- |
| `/api/jobs/sync?source=meta` | Daily at 03:00 UTC |
| `/api/jobs/sync?source=google_ads` | Daily at 03:15 UTC |
| `/api/jobs/sync?source=shopify` | Daily at 03:30 UTC |

These schedules are encoded in `vercel.json`, so deployments automatically register the cron jobs. Ensure each project uses its own `APP_BASE_URL` and Supabase credentials.

## Deployment Checklist

1. Confirm environment variables are set in Vercel for Preview and Production.
2. Trigger a deployment from the appropriate branch.
3. Verify the deployment has access to Supabase by visiting `/t/<tenantSlug>` after running migrations.
4. Set up additional integrations (Sentry, Upstash) as needed using optional env variables.
