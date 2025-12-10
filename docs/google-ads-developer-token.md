# Google Ads Developer Token - Guide

## Vad är Developer Token?

`GOOGLE_DEVELOPER_TOKEN` är en token som krävs för att göra API-anrop till Google Ads API. Det är **inte** samma sak som OAuth credentials (Client ID/Secret).

- **OAuth credentials** → Används för att autentisera användare och få access tokens
- **Developer Token** → Används i varje API-anrop för att identifiera din applikation

## Hur får jag Developer Token?

### Steg 1: Skapa/Logga in på Google Ads Manager-konto

1. Gå till [Google Ads](https://ads.google.com)
2. Du behöver ett **Manager-konto** (MCC - My Client Center)
   - Om du inte har ett: Skapa via [Google Ads Manager](https://ads.google.com/aw/createaccount)
   - Detta konto hanterar dina Google Ads-konton

### Steg 2: Ansök om Developer Token

1. Logga in på ditt Google Ads Manager-konto
2. Gå till [API Center](https://ads.google.com/aw/apicenter)
3. Klicka på "Apply for API access" eller liknande
4. Fyll i formuläret:
   - **Company name**: Ditt företagsnamn
   - **Website**: Din fungerande webbplats
   - **Application name**: Namn på din applikation (t.ex. "Ohjay Dashboard")
   - **Description**: Beskrivning av vad applikationen gör
   - **Contact email**: E-postadress som övervakas regelbundet
   - **Production usage**: Beskriv din användning av API:et

5. Acceptera villkoren och skicka in ansökan

### Steg 3: Vänta på godkännande

Efter ansökan kommer din token att visas i API Center med en av dessa statusar:

- **Explorer Access** (Godkänd):
  - Du kan göra API-anrop mot produktionskonton
  - Vissa begränsningar kan gälla (t.ex. rate limits)
  - Token visas direkt i API Center

- **Test Account Access** (Väntar på godkännande):
  - Du kan endast använda API:et mot testkonton
  - Behöver vänta på fullt godkännande (kan ta några dagar)

- **Pending** (Under granskning):
  - Google granskar din ansökan
  - Kan ta 1-7 dagar

### Steg 4: Kopiera Developer Token

När din token är godkänd:

1. Gå tillbaka till [API Center](https://ads.google.com/aw/apicenter)
2. Din Developer Token visas där
3. Kopiera token (det är en alfanumerisk sträng)

## Viktigt att veta

⚠️ **Token kan avslutas om oanvänd**:
- Om token inte används i 3 på varandra följande månader kan Google avsluta den
- Se till att din applikation gör regelbundna API-anrop

🔒 **Säkerhet**:
- Behandla Developer Token som ett lösenord
- Dela det aldrig via osäkra kanaler
- Spara det i miljövariabler (inte i kod)

🧪 **Testning utan Developer Token**:
- OAuth-kopplingen fungerar utan Developer Token
- Du kan testa anslutningsflödet innan token är godkänd
- API-anrop kommer returnera mock-data tills token är satt

## Konfiguration

När du har din Developer Token, lägg till den i:

1. **Lokalt**: `.env.local`
   ```bash
   GOOGLE_DEVELOPER_TOKEN="din-token-här"
   ```

2. **Vercel**: Settings → Environment Variables
   - Lägg till för både **Production** och **Preview**

## Verifiering

När token är konfigurerad, verifiera att den fungerar:

```bash
# Testa att credentials finns
pnpm tsx scripts/check_google_ads_env.ts
```

eller testa via integrations-sidan:
1. Koppla Google Ads-konto
2. Kontrollera att sync fungerar (om du har test-konto)

## Länkar

- [Google Ads API Center](https://ads.google.com/aw/apicenter)
- [Google Ads API Dokumentation](https://developers.google.com/google-ads/api/docs/start)
- [API Access Requirements](https://developers.google.com/google-ads/api/docs/get-started/dev-token)


