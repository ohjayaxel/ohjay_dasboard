# Hämta och Exportera Supabase Credentials

## Alternativ 1: Från Vercel Dashboard

1. Gå till [Vercel Dashboard](https://vercel.com/dashboard)
2. Välj ditt projekt
3. Settings → Environment Variables
4. Hitta `NEXT_PUBLIC_SUPABASE_URL` och `SUPABASE_SERVICE_ROLE_KEY`
5. Kopiera värdena och kör:

```bash
export NEXT_PUBLIC_SUPABASE_URL="https://xxx.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="eyJxxx..."
```

## Alternativ 2: Från Supabase Dashboard

1. Gå till [Supabase Dashboard](https://app.supabase.com)
2. Välj projektet (troligen `orange-juice-prod`)
3. Settings → API
4. Kopiera:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY`

Exportera sedan:
```bash
export NEXT_PUBLIC_SUPABASE_URL="<Project URL>"
export SUPABASE_SERVICE_ROLE_KEY="<service_role key>"
```

## Alternativ 3: Använd Vercel CLI (om installerat)

```bash
# Linka till projektet först
vercel link

# Hämta environment variables
vercel env pull .env.local --environment=production

# Ladda variablerna
export $(grep -v '^#' .env.local | xargs)
```

## Alternativ 4: Skicka mig credentials så kan jag exportera dem

Om du skickar mig credentials i chatten, kan jag exportera dem för dig direkt:

1. `NEXT_PUBLIC_SUPABASE_URL`
2. `SUPABASE_SERVICE_ROLE_KEY`

⚠️ **Varning**: Skicka bara credentials om du är OK med att de syns i chatten (de kan tas bort efteråt).

## Verifiera att variablerna är exporterade

```bash
echo "URL: $NEXT_PUBLIC_SUPABASE_URL"
echo "Key exists: $([ -n "$SUPABASE_SERVICE_ROLE_KEY" ] && echo "Yes" || echo "No")"
```



