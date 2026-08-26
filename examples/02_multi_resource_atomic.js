#!/usr/bin/env node
'use strict';

/**
 * Example 2: Multi-Resource Atomic Rate Checks
 *
 * Demonstrates:
 * - Checking multiple distinct rate limits atomically in a single roundtrip
 * - Example: Global API quota + Per-user quota + Per-organization quota
 * - If ANY resource quota is exceeded, the request is denied as a whole.
 */

const { createClient, ResourceRequest } = require('../client');

const authKey = process.env.RATELIMITLY_AUTH_KEY ||
  'rl-none1qqqsyqcyq5rqwzqfggq0x7v4q47r2r0v3qy0p7e3240r3r8q9s8qgq6e4l4';

const client = createClient(authKey);

// Atomic multi-resource check:
// 1. Global API rate limit: 10,000 req / minute
// 2. User tier rate limit: 50 req / second
// 3. Organization burst limit: 200 req / 10 seconds
const userId = 'user_12345';
const orgId = 'org_enterprise';

const resources = [
  new ResourceRequest('global_api_traffic', 60000, 10000, 1),
  new ResourceRequest(`user:${userId}:requests`, 1000, 50, 1),
  new ResourceRequest(`org:${orgId}:burst`, 10000, 200, 1)
];

console.log(`Checking 3 resources atomically for user=${userId}, org=${orgId}...`);

client.checkRateLimit(resources, (err, result) => {
  if (err) {
    console.error('Check failed:', err.message);
    return;
  }

  if (result.success) {
    console.log('✅ All resource checks passed atomically!');
  } else {
    console.log('❌ Request denied. Resource breakdown:');
    for (const r of result.resourceResults) {
      const status = r.tokensDeficit === 0 ? 'PASS' : `EXCEEDED (deficit: ${r.tokensDeficit})`;
      console.log(`   - ${r.bucketName}: ${status} (current rate: ${r.actualRate})`);
    }
  }
});
