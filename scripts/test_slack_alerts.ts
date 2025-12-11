/**
 * Test script for Slack alerting
 * 
 * Tests both check-failure-rate and check-token-health endpoints
 * to verify Slack notifications are working correctly.
 * 
 * Usage:
 *   pnpm tsx scripts/test_slack_alerts.ts <vercel-app-url>
 * 
 * Example:
 *   pnpm tsx scripts/test_slack_alerts.ts https://your-app.vercel.app
 */

const VERCEL_APP_URL = process.argv[2] || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

async function testEndpoint(name: string, path: string) {
  console.log(`\n🧪 Testing ${name}...`);
  console.log(`   URL: ${VERCEL_APP_URL}${path}`);
  
  try {
    const response = await fetch(`${VERCEL_APP_URL}${path}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    
    console.log(`   Status: ${response.status} ${response.statusText}`);
    console.log(`   Response:`, JSON.stringify(data, null, 2));

    if (response.ok) {
      console.log(`   ✅ ${name} endpoint responded successfully`);
      
      // Check if there are any alerts
      if (data.status === 'alert' || data.status === 'warning') {
        console.log(`   ⚠️  Alerts/Warnings detected - check Slack channel!`);
        if (data.high_failure_rate && data.high_failure_rate.length > 0) {
          console.log(`   📊 High failure rate alerts: ${data.high_failure_rate.length}`);
        }
        if (data.consecutive_failures && data.consecutive_failures.length > 0) {
          console.log(`   🔴 Consecutive failures: ${data.consecutive_failures.length}`);
        }
        if (data.warnings && data.warnings.length > 0) {
          console.log(`   ⏰ Token expiration warnings: ${data.warnings.length}`);
        }
        if (data.expiring_tokens && data.expiring_tokens.length > 0) {
          console.log(`   🔑 Expiring tokens: ${data.expiring_tokens.length}`);
        }
      } else {
        console.log(`   ✅ No alerts/warnings - system is healthy!`);
      }
    } else {
      console.log(`   ❌ ${name} endpoint returned error`);
    }

    return { success: response.ok, data };
  } catch (error) {
    console.error(`   ❌ Error testing ${name}:`, error);
    return { success: false, error };
  }
}

async function main() {
  console.log('🚀 Testing Slack Alerting Setup\n');
  console.log(`📡 Using app URL: ${VERCEL_APP_URL}`);
  console.log(`🔗 Make sure SLACK_WEBHOOK_URL is configured in Vercel environment variables\n`);

  // Test check-failure-rate
  const failureRateResult = await testEndpoint(
    'check-failure-rate',
    '/api/jobs/check-failure-rate'
  );

  // Wait a bit between requests
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Test check-token-health
  const tokenHealthResult = await testEndpoint(
    'check-token-health',
    '/api/jobs/check-token-health'
  );

  // Summary
  console.log('\n📊 TEST SUMMARY');
  console.log('─────────────────────────────────────────');
  console.log(`check-failure-rate: ${failureRateResult.success ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`check-token-health:  ${tokenHealthResult.success ? '✅ PASSED' : '❌ FAILED'}`);
  
  if (failureRateResult.success && tokenHealthResult.success) {
    console.log('\n✅ All endpoints are working correctly!');
    console.log('\n💡 Next steps:');
    console.log('   1. Check your Slack channel for any alerts (if there were failures/warnings)');
    console.log('   2. If no alerts appeared but endpoints worked, system is healthy!');
    console.log('   3. You can also test with real failures by triggering a failed sync');
  } else {
    console.log('\n❌ Some endpoints failed. Check the errors above.');
  }
}

main().catch(console.error);

