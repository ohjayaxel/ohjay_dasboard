#!/usr/bin/env node
const keys = [
  'APP_ENV',
  'APP_BASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ENCRYPTION_KEY',
  'SENTRY_DSN'
];

const mask = (value) => {
  if (!value) return '<missing>';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}… (${value.length} chars)`;
};

console.log('Environment summary');
console.log('-------------------');
keys.forEach((key) => {
  const value = process.env[key];
  const output = key.includes('URL') || key === 'APP_ENV' ? (value || '<missing>') : mask(value);
  console.log(`${key}: ${output}`);
});
