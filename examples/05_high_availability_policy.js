#!/usr/bin/env node
'use strict';

/**
 * Example 5: High Availability & Custom Retry Policies
 *
 * Demonstrates:
 * - Configuring RequestPolicy and HaSchedule
 * - Fixed, Linear, and Exponential retry gap schedules
 * - Controlling dedup horizon, timeout, and completion delivery
 */

const {
  createClient,
  RequestPolicy,
  HaSchedule,
  ResourceRequest
} = require('../client');

const authKey = process.env.RATELIMITLY_AUTH_KEY ||
  'rl-none1qqqsyqcyq5rqwzqfggq0x7v4q47r2r0v3qy0p7e3240r3r8q9s8qgq6e4l4';

// Configure a High-Availability policy with exponential backoff retry rounds:
// - unitMs: Base scheduling quantum (e.g. 20ms)
// - replayCount: Send up to 2 replay datagrams if no response arrives
// - replayGap: Exponential schedule (initial 1 unit, factor 2, max 4 units)
// - finalReceiveUnits: Extra receive-only interval at the end
// - completionDelivery: Deliver admission result to missing servers before returning
const customPolicy = new RequestPolicy({
  unitMs: 20,
  replayCount: 2,
  replayGap: HaSchedule.exponential(1, 2, 4),
  finalReceiveUnits: 1,
  completionDelivery: true
});

console.log('Custom Request Policy:');
console.log(`- Base Unit: ${customPolicy.unitMs}ms`);
console.log(`- Replay Count: ${customPolicy.replayCount}`);
console.log(`- Schedule: ${customPolicy.replayGap.kind} (initial=${customPolicy.replayGap.initialUnits}, max=${customPolicy.replayGap.maxUnits})`);
console.log(`- Calculated Policy Horizon: ${customPolicy.horizonMs()}ms`);

// Initialize client with custom HA options
const client = createClient(authKey, null, {
  requestPolicy: customPolicy,
  dnsRefreshIntervalS: 300 // Refresh DNS SRV records every 5 minutes
});

const resources = [
  new ResourceRequest('ha_test_resource', 1000, 10, 1)
];

client.checkRateLimit(resources, (err, result) => {
  if (err) {
    console.error('HA Rate limit check failed:', err.message);
    return;
  }
  console.log(`✅ Rate limit result received from server ${result.serverId}: success=${result.success}`);
});
