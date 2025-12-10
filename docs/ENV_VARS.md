# Environment Variables Reference

This project requires separate configuration for development and production. Use `env/.env.dev.example` and `env/.env.prod.example` as templates.

| Variable | Scope | Purpose | Retrieve from |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Client & Server | Supabase REST base URL (public) | Supabase Dashboard → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client | Public anon key for Supabase Auth | Supabase Dashboard → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Service role key for migrations, Edge Functions | Supabase Dashboard → Settings → API |
| `NEXT_PUBLIC_BASE_URL` | Client & Server | Canonical base URL for OAuth redirects (must include protocol) | Vercel project domain |
| `APP_BASE_URL` | Server (optional) | Server-only override for the base URL (falls back to `NEXT_PUBLIC_BASE_URL`) | Vercel project domain |
| `APP_ENV` | Both | Environment indicator (`development`/`production`) | Set manually |
| `META_APP_ID` | Server | Meta OAuth App ID | Meta for Developers → App Dashboard |
| `META_APP_SECRET` | Server | Meta OAuth App Secret | Meta for Developers → App Dashboard |
| `META_API_VERSION` | Server | Graph API version to target (default `v18.0`) | Meta for Developers → Graph API Changelog |
| `META_SYSTEM_USER_TOKEN` | Server (optional) | System user token used when tenant token is unavailable | Meta Business Manager → System Users |
| `META_DEV_ACCESS_TOKEN` | Server (optional, dev) | Development override token for Meta Marketing API calls | Meta for Developers → Marketing API Tools |
| `META_DEV_AD_ACCOUNT_ID` | Server (optional, dev) | Ad account ID used with `META_DEV_ACCESS_TOKEN` | Meta Business Manager → Ad Accounts |
| `GOOGLE_CLIENT_ID` | Server | Google Ads OAuth Client ID | Google Cloud Console → APIs & Services → Credentials |
| `GOOGLE_CLIENT_SECRET` | Server | Google Ads OAuth Client Secret | Google Cloud Console → APIs & Services → Credentials |
| `GOOGLE_DEVELOPER_TOKEN` | Server | Google Ads API developer token (krävs för API-anrop, men OAuth fungerar utan) | [Google Ads API Center](https://ads.google.com/aw/apicenter) - Ansök via Manager-konto |
| `SHOPIFY_API_KEY` | Server | Shopify Admin API key | Shopify Admin → Apps → Custom App |
| `SHOPIFY_API_SECRET` | Server | Shopify Admin API secret | Shopify Admin → Apps → Custom App |
| `ENCRYPTION_KEY` | Server | 32-byte key for encrypting tokens | Generate locally (32 bytes base64/hex) |
| `SENTRY_DSN` | Server | Error logging (optional) | Sentry Project Settings |

## Environment Profiles

Keeping the Supabase keys and the Meta encryption key in sync across environments is critical. The repository ships with shell profile templates in `env/`:

- `env/local.dev.sh.example`
- `env/local.prod.sh.example`

Copy the example files to `env/local.dev.sh` / `env/local.prod.sh`, replace the placeholder values, and source the profile before running scripts:

```bash
source env/local.dev.sh    # work against the dev database + encryption key
# or
source env/local.prod.sh   # work against production
```

The profile scripts export `APP_ENV`, Supabase credentials, Meta OAuth credentials, and the `ENCRYPTION_KEY`. The active profile is echoed in the shell so it is obvious which environment is in use. The populated `.sh` files are git-ignored by default.

### Quick Consistency Check

`pnpm tsx scripts/meta_insights_probe.ts` now prints an environment diagnostics block that includes:

- currently loaded Supabase URL
- fingerprint of the locally sourced `ENCRYPTION_KEY`
- fingerprint + environment stored in the remote `connections.meta`

If the fingerprints differ, reconnect Meta in the target environment after the correct profile has been sourced.

## Verification

- Fill `.env.local` with dev values, then run `npm run env:check:dev`.
- When production values are available locally or in CI, run `npm run env:check:prod`.
- After dev env is configured, validate Supabase connectivity with `npm run db:push`.
