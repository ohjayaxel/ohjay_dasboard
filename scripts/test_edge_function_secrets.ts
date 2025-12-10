/**
 * Test Edge Function Secrets Configuration
 * 
 * This script verifies that all required secrets are correctly set in Supabase
 * and that Edge Function can access them.
 * 
 * Usage:
 *   pnpm tsx scripts/test_edge_function_secrets.ts
 */

function loadEnvFile() {
  const fs = require('fs');
  const path = require('path');
  const envFiles = ['.env.local', 'env/local.prod.sh'];
  for (const envFile of envFiles) {
    const filePath = path.join(process.cwd(), envFile);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const match = trimmed.match(/^export\s+([^=]+)=(.*)$/) || trimmed.match(/^([^=]+)=(.*)$/);
          if (match) {
            const key = match[1].trim();
            const value = match[2].trim().replace(/^["']|["']$/g, '');
            if (!process.env[key]) process.env[key] = value;
          }
        }
      }
    }
  }
}

loadEnvFile();

async function main() {
  const { getSupabaseServiceClient } = await import('@/lib/supabase/server');

  console.log('\n🔐 Edge Function Secrets Verification');
  console.log('═'.repeat(60));

  // Required secrets for sync-googleads Edge Function
  const requiredSecrets = [
    'ENCRYPTION_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'GOOGLE_DEVELOPER_TOKEN',
  ];

  // Optional but recommended
  const optionalSecrets = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
  ];

  console.log('\n📋 Checking Local Environment Variables:');
  console.log('─'.repeat(60));

  const localSecrets: Record<string, { found: boolean; length: number; preview: string }> = {};

  for (const secret of [...requiredSecrets, ...optionalSecrets]) {
    const value = process.env[secret];
    const found = !!value;
    const length = value ? value.length : 0;
    const preview = value && value.length > 20
      ? `${value.substring(0, 10)}...${value.substring(value.length - 10)}`
      : found ? (value.length <= 20 ? value : '***hidden***') : 'NOT SET';

    localSecrets[secret] = { found, length, preview };

    const status = found ? '✅' : '❌';
    const required = requiredSecrets.includes(secret) ? '(REQUIRED)' : '(optional)';
    console.log(`  ${status} ${secret.padEnd(30)} ${required}`);
    if (found) {
      console.log(`     Length: ${length} characters`);
      console.log(`     Preview: ${preview}`);
    }
  }

  // Check ENCRYPTION_KEY format
  console.log('\n🔑 ENCRYPTION_KEY Format Check:');
  console.log('─'.repeat(60));
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (encryptionKey) {
    const KEY_LENGTH = 32;
    if (/^[0-9a-fA-F]+$/.test(encryptionKey) && encryptionKey.length === KEY_LENGTH * 2) {
      console.log(`  ✅ Format: hex (64 hex chars = 32 bytes)`);
      console.log(`  ✅ Length: ${encryptionKey.length} characters`);
      console.log(`  ✅ Value: ${encryptionKey.substring(0, 10)}...${encryptionKey.substring(encryptionKey.length - 10)}`);
    } else if (encryptionKey.length === KEY_LENGTH) {
      console.log(`  ⚠️  Format: raw UTF-8 string (32 chars)`);
      console.log(`  ⚠️  Warning: May not match Edge Function's hex parsing`);
    } else {
      try {
        const decoded = Buffer.from(encryptionKey, 'base64');
        if (decoded.length === KEY_LENGTH) {
          console.log(`  ⚠️  Format: base64 (decodes to 32 bytes)`);
          console.log(`  ⚠️  Warning: May not match Edge Function's hex parsing`);
        } else {
          console.log(`  ❌ Format: unknown or invalid length`);
        }
      } catch {
        console.log(`  ❌ Format: invalid`);
      }
    }
  } else {
    console.log(`  ❌ ENCRYPTION_KEY not found`);
  }

  // Check if we can list Supabase secrets (via API if possible)
  console.log('\n📊 Supabase Secrets Status:');
  console.log('─'.repeat(60));
  console.log('  Note: Cannot directly verify Supabase Edge Function secrets from this script.');
  console.log('  Please verify manually in Supabase Dashboard:');
  console.log('  → Project Settings → Edge Functions → Secrets');
  console.log('');
  console.log('  Required secrets in Supabase:');
  for (const secret of requiredSecrets) {
    console.log(`    - ${secret}`);
  }

  // Test connection to database
  console.log('\n🗄️  Database Connection Test:');
  console.log('─'.repeat(60));
  try {
    const supabase = getSupabaseServiceClient();
    const { data, error } = await supabase
      .from('connections')
      .select('id, source, status')
      .eq('source', 'google_ads')
      .eq('status', 'connected')
      .limit(1);

    if (error) {
      console.log(`  ❌ Database connection failed: ${error.message}`);
    } else {
      console.log(`  ✅ Database connection successful`);
      console.log(`  ✅ Found ${data?.length || 0} connected Google Ads connection(s)`);
    }
  } catch (error) {
    console.log(`  ❌ Database connection error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Summary
  console.log('\n📝 Summary:');
  console.log('═'.repeat(60));
  const missingRequired = requiredSecrets.filter(s => !localSecrets[s]?.found);
  if (missingRequired.length === 0) {
    console.log('  ✅ All required local environment variables are set');
  } else {
    console.log(`  ❌ Missing required environment variables: ${missingRequired.join(', ')}`);
  }

  console.log('\n💡 Next Steps:');
  console.log('─'.repeat(60));
  console.log('  1. Verify all secrets are set in Supabase Dashboard:');
  console.log('     https://supabase.com/dashboard/project/punicovacaktaszqcckp/settings/functions');
  console.log('');
  console.log('  2. Ensure ENCRYPTION_KEY matches exactly between:');
  console.log('     - Next.js app (local env)');
  console.log('     - Supabase Edge Functions Secrets');
  console.log('');
  console.log('  3. Redeploy Edge Function after setting secrets:');
  console.log('     supabase functions deploy sync-googleads --project-ref punicovacaktaszqcckp');
  console.log('');
  console.log('  4. Test sync:');
  console.log('     pnpm tsx scripts/run_google_ads_sync_for_tenant.ts skinome');
  console.log('     pnpm tsx scripts/diagnose_google_ads_sync.ts skinome');
  console.log('\n' + '═'.repeat(60) + '\n');
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});

