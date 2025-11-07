# Supabase Environment Setup

This project uses separate Supabase projects for development and production:

- **Dev project ref:** `etzemjsrczxnkaykijzl`
- **Prod project ref:** `punicovacaktaszqcckp`

## Switching environments

Use the provided script to toggle Supabase CLI configuration:

```bash
npm run sb:switch:dev   # points CLI to dev project
npm run sb:switch:prod  # points CLI to prod project
```

The script writes `.supabase/config.toml` and exports `SUPABASE_PROJECT_REF` for the active session.

## Running migrations

1. Switch to the target environment (dev first):
   ```bash
   npm run sb:switch:dev
   ```
2. Push migrations:
   ```bash
   npm run db:push
   ```
3. (Dev only) apply seed data:
   ```bash
   supabase db execute supabase/seed.sql
   ```

## Promoting to production

1. Dry-run locally using Supabase CLI `db diff` or by reviewing migration SQLs.
2. Switch to prod:
   ```bash
   npm run sb:switch:prod
   ```
3. Ensure `.supabase/config.toml` references the prod ref, then run:
   ```bash
   npm run db:push
   ```
4. (Optional) execute seed if needed (typically skip in prod).
