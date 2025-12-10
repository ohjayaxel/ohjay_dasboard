# Kör Test-Scripts

## Förutsättningar

Scripten behöver miljövariabler för att ansluta till Supabase. Du kan antingen:

### Alternativ 1: Exportera variabler manuellt (Snabbaste)
```bash
export NEXT_PUBLIC_SUPABASE_URL="din-supabase-url"
export SUPABASE_SERVICE_ROLE_KEY="din-service-role-key"
```

### Alternativ 2: Skapa env-fil
Skapa `.env.local` i root-katalogen med:
```bash
NEXT_PUBLIC_SUPABASE_URL=din-supabase-url
SUPABASE_SERVICE_ROLE_KEY=din-service-role-key
```

### Alternativ 3: Kopiera example-fil
```bash
cp env/local.prod.sh.example env/local.prod.sh
# Redigera sedan env/local.prod.sh och lägg till dina värden
```

## Kör Test-Scripts

### 1. Backfill (för att populera data)
```bash
cd /Users/axelsamuelson/.cursor/worktrees/chadcn-dashboard/dih
pnpm tsx scripts/shopify_backfill.ts --tenant=skinome --since=2025-11-28 --until=2025-11-30
```

### 2. Verifiera Shopify Mode
```bash
pnpm tsx scripts/verify_shopify_mode.ts --tenant=skinome --dates=2025-11-28,2025-11-29,2025-11-30
```

### 3. Jämför båda modes
```bash
pnpm tsx scripts/compare_modes.ts --tenant=skinome --from=2025-11-28 --to=2025-11-30
```

## Tips

- Om du kör från production-miljön där variablerna redan finns i shell, behöver du bara köra kommandona direkt
- Script hittar automatiskt `.env.local` om den finns
- Om variablerna saknas får du ett tydligt felmeddelande



