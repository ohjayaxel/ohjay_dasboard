# Google Ads Sync Architecture - Design Document
## Framtidssäker, robust implementation för operativt BI-verktyg

### Current State Analysis

#### Problem identifierade:
1. **För låg frekvens**: Vercel cron körs bara 1x/dag (03:15 UTC) - otillräckligt för realtidsdata
2. **Ingen redundans**: Saknar Supabase pg_cron (Meta har både Vercel + pg_cron)
3. **EndDate-problem**: Default mode försöker synca data för "idag", men Google Ads API har 24-48h fördröjning
4. **Ingen tracking**: Default mode sparar inte `last_synced_at` eller `last_synced_range` för inkrementella syncs
5. **Ingen overlap**: Ingen re-sync av senaste dagarna för att fånga uppdaterad data

#### Vad fungerar bra (jämfört med Meta):
- Edge Function struktur och error handling
- Currency support
- MCC account hantering
- Job logging

---

## Proposed Architecture

### 1. Dual-Cron Strategy (Redundans)

**Vercel Cron:**
- Frekvens: `"0 * * * *"` (varje timme) - samma som Meta/Shopify
- Tidpunkt: 5 minuter förbi timmen (t.ex. 00:05, 01:05) för att undvika konflikter
- Backup-strategi om Supabase pg_cron misslyckas

**Supabase pg_cron:**
- Fil: `supabase/sql/google_ads_sync_schedule.sql` (liknande Meta/Shopify)
- Frekvens: Varje timme, 10 minuter förbi (t.ex. 00:10, 01:10)
- Backup-strategi om Vercel cron misslyckas
- Körs direkt mot Edge Function (ingen dependency på Next.js API)

**Rationale:** Dubbel redundans säkerställer att sync körs även om en plattform har problem.

---

### 2. Smart Date Window Management

**Inkrementell Sync Strategy:**
```
StartDate = max(
  (today - INCREMENTAL_WINDOW_DAYS + 1),  // Last 30 days
  (last_synced_range.until - OVERLAP_DAYS),  // Re-sync senaste 3 dagarna med overlap
  sync_start_date  // Tenant-specific start date
)

EndDate = today - API_LATENCY_DAYS  // Default: 2 dagar bakåt för att hantera API-fördröjning
```

**Konstanter:**
- `INCREMENTAL_WINDOW_DAYS = 30` (senaste 30 dagarna)
- `OVERLAP_DAYS = 3` (re-sync senaste 3 dagarna för att fånga uppdaterad data)
- `API_LATENCY_DAYS = 2` (Google Ads API har 24-48h fördröjning)

**Exempel:**
- Idag: 2025-12-12
- Last sync: 2025-12-10 (until: 2025-12-09)
- **StartDate**: max(2025-12-02, 2025-12-06, sync_start_date) = 2025-12-06 (med 3 dagars overlap)
- **EndDate**: 2025-12-10 (today - 2 dagar)

**Rationale:** 
- Re-sync senaste 3 dagarna säkerställer att vi får uppdaterad data (attribution windows, conversions, etc.)
- EndDate 2 dagar bakåt undviker att försöka synca ofullständiga data

---

### 3. Connection Meta Tracking (Inkrementell Sync)

**Spara efter varje lyckad sync:**
```typescript
connection.meta = {
  ...existingMeta,
  last_synced_at: finishedAt,  // ISO timestamp
  last_synced_range: {
    since: startDate,  // 'YYYY-MM-DD'
    until: endDate,    // 'YYYY-MM-DD'
  },
  last_synced_success: true,
  last_synced_rows: insertedRows,
}
```

**Användning i nästa sync:**
- Läsa `last_synced_range.until`
- Starta från `until - OVERLAP_DAYS` för overlap
- Om ingen last_synced_range finns, använd `today - INCREMENTAL_WINDOW_DAYS`

**Rationale:** Möjliggör smart inkrementell syncing och undviker att synca för mycket data varje gång.

---

### 4. Error Handling & Resilience

