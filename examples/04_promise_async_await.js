#!/usr/bin/env node
'use strict';

/**
 * Example 4: Promise & async/await Usage
 *
 * Demonstrates:
 * - Wrapping RateLimitly callbacks into Promise-based functions
 * - Clean async/await syntax for Express / Fastify / Koa / NestJS handlers
 */

const { createClient, ResourceRequest } = require('../client');

const authKey = process.env.RATELIMITLY_AUTH_KEY ||
  'rl-none1qqqsyqcyq5rqwzqfggq0x7v4q47r2r0v3qy0p7e3240r3r8q9s8qgq6e4l4';

const client = createClient(authKey);

// Helper function converting checkRateLimit to Promise
function checkRateLimitAsync(clientInstance, resources, guards = [], metricsLabel = null) {
  return new Promise((resolve, reject) => {
    clientInstance.checkRateLimit(resources, guards, metricsLabel, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

// Helper function converting reportLatency to Promise
function reportLatencyAsync(clientInstance, blocks) {
  return new Promise((resolve, reject) => {
    clientInstance.reportLatency(blocks, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function handleIncomingRequest(userId, action) {
  console.log(`\nProcessing request for user "${userId}", action "${action}"...`);

  const resources = [
    new ResourceRequest(`user:${userId}`, 1000, 10, 1),
    new ResourceRequest(`action:${action}`, 60000, 1000, 1)
  ];

  const result = await checkRateLimitAsync(client, resources);

  if (!result.success) {
    console.log(`⛔ [429 Too Many Requests] Rate limit exceeded for user "${userId}".`);
    return { status: 429, error: 'Too Many Requests' };
  }

  console.log(`✅ [200 OK] Request allowed by RateLimitly.`);
  return { status: 200, message: 'Success' };
}

async function run() {
  try {
    await handleIncomingRequest('alice', 'checkout');
    await handleIncomingRequest('bob', 'search');
  } catch (err) {
    console.error('Error during execution:', err.message);
  }
}

run();
