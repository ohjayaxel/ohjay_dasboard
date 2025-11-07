# Environments & Deployment Flow

Orange Juice runs two Supabase + Vercel environments:

- **Development** (`APP_ENV=development`): linked to Supabase dev project (`orange-juice-dev`). All migrations and features deploy here first. Cron jobs can run at a higher cadence for QA. Vercel preview deployment (e.g. `develop` branch) should use the dev Supabase credentials.
- **Production** (`APP_ENV=production`): linked to Supabase prod project (`orange-juice-prod`). Only promote code after QA. Vercel production deployment (`main` branch) uses prod secrets and longer cron intervals.

## Required Environment Variables

Reference `env.example` for the full list. Configure values in Vercel → Settings → Environment Variables for both **Preview** (dev) and **Production** targets. Keep Supabase service role keys server-only.

Core variables:

- `APP_BASE_URL` — primary domain (e.g. `https://dev.orangejuice.app`, `https://app.orangejuice.app`).
- `APP_ENV` — `development` or `production`; surfaces in dashboards and Sentry.
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — public keys for the targeted Supabase project.
- `SUPABASE_SERVICE_ROLE_KEY` — service role (server-only). Never expose to clients.
- Provider credentials (`META_*`, `GOOGLE_*`, `SHOPIFY_*`) — separate dev/prod apps where possible.
- `ENCRYPTION_KEY` — 32-byte key (rotate per environment; track version in `connections.meta`).
- `SENTRY_DSN`, `SENTRY_ENVIRONMENT` — optional, server-only.
- `RATE_LIMIT_REDIS_URL`, `RATE_LIMIT_REDIS_TOKEN` — optional, used when Upstash/Redis is configured.

## Database Migrations

1. Apply migrations locally or via Supabase CLI against dev project:

   ```bash
   supabase db push --db-url "$SUPABASE_DEV_DATABASE_URL"
   ```

2. QA the dev deployment (ETL jobs, dashboards, RLS checks).
3. Repeat migration commands against production connection string once validated.

### Seed Data

- `packages/db/seed.sql` inserts a demo tenant/member for dev usage. Do **not** run in production.

## Cron & Edge Functions

- Configure Vercel cron for `/api/jobs/sync?source=...` in both environments (e.g. every 15 min dev, every 60 min prod).
- Edge Functions (`supabase/functions/sync-*`) deploy via Supabase CLI:

  ```bash
  supabase functions deploy sync-meta --project-ref <dev-project>
  supabase functions deploy sync-meta --project-ref <prod-project>
  ```

## QA Checklist Before Production Promote

- Supabase RLS enforced: cross-tenant reads blocked.
- OAuth flows (Meta/Google/Shopify) validated in dev.
- ETL sync functions complete without errors; `jobs_log` entries show `succeeded`.
- Dashboards render SSR via `kpi_daily` without placeholder content.
- No secrets/logging leaks in client bundles.

Document updates alongside code changes to keep dev vs prod parity clear.

