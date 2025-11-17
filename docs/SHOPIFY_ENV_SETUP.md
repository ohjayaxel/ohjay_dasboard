# Shopify Environment Variables Setup

## Problem: Missing SHOPIFY_API_KEY

Om du får felet `Missing SHOPIFY_API_KEY environment variable` betyder det att Shopify credentials inte är konfigurerade i Vercel.

## Lösning: Lägg till Environment Variables i Vercel

### Steg 1: Hämta Shopify App Credentials

1. Logga in på [Shopify Partner Dashboard](https://partners.shopify.com/)
2. Välj din Shopify app
3. Gå till **Overview** eller **App setup**
4. Hitta **Client ID** och **Client secret** (eller **API Key** och **API Secret**)

### Steg 2: Lägg till i Vercel

1. Gå till ditt Vercel-projekt: https://vercel.com/dashboard
2. Välj projektet för analytics-plattformen
3. Gå till **Settings** → **Environment Variables**
4. Lägg till följande variabler för **Production** miljön:

```
SHOPIFY_API_KEY=<din_shopify_client_id>
SHOPIFY_API_SECRET=<din_shopify_client_secret>
```

**VIKTIGT:**
- Lägg till dessa för **Production** miljön (inte Preview/Development)
- Om du har separata dev/prod Shopify-appar, lägg till samma variabler även för **Preview** miljön med dev-värden

### Steg 3: Redeploy

Efter att ha lagt till environment variables:

1. Vercel kommer automatiskt att trigga en ny deployment
2. Eller manuellt: Gå till **Deployments** → Välj senaste deployment → Klicka **Redeploy**

### Steg 4: Verifiera

Efter deployment ska Shopify connect-flödet fungera utan `Missing SHOPIFY_API_KEY` fel.

## Varför behövs detta?

Huvudplattformen behöver Shopify API credentials för att:
- Skapa OAuth authorize URL när användare klickar "Connect"
- Verifiera OAuth callback från Shopify
- Byta ut authorization code mot access token

## Var hittar jag credentials?

**I Shopify Partner Dashboard:**
- **Client ID** = `SHOPIFY_API_KEY`
- **Client Secret** = `SHOPIFY_API_SECRET`

Dessa finns under din app's **App setup** → **Client credentials** eller liknande sektion.

## Exempel värden (ska inte användas i produktion)

```bash
SHOPIFY_API_KEY=your_actual_client_id_here
SHOPIFY_API_SECRET=your_actual_client_secret_here
```

## Checklista

- [ ] Shopify app är skapad i Partner Dashboard
- [ ] Client ID och Client Secret är hämtade
- [ ] Environment variables är lagda till i Vercel Production
- [ ] Deployment har körts efter att variablerna lagts till
- [ ] Connect-flödet fungerar utan `Missing SHOPIFY_API_KEY` fel

