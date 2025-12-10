/**
 * Test Encryption/Decryption Compatibility
 * 
 * Tests that encryption in Next.js app matches decryption in Edge Function
 * 
 * Usage:
 *   pnpm tsx scripts/test_encryption_decryption.ts
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
  const { encryptSecret, decryptSecret } = await import('@/lib/integrations/crypto');
  const { getSupabaseServiceClient } = await import('@/lib/supabase/server');

  console.log('\n🔐 Encryption/Decryption Compatibility Test');
  console.log('═'.repeat(60));

  // Test 1: Encrypt and decrypt a test string
  console.log('\n📝 Test 1: Encrypt/Decrypt Test String');
  console.log('─'.repeat(60));
  const testString = 'test-token-string-12345';
  try {
    const encrypted = encryptSecret(testString);
    console.log(`  ✅ Encryption successful`);
    console.log(`     Encrypted length: ${encrypted.length} bytes`);
    console.log(`     Format: Buffer (Node.js)`);

    const decrypted = decryptSecret(encrypted);
    console.log(`  ✅ Decryption successful`);
    console.log(`     Decrypted value: ${decrypted}`);
    
    if (decrypted === testString) {
      console.log(`  ✅ Round-trip test PASSED`);
    } else {
      console.log(`  ❌ Round-trip test FAILED`);
      console.log(`     Expected: ${testString}`);
      console.log(`     Got: ${decrypted}`);
    }
  } catch (error) {
    console.log(`  ❌ Encryption/Decryption failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Test 2: Check actual token in database
  console.log('\n📝 Test 2: Check Actual Token in Database');
  console.log('─'.repeat(60));
  const supabase = getSupabaseServiceClient();
  const tenantId = '642af254-0c2c-4274-86ca-507398ecf9a0';

  try {
    const { data: connection, error } = await supabase
      .from('connections')
      .select('access_token_enc, refresh_token_enc, updated_at')
      .eq('tenant_id', tenantId)
      .eq('source', 'google_ads')
      .eq('status', 'connected')
      .maybeSingle();

    if (error) {
      console.log(`  ❌ Error fetching connection: ${error.message}`);
    } else if (!connection) {
      console.log(`  ⚠️  No connection found for tenant ${tenantId}`);
    } else {
      console.log(`  ✅ Connection found`);
      console.log(`     Last updated: ${connection.updated_at}`);

      if (connection.access_token_enc) {
        console.log(`  ✅ access_token_enc exists`);
        console.log(`     Type: ${typeof connection.access_token_enc}`);
        
        if (Buffer.isBuffer(connection.access_token_enc)) {
          console.log(`     Format: Buffer`);
          console.log(`     Length: ${connection.access_token_enc.length} bytes`);
          
          // Try to decrypt
          try {
            const decrypted = decryptSecret(connection.access_token_enc);
            console.log(`  ✅ Decryption from DB successful`);
            console.log(`     Decrypted length: ${decrypted.length} characters`);
            console.log(`     Starts with: ${decrypted.substring(0, 20)}...`);
          } catch (decryptError) {
            console.log(`  ❌ Decryption from DB FAILED`);
            console.log(`     Error: ${decryptError instanceof Error ? decryptError.message : String(decryptError)}`);
            console.log(`     This indicates ENCRYPTION_KEY mismatch!`);
          }
        } else if (typeof connection.access_token_enc === 'string') {
          console.log(`     Format: String`);
          console.log(`     Length: ${connection.access_token_enc.length} characters`);
          console.log(`     First 50 chars: ${connection.access_token_enc.substring(0, 50)}...`);
        } else {
          console.log(`     Format: ${typeof connection.access_token_enc} (unexpected)`);
        }
      } else {
        console.log(`  ⚠️  access_token_enc is null`);
      }
    }
  } catch (error) {
    console.log(`  ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Test 3: Verify ENCRYPTION_KEY format
  console.log('\n📝 Test 3: ENCRYPTION_KEY Format Verification');
  console.log('─'.repeat(60));
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (encryptionKey) {
    const KEY_LENGTH = 32;
    
    // Check how Edge Function would parse it
    if (/^[0-9a-fA-F]+$/.test(encryptionKey) && encryptionKey.length === KEY_LENGTH * 2) {
      console.log(`  ✅ Format: hex (64 hex chars = 32 bytes)`);
      console.log(`     Edge Function will parse as: hex → bytes`);
    } else if (encryptionKey.length === KEY_LENGTH) {
      console.log(`  ⚠️  Format: raw UTF-8 (32 chars)`);
      console.log(`     Edge Function will parse as: UTF-8 → bytes`);
      console.log(`     ⚠️  WARNING: This may not match Edge Function's hex parsing!`);
    } else {
      try {
        const decoded = Buffer.from(encryptionKey, 'base64');
        if (decoded.length === KEY_LENGTH) {
          console.log(`  ⚠️  Format: base64`);
          console.log(`     Edge Function will parse as: base64 → bytes`);
          console.log(`     ⚠️  WARNING: May not match Edge Function's hex parsing!`);
        }
      } catch {
        console.log(`  ❌ Format: unknown/invalid`);
      }
    }
    
    console.log(`     Key preview: ${encryptionKey.substring(0, 10)}...${encryptionKey.substring(encryptionKey.length - 10)}`);
  } else {
    console.log(`  ❌ ENCRYPTION_KEY not found`);
  }

  console.log('\n💡 Summary:');
  console.log('═'.repeat(60));
  console.log('  If decryption from DB failed, it means ENCRYPTION_KEY in Edge Function');
  console.log('  does not match the key used when the token was encrypted.');
  console.log('');
  console.log('  Next steps:');
  console.log('  1. Verify ENCRYPTION_KEY in Supabase Edge Functions Secrets matches local value');
  console.log('  2. Ensure key is in hex format (64 hex chars = 32 bytes)');
  console.log('  3. Redeploy Edge Function after setting secret');
  console.log('  4. Re-authenticate Google Ads to encrypt tokens with correct key');
  console.log('\n' + '═'.repeat(60) + '\n');
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});

