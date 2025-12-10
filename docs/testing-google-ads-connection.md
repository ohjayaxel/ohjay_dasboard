# Testing Google Ads Connection

## Lokal testning

### Steg 1: Starta lokal server

```bash
pnpm dev
```

Server startar på: `http://localhost:3000`

### Steg 2: Hitta din tenant slug

1. Gå till admin-sidan: `http://localhost:3000/admin`
2. Hitta din tenant i listan
3. Notera tenant slug (t.ex. `skinome`)

### Steg 3: Öppna integrations-sidan

Navigera till:
```
http://localhost:3000/admin/tenants/[din-tenant-slug]/integrations
```

Exempel:
```
http://localhost:3000/admin/tenants/skinome/integrations
```

### Steg 4: Testa Google Ads-kopplingen

1. **Hitta Google Ads-sektionen** på integrations-sidan
2. **Klicka på "Connect Google Ads"**
3. **Du kommer redirectas till Google:**
   - Logga in med ditt Google-konto
   - Godkänn app-permissions
   - Du kommer redirectas tillbaka till integrations-sidan

4. **Efter lyckad koppling:**
   - Status ändras till "Connected"
   - Customer ID visas (om tillgängligt)
   - Initial sync triggas automatiskt

5. **Verifiera i databasen:**
   - Kontrollera `connections` tabellen i Supabase
   - Kontrollera `jobs_log` för sync-jobb

## Production testning

### Steg 1: Öppna production/admin-sidan

Gå till:
```
https://din-production-domain.com/admin
```

### Steg 2: Följ samma steg som lokalt

1. Hitta din tenant
2. Gå till integrations-sidan
3. Klicka på "Connect Google Ads"
4. Följ OAuth-flowet

### Viktigt för Production:

- **Redirect URI måste matcha exakt:**
  - I Google Cloud Console, lägg till:
    `https://din-production-domain.com/api/oauth/googleads/callback`

- **Vercel Environment Variables:**
  - Kontrollera att alla `GOOGLE_*` variabler är satta i Vercel Production

## Felsökning

### OAuth redirect error

**Problem:** "redirect_uri_mismatch"

**Lösning:**
1. Gå till [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Öppna din OAuth 2.0 Client ID
3. Lägg till exakt redirect URI:
   - Lokalt: `http://localhost:3000/api/oauth/googleads/callback`
   - Production: `https://din-domain.com/api/oauth/googleads/callback`

### Token exchange failed

**Problem:** OAuth callback misslyckas

**Lösning:**
1. Kontrollera att `GOOGLE_CLIENT_SECRET` är korrekt
2. Kontrollera att redirect URI matchar exakt
3. Kontrollera Vercel logs för detaljerade felmeddelanden

### Connection status visar "Error"

**Problem:** Anslutningen misslyckas efter OAuth

**Lösning:**
1. Kontrollera Supabase logs för connection errors
2. Verifiera att `ENCRYPTION_KEY` är korrekt i både lokalt och Vercel
3. Testa att decrypta token manuellt

### Sync fungerar inte

**Problem:** Inga data synkas från Google Ads

**Lösning:**
1. Kontrollera att `GOOGLE_DEVELOPER_TOKEN` är satt
2. Kontrollera `jobs_log` tabellen för sync-jobb status
3. Verifiera att customer account har data
4. Kontrollera Vercel cron-jobb körs (för automatisk sync)

## Verifiering efter koppling

### 1. Kontrollera connection i Supabase

```sql
SELECT 
  id, 
  tenant_id, 
  source, 
  status, 
  expires_at,
  created_at,
  updated_at
FROM connections
WHERE source = 'google_ads'
ORDER BY updated_at DESC;
```

### 2. Kontrollera sync-jobb

```sql
SELECT 
  id,
  tenant_id,
  source,
  status,
  started_at,
  finished_at,
  error
FROM jobs_log
WHERE source = 'google_ads'
ORDER BY started_at DESC
LIMIT 10;
```

### 3. Testa API-endpoint manuellt

```bash
# Testa health check
curl https://din-domain.com/api/jobs/health?source=google_ads

# Testa sync trigger (kräver auth)
curl -X GET https://din-domain.com/api/jobs/sync?source=google_ads
```

## Förväntade resultat

Efter lyckad koppling bör du se:

1. ✅ Connection status: "Connected" i integrations-sidan
2. ✅ Job log entry med status "succeeded" 
3. ✅ Data i `google_insights_daily` tabellen (efter sync körs)
4. ✅ Data i `kpi_daily` tabellen med `source='google_ads'`

## Ytterligare testning

När kopplingen fungerar kan du:

1. **Testa disconnect:** Klicka på "Disconnect" och verifiera att connection tas bort
2. **Testa reconnect:** Koppla igen och verifiera att det fungerar
3. **Testa token refresh:** Vänta tills token närmar sig expiration och verifiera att refresh fungerar automatiskt


