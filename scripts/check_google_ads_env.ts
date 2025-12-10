#!/usr/bin/env tsx

/**
 * Script to verify Google Ads environment variables are configured correctly
 */

function loadEnvFile() {
  const fs = require('fs');
  const path = require('path');
  
  // Try loading from env/local.prod.sh first
  const envShPath = path.join(process.cwd(), 'env', 'local.prod.sh');
  if (fs.existsSync(envShPath)) {
    const content = fs.readFileSync(envShPath, 'utf-8');
    content.split('\n').forEach((line: string) => {
      const match = line.match(/^export\s+(\w+)="?([^"]+)"?$/);
      if (match) {
        const [, key, value] = match;
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    });
  }
  
  // Fallback to .env.local
  const envLocalPath = path.join(process.cwd(), '.env.local');
  if (fs.existsSync(envLocalPath)) {
    const content = fs.readFileSync(envLocalPath, 'utf-8');
    content.split('\n').forEach((line: string) => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const [, key, value] = match;
        const trimmedKey = key.trim();
        const trimmedValue = value.trim().replace(/^["']|["']$/g, '');
        if (!process.env[trimmedKey]) {
          process.env[trimmedKey] = trimmedValue;
        }
      }
    });
  }
}

loadEnvFile();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_DEVELOPER_TOKEN = process.env.GOOGLE_DEVELOPER_TOKEN;
const APP_BASE_URL = process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

console.log('\n🔍 Google Ads Environment Variables Check\n');

const checks = [
  {
    name: 'GOOGLE_CLIENT_ID',
    value: GOOGLE_CLIENT_ID,
    required: true,
    mask: true,
    description: 'OAuth Client ID från Google Cloud Console',
  },
  {
    name: 'GOOGLE_CLIENT_SECRET',
    value: GOOGLE_CLIENT_SECRET,
    required: true,
    mask: true,
    description: 'OAuth Client Secret från Google Cloud Console',
  },
  {
    name: 'GOOGLE_DEVELOPER_TOKEN',
    value: GOOGLE_DEVELOPER_TOKEN,
    required: false,
    mask: true,
    description: 'Developer Token från Google Ads API Center (krävs för API-anrop)',
  },
  {
    name: 'APP_BASE_URL / NEXT_PUBLIC_BASE_URL',
    value: APP_BASE_URL,
    required: true,
    mask: false,
    description: 'Base URL för OAuth redirects',
  },
];

let allRequired = true;
let hasWarnings = false;

checks.forEach((check) => {
  const exists = !!check.value;
  const status = check.required ? (exists ? '✅' : '❌') : (exists ? '✅' : '⚠️');
  
  if (check.required && !exists) {
    allRequired = false;
  } else if (!check.required && !exists) {
    hasWarnings = true;
  }
  
  const displayValue = check.mask && check.value
    ? `${check.value.substring(0, 8)}...${check.value.substring(check.value.length - 4)}`
    : check.value || '(not set)';
  
  console.log(`${status} ${check.name}`);
  console.log(`   Value: ${displayValue}`);
  console.log(`   ${check.description}`);
  console.log('');
});

// Calculate expected redirect URI
const redirectUri = `${APP_BASE_URL}/api/oauth/googleads/callback`;
console.log('📋 OAuth Redirect URI:');
console.log(`   ${redirectUri}\n`);
console.log('   ⚠️  Se till att denna URI är lagd till i Google Cloud Console:');
console.log('   https://console.cloud.google.com/apis/credentials\n');

if (!allRequired) {
  console.log('❌ Vissa obligatoriska variabler saknas!');
  console.log('   OAuth-kopplingen kommer inte fungera.\n');
  process.exit(1);
}

if (hasWarnings) {
  console.log('⚠️  Vissa valfria variabler saknas:');
  console.log('   - GOOGLE_DEVELOPER_TOKEN saknas → API-anrop kommer returnera mock-data');
  console.log('   - OAuth-kopplingen fungerar fortfarande, men faktisk synkronisering kräver token\n');
}

if (allRequired && !hasWarnings) {
  console.log('✅ Alla miljövariabler är korrekt konfigurerade!\n');
}