**Retry Strategy:**
- Edge Function har redan retry-logik för API-fel (429, 5xx)
- Job logging säkerställer att fel spåras

**Stuck Job Cleanup:**
- Redan implementerat i `/api/jobs/cleanup-stuck-jobs`
- Körs var 30:e minut via Vercel cron

**Failure Recovery:**
- Om sync misslyckas, nästa sync börjar från samma startDate (ingen last_synced_range uppdateras)
- Efter 3 konsekutiva misslyckanden: alert/logging (TODO: implementera)

---

### 5. Mode System (behålla men förbättra)

**Default Mode (cron):**
- Använder smart date window (se ovan)
- Sparar last_synced_range
- EndDate = today - API_LATENCY_DAYS

**Hourly Mode (för test/framtid):**
- Sync senaste timmen från last_hourly_sync_at
- EndDate = now - 1 hour

**Daily Mode (för test/framtid):**
- Sync senaste dygnet från last_daily_sync_at  
- EndDate = yesterday

**Manual Test Mode:**
- Använd explicit dateFrom/dateTo
- Ingen overlap, exakt range
- Används för debugging

---

### 6. Observability & Monitoring

**Job Logging (redan implementerat):**
- `jobs_log` tabellen spårar alla syncs
- Status: pending, running, succeeded, failed
- Felmeddelanden och timestamps

**Structured Logging:**
- JSON logs för event tracking (redan implementerat)
- Events: sync_start, api_fetch_complete, transformation_complete, database_write_complete, sync_complete, sync_failed

**Metrics att spåra (framtida):**
- Sync frekvens (hur ofta körs sync?)
- Success rate (hur många % lyckas?)
- Latency (hur lång tid tar varje sync?)
- Data freshness (hur gammal är senaste datan?)

---

## Implementation Plan

### Phase 1: Core Sync Logic Improvements
1. ✅ Fix default mode date window (EndDate = today - 2)
2. ✅ Implement last_synced_range tracking i connection.meta
3. ✅ Implement overlap logic (re-sync senaste 3 dagarna)
4. ✅ Uppdatera resolveSyncWindow för default mode

### Phase 2: Scheduling Infrastructure
1. ⏳ Öka Vercel cron frekvens till varje timme
2. ⏳ Skapa Supabase pg_cron schedule (google_ads_sync_schedule.sql)
3. ⏳ Verifiera att båda cron jobs körs korrekt

### Phase 3: Verification & Testing
1. ⏳ Verifiera att syncs faktiskt körs varje timme
2. ⏳ Verifiera att data uppdateras dagligen
3. ⏳ Testa error recovery (simulera fel, verifiera att nästa sync fungerar)

---

## Information som behövs från Supabase/Vercel

### Från Supabase:
1. **pg_cron status:**
   ```sql
   -- Kör i Supabase SQL Editor:
   SELECT * FROM cron.job WHERE jobname LIKE '%google%';
   ```
   **Förväntat:** Inga resultat (inga pg_cron jobs för Google Ads ännu)

2. **Senaste sync körningar:**
   ```sql
   SELECT 
     started_at, 
     finished_at, 
     status, 
     error,
     EXTRACT(EPOCH FROM (finished_at - started_at)) as duration_seconds
   FROM jobs_log 
   WHERE source = 'google_ads' 
     AND tenant_id = '642af254-0c2c-4274-86ca-507398ecf9a0'
   ORDER BY started_at DESC 
   LIMIT 20;
   ```
   **Behövs:** Se när senaste syncs kördes och om de lyckades

3. **Connection meta status:**
   ```sql
   SELECT 
     meta->'last_synced_at' as last_synced_at,
     meta->'last_synced_range' as last_synced_range,
     updated_at
   FROM connections
   WHERE source = 'google_ads'
     AND tenant_id = '642af254-0c2c-4274-86ca-507398ecf9a0';
   ```
   **Behövs:** Se om last_synced tracking redan finns

