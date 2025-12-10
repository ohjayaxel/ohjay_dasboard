/**
 * Test Token Decryption from Database
 * 
 * Tries to decrypt the actual token from database to verify ENCRYPTION_KEY works
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
  const { decryptSecret } = await import('@/lib/integrations/crypto');
  const { getSupabaseServiceClient } = await import('@/lib/supabase/server');

  console.log('\n🔐 Token Decryption Test from Database');
  console.log('═'.repeat(60));

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

    if (error || !connection) {
      console.error('❌ Failed to fetch connection:', error?.message);
      process.exit(1);
    }

    console.log(`✅ Connection found, updated: ${connection.updated_at}`);

    if (!connection.access_token_enc) {
      console.error('❌ No access_token_enc found');
      process.exit(1);
    }

    console.log(`\n📦 Token format in DB:`);
    console.log(`   Type: ${typeof connection.access_token_enc}`);
    
    let tokenData: any = connection.access_token_enc;
    
    // If it's a string that starts with \x, it might be a hex-encoded string
    if (typeof tokenData === 'string') {
      console.log(`   Length: ${tokenData.length} chars`);
      console.log(`   First 100 chars: ${tokenData.substring(0, 100)}`);
      
      // Try to parse if it's JSON
      if (tokenData.startsWith('{') || tokenData.startsWith('\\x')) {
        try {
          // If it starts with \x, it might be escaped hex that contains JSON
          if (tokenData.startsWith('\\x')) {
            console.log(`   ⚠️  Token starts with \\x - this is hex-encoded string`);
            // Remove \x prefix and decode
            const hexString = tokenData.replace(/^\\x/, '');
            const decodedHex = Buffer.from(hexString, 'hex');
            console.log(`   ✅ Decoded from hex to string, length: ${decodedHex.length} bytes`);
            
            // Try to parse as JSON if it contains Buffer JSON
            try {
              const jsonString = decodedHex.toString('utf8');
              if (jsonString.startsWith('{') && jsonString.includes('"type":"Buffer"')) {
                const parsed = JSON.parse(jsonString);
                if (parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
                  tokenData = Buffer.from(parsed.data);
                  console.log(`   ✅ Parsed nested JSON Buffer format, length: ${tokenData.length} bytes`);
                } else {
                  tokenData = decodedHex;
                }
              } else {
                tokenData = decodedHex;
              }
            } catch {
              tokenData = decodedHex;
            }
          } else {
            // Try JSON parse
            const parsed = JSON.parse(tokenData);
            if (parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
              tokenData = Buffer.from(parsed.data);
              console.log(`   ✅ Parsed JSON Buffer format, length: ${tokenData.length} bytes`);
            }
          }
        } catch (parseError) {
          console.log(`   ⚠️  Could not parse as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        }
      }
    }

    // Try to decrypt
    console.log(`\n🔓 Attempting decryption...`);
    try {
      const decrypted = decryptSecret(tokenData);
      console.log(`   ✅ DECRYPTION SUCCESSFUL!`);
      console.log(`   ✅ Decrypted token length: ${decrypted.length} characters`);
      console.log(`   ✅ Token starts with: ${decrypted.substring(0, 20)}...`);
      console.log(`\n   This means ENCRYPTION_KEY is CORRECT and token can be decrypted!`);
    } catch (decryptError) {
      console.log(`   ❌ DECRYPTION FAILED!`);
      console.log(`   Error: ${decryptError instanceof Error ? decryptError.message : String(decryptError)}`);
      console.log(`\n   This means ENCRYPTION_KEY mismatch or token format issue.`);
      console.log(`   Next steps:`);
      console.log(`   1. Verify ENCRYPTION_KEY in Supabase Edge Functions Secrets`);
      console.log(`   2. Ensure key matches: f1a2c3d4e5f60718293a4b5c6d7e8f90abcdeffedcba0987654321fedcba0123`);
      console.log(`   3. Re-authenticate Google Ads after verifying secret`);
    }

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }

  console.log('\n' + '═'.repeat(60) + '\n');
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});

