const { createClient } = require('@supabase/supabase-js')

async function verifyKpi() {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  )

  const tenant = 'fa6a78a8-557b-4687-874d-261236d78ac1'
  const today = new Date()
  const startWindow = new Date(today)
  startWindow.setDate(startWindow.getDate() - 29)
  const from = startWindow.toISOString().slice(0, 10)
  const to = today.toISOString().slice(0, 10)

  console.log('Checking kpi_daily for date range:', from, 'to', to)
  
  const { data, error } = await client
    .from('kpi_daily')
    .select('date,spend,clicks,conversions,revenue')
    .eq('tenant_id', tenant)
    .eq('source', 'meta')
    .gte('date', from)
    .lte('date', to)
    .order('date', { ascending: false })
    .limit(10)

  if (error) {
    console.error('Error:', error)
    process.exit(1)
  }

  console.log('\nLatest 10 dates in kpi_daily:')
  data.forEach((r) => {
    const hasValues = r.spend !== null || r.clicks !== null || r.conversions !== null || r.revenue !== null
    console.log(
      `${r.date}: spend=${r.spend}, clicks=${r.clicks}, conversions=${r.conversions}, revenue=${r.revenue} ${hasValues ? '✅' : '❌ NULL VALUES'}`
    )
  })

  const latestDate = data[0]?.date
  console.log('\nLatest date:', latestDate)
  
  if (latestDate !== to.slice(0, 10)) {
    console.log(`⚠️  Warning: Latest date (${latestDate}) does not match today (${to})`)
  } else {
    console.log('✅ Latest date matches today')
  }
}

verifyKpi().catch(console.error)

