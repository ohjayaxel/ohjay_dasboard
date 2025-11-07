# Environment Variables Reference

This project requires separate configuration for development and production. Use `env/.env.dev.example` and `env/.env.prod.example` as templates.

| Variable | Scope | Purpose | Retrieve from |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Client & Server | Supabase REST base URL (public) | Supabase Dashboard → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client | Public anon key for Supabase Auth | Supabase Dashboard → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Service role key for migrations, Edge Functions | Supabase Dashboard → Settings → API |
| `APP_BASE_URL` | Server | Base URL used for OAuth redirects and emails | Vercel project domain |
| `APP_ENV` | Both | Environment indicator (`development`/`production`) | Set manually |
| `META_APP_ID` | Server | Meta OAuth App ID | Meta for Developers → App Dashboard |
| `META_APP_SECRET` | Server | Meta OAuth App Secret | Meta for Developers → App Dashboard |
| `META_DEV_ACCESS_TOKEN` | Server (optional, dev) | Development override token for Meta Marketing API calls | Meta for Developers → Marketing API Tools |
| `META_DEV_AD_ACCOUNT_ID` | Server (optional, dev) | Ad account ID used with `META_DEV_ACCESS_TOKEN` | Meta Business Manager → Ad Accounts |
| `GOOGLE_CLIENT_ID` | Server | Google Ads OAuth Client ID | Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Server | Google Ads OAuth Client Secret | Google Cloud Console |
| `GOOGLE_DEVELOPER_TOKEN` | Server | Google Ads API developer token | Google Ads Manager account |
| `SHOPIFY_API_KEY` | Server | Shopify Admin API key | Shopify Admin → Apps → Custom App |
| `SHOPIFY_API_SECRET` | Server | Shopify Admin API secret | Shopify Admin → Apps → Custom App |
| `ENCRYPTION_KEY` | Server | 32-byte key for encrypting tokens | Generate locally (32 bytes base64/hex) |
| `SENTRY_DSN` | Server | Error logging (optional) | Sentry Project Settings |

## Verification

- Fill `.env.local` with dev values, then run `npm run env:check:dev`.
- When production values are available locally or in CI, run `npm run env:check:prod`.
- After dev env is configured, validate Supabase connectivity with `npm run db:push`.
