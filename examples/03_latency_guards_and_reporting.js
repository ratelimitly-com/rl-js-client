#!/usr/bin/env node
'use strict';

/**
 * Example 3: Latency Guards and Latency Reporting for Load Shedding
 *
 * Demonstrates:
 * - Protecting downstream databases or services with Latency Guards
 * - If observed latency of a service exceeds the guard threshold, subsequent requests are shed
 * - Asynchronously reporting downstream execution latency back to RateLimitly
 */

const {
  createClient,
  ResourceRequest,
  LatencyGuard,
  ServiceLatencyBlock
} = require('../client');

const authKey = process.env.RATELIMITLY_AUTH_KEY ||
  'rl-none1qqqsyqcyq5rqwzqfggq0x7v4q47r2r0v3qy0p7e3240r3r8q9s8qgq6e4l4';

const client = createClient(authKey);

// 1. Define resources and latency guards
const resources = [
  new ResourceRequest('database_api', 1000, 100, 1)
];

const guards = [
  new LatencyGuard({
    latencyTrackerName: 'primary_db',
    thresholdMs: 150,       // Max acceptable latency (150ms)
    ttlMs: 300000,          // Sample window TTL (5 minutes)
    maxSamples: 32,         // Max moving window samples
    bufferSize: 20,         // Reporting sample buffer size
    minSampleThreshold: 5   // Minimum samples before guard activates
  })
];

console.log('Checking admission with "primary_db" latency guard (threshold: 150ms)...');

client.checkRateLimit(resources, guards, 'demo.checkout.flow', async (err, result) => {
  if (err) {
    console.error('RateLimitly error:', err.message);
    return;
  }

  if (!result.success) {
    console.log('❌ Request denied by rate limiter or latency guard');
    for (const g of result.guardResults) {
      if (!g.passed) {
        console.log(`   Guard '${g.latencyTrackerName}' tripped: current=${g.currentLatencyMs}ms > threshold=${g.thresholdMs}ms`);
      }
    }
    return;
  }

  console.log('✅ Admission granted. Performing simulated downstream database query...');

  const startTime = Date.now();
  // Simulate database query execution
  await new Promise((resolve) => setTimeout(resolve, 85));
  const observedLatencyMs = Date.now() - startTime;

  console.log(`Query completed in ${observedLatencyMs}ms. Reporting latency asynchronously...`);

  // 2. Report actual observed latency back to RateLimitly
  const reportBlock = new ServiceLatencyBlock({
    latencyTrackerName: 'primary_db',
    observedLatency: observedLatencyMs,
    ttlMs: 300000,
    maxSamples: 32,
    bufferSize: 20,
    minSampleThreshold: 5
  });

  client.reportLatency([reportBlock], (reportErr) => {
    if (reportErr) {
      console.warn('Latency report failed:', reportErr.message);
    } else {
      console.log('📊 Latency metric successfully reported.');
    }
  });
});