### Från Vercel:
1. **Cron Jobs status:**
   - Gå till Vercel Dashboard → Project → Settings → Cron Jobs
   - Screenshot eller lista alla cron jobs, speciellt `/api/jobs/sync?source=google_ads`
   - Verifiera att den faktiskt körs (se "Last Run" timestamps)

2. **Deployment logs:**
   - Kontrollera om det finns några fel i Vercel deployment logs för cron triggers

---

## Google Ads API Considerations

### Data Latency:
- Google Ads API har typiskt 24-48 timmars fördröjning för komplett data
- Conversions kan ta ännu längre tid (attribution windows)
- **Rekommendation:** EndDate = today - 2 dagar för att undvika ofullständiga data

### Rate Limits:
- Google Ads API har rate limits per developer token
- Multiple tenants delar samma developer token → risk för rate limiting
- **Redundans:** Med hourly syncs, om en misslyckas pga rate limit, nästa sync kan lyckas

### Data Updates:
- Google Ads data kan uppdateras retroaktivt (t.ex. conversions attribueras senare)
- Attribution windows kan vara 1-30 dagar
- **Overlap:** Re-sync senaste 3 dagarna säkerställer att vi får uppdaterad data

---

## Design Decisions & Trade-offs

### 1. Frekvens: Hourly vs Every 15 minutes
**Beslut:** Hourly
**Rationale:** 
- Google Ads API har fördröjning (24-48h), så 15 minuters frekvens ger ingen fördel
- Hourly balanserar data freshness med API rate limits
- Konsistent med Meta/Shopify syncs

### 2. Overlap: 3 dagar vs 1 dag
**Beslut:** 3 dagar
**Rationale:**
- Google Ads attribution windows kan vara långa
- Conversions attribueras ofta retroaktivt
- 3 dagars overlap säkerställer att vi fångar uppdaterad data

### 3. EndDate: Today - 2 vs Yesterday
**Beslut:** Today - 2 dagar
**Rationale:**
- Google Ads API har 24-48h fördröjning
- Data för "igår" kan fortfarande vara ofullständig
- 2 dagars buffer säkerställer komplett data

### 4. Dual Cron: Vercel + Supabase vs Bara en
**Beslut:** Båda
**Rationale:**
- Redundans är kritisk för operativt BI-verktyg
- Om en plattform har problem, den andra fortsätter
- Meta har redan denna strategi (verifierat)

---

## Success Criteria

### Kort sikt (Efter implementation):
- ✅ Sync körs varje timme (verifiera i jobs_log)
- ✅ Data för "igår" finns tillgänglig inom 24-48 timmar
- ✅ Inga missade syncs (verifiera att både Vercel och pg_cron körs)

### Lång sikt (Operativt BI-verktyg):
- ✅ Data är alltid uppdaterad (max 2 dagars gammal, men synkas varje timme)
- ✅ Inga manuella syncs behövs
- ✅ Automatisk recovery från fel (nästa sync löser problemet)
- ✅ Observability: Kan enkelt se sync status och diagnostisera problem

---

## Open Questions

1. **API Rate Limits:** Har vi några issues med rate limiting när flera tenants syncas samtidigt?
   - **Behövs:** Verifiera i Supabase logs om det finns 429 (rate limit) errors

2. **Edge Function Timeout:** Tar syncs för lång tid för stora tenants?
   - **Current:** Max 60 sekunder (Vercel cron timeout?)
   - **Behövs:** Verifiera faktisk sync-tid i jobs_log

3. **Multi-tenant Concurrency:** Körs syncs parallellt eller sekventiellt?
   - **Current:** Edge Function processar alla tenants sekventiellt
   - **OK:** För nu, men kan bli problem vid skalning

---

## Next Steps

1. **Användaren verifierar Supabase/Vercel status** (se queries ovan)
2. **Review design document** - kommentera/approva
3. **Implementera Phase 1** (Core sync logic)
4. **Implementera Phase 2** (Scheduling)
5. **Verifiera Phase 3** (Testing)

