#!/usr/bin/env node
'use strict';

/**
 * Example 1: Basic Rate Limiting
 *
 * Demonstrates:
 * - Creating a RateLimitly client with an API key
 * - Defining a single resource limit (e.g. 100 requests per 60 seconds)
 * - Checking admission via standard Node.js callback
 */

const { createClient, ResourceRequest } = require('../client');

// Replace with your Bech32 API key or pass via RATELIMITLY_AUTH_KEY
const authKey = process.env.RATELIMITLY_AUTH_KEY ||
  'rl-none1qqqsyqcyq5rqwzqfggq0x7v4q47r2r0v3qy0p7e3240r3r8q9s8qgq6e4l4';

// createClient automatically derives the tenant DNS domain from the key
const client = createClient(authKey);

// Define a resource request:
// - bucketName: 'api_calls'
// - windowSizeMs: 60000 (1 minute)
// - rateLimit: 100 (max 100 requests per window)
// - tokensRequested: 1
const resources = [
  new ResourceRequest('api_calls', 60000, 100, 1)
];

console.log('Checking rate limit for resource "api_calls"...');

client.checkRateLimit(resources, (err, result) => {
  if (err) {
    console.error('RateLimitly communication or timeout error:', err.message);
    return;
  }

  if (result.success) {
    console.log('✅ Request GRANTED');
    console.log(`   Server ID: ${result.serverId}`);
    for (const r of result.resourceResults) {
      console.log(`   Bucket '${r.bucketName}': tokensDeficit=${r.tokensDeficit}, actualRate=${r.actualRate}`);
    }
  } else {
    console.log('❌ Request DENIED (Rate limit exceeded)');
    for (const r of result.resourceResults) {
      if (r.tokensDeficit > 0) {
        console.log(`   Bucket '${r.bucketName}' deficit: ${r.tokensDeficit} tokens`);
      }
    }
  }
});
