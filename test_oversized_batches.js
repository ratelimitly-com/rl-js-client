#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  AuthMethod,
  RateLimitError,
  ResourceRequest,
  ServiceLatencyBlock,
  TenantConfig,
  WireProtocol,
  RClient,
  RClientConfig
} = require('./client');
const { encodeApiKey } = require('./api_key_codec');

const quotas = {
  rate_buckets_max: 65536,
  latency_services_max: 1024,
  metrics_labels_max: 4096,
  latency_buffer_size_max: 32,
  dedup_ttl_ms_max: 2000,
  rate_window_size_ms_max: 0xffffffff,
};

const noneKey = encodeApiKey('none', 1n, new Uint8Array(0), quotas);
const cookieSecret = new Uint8Array(32).fill(0xaa);
const cookieKey = encodeApiKey('cookie', 1n, cookieSecret, quotas);
const aesSecret = new Uint8Array(32).fill(0x55);
const aesKey = encodeApiKey('aes', 1n, aesSecret, quotas);

const tenantNone = new TenantConfig('test.domain', 1n, AuthMethod.NONE, noneKey);
const tenantCookie = new TenantConfig('test.domain', 1n, AuthMethod.COOKIE, cookieKey);
const tenantAes = new TenantConfig('test.domain', 1n, AuthMethod.AES_GCM, aesKey);

function makeResources(count) {
  const list = [];
  for (let i = 0; i < count; i++) {
    list.push(new ResourceRequest(`bucket_${i}`, 1000, 100, 1));
  }
  return list;
}

function makeLatencyBlocks(count) {
  const list = [];
  for (let i = 0; i < count; i++) {
    list.push(new ServiceLatencyBlock({
      latencyTrackerName: `tracker_${i}`,
      observedLatency: 15,
      ttlMs: 5000,
      maxSamples: 100,
      minSampleThreshold: 10
    }));
  }
  return list;
}

function testOversizedRateRequestRejection() {
  console.log('Testing oversized rate request rejection across auth modes...');

  // 1. AuthMethod.NONE
  // 40 resources = 40 (tenant) + 4 (auth) + 8 (pdu header) + 4 (counts) + 40 * 28 = 1176 bytes <= 1200 (OK)
  const reqNone40 = WireProtocol.createRateRequest(tenantNone, makeResources(40), [], null, 1000);
  assert.strictEqual(reqNone40.length, 1176, '40-resource NONE packet should be 1176 bytes');

  // 41 resources = 40 + 4 + 8 + 4 + 41 * 28 = 1204 bytes > 1200 (REJECT)
  assert.throws(
    () => WireProtocol.createRateRequest(tenantNone, makeResources(41), [], null, 1000),
    (err) => err instanceof RateLimitError && /exceeds maximum datagram size of 1200/i.test(err.message),
    '41-resource NONE packet must throw RateLimitError'
  );

  // 2. AuthMethod.COOKIE
  // 39 resources = 40 (tenant) + 36 (auth) + 8 (pdu header) + 4 (counts) + 39 * 28 = 1180 bytes <= 1200 (OK)
  const reqCookie39 = WireProtocol.createRateRequest(tenantCookie, makeResources(39), [], null, 1000);
  assert.strictEqual(reqCookie39.length, 1180, '39-resource COOKIE packet should be 1180 bytes');

  // 40 resources = 40 + 36 + 8 + 4 + 40 * 28 = 1208 bytes > 1200 (REJECT)
  assert.throws(
    () => WireProtocol.createRateRequest(tenantCookie, makeResources(40), [], null, 1000),
    (err) => err instanceof RateLimitError && /exceeds maximum datagram size of 1200/i.test(err.message),
    '40-resource COOKIE packet must throw RateLimitError'
  );

  // 3. AuthMethod.AES_GCM
  // 39 resources = 40 (tenant) + 32 (auth) + 8 (pdu header) + 4 (counts) + 39 * 28 = 1176 bytes <= 1200 (OK)
  const reqAes39 = WireProtocol.createRateRequest(tenantAes, makeResources(39), [], null, 1000);
  assert.strictEqual(reqAes39.length, 1176, '39-resource AES packet should be 1176 bytes');

  // 40 resources = 40 + 32 + 8 + 4 + 40 * 28 = 1204 bytes > 1200 (REJECT)
  assert.throws(
    () => WireProtocol.createRateRequest(tenantAes, makeResources(40), [], null, 1000),
    (err) => err instanceof RateLimitError && /exceeds maximum datagram size of 1200/i.test(err.message),
    '40-resource AES packet must throw RateLimitError'
  );

  // 4. Metrics label overhead causing boundary crossing
  // 40 resources with 24-byte label pushes 1176 + (4 + 28) = 1208 bytes > 1200 (REJECT)
  assert.throws(
    () => WireProtocol.createRateRequest(tenantNone, makeResources(40), [], 'a'.repeat(24), 1000),
    (err) => err instanceof RateLimitError && /exceeds maximum datagram size of 1200/i.test(err.message),
    '40 resources with label exceeding 1200 must throw RateLimitError'
  );

  console.log('✅ Oversized rate request rejection tests passed');
}

function testOversizedLatencyReportRejection() {
  console.log('Testing oversized latency report rejection across auth modes...');

  // 1. AuthMethod.NONE
  // 35 blocks = 40 (tenant) + 4 (auth) + 12 (pdu header) + 35 * 32 = 1176 bytes <= 1200 (OK)
  const repNone35 = WireProtocol.createLatencyReport(tenantNone, makeLatencyBlocks(35));
  assert.strictEqual(repNone35.length, 1176, '35-block NONE report should be 1176 bytes');

  // 36 blocks = 40 + 4 + 12 + 36 * 32 = 1208 bytes > 1200 (REJECT)
  assert.throws(
    () => WireProtocol.createLatencyReport(tenantNone, makeLatencyBlocks(36)),
    (err) => err instanceof RateLimitError && /exceeds maximum datagram size of 1200/i.test(err.message),
    '36-block NONE report must throw RateLimitError'
  );

  // 2. AuthMethod.COOKIE
  // 34 blocks = 40 (tenant) + 36 (auth) + 12 (pdu header) + 34 * 32 = 1176 bytes <= 1200 (OK)
  const repCookie34 = WireProtocol.createLatencyReport(tenantCookie, makeLatencyBlocks(34));
  assert.strictEqual(repCookie34.length, 1176, '34-block COOKIE report should be 1176 bytes');

  // 35 blocks = 40 + 36 + 12 + 35 * 32 = 1208 bytes > 1200 (REJECT)
  assert.throws(
    () => WireProtocol.createLatencyReport(tenantCookie, makeLatencyBlocks(35)),
    (err) => err instanceof RateLimitError && /exceeds maximum datagram size of 1200/i.test(err.message),
    '35-block COOKIE report must throw RateLimitError'
  );

  // 3. AuthMethod.AES_GCM
  // 34 blocks = 40 (tenant) + 32 (auth) + 12 (pdu header) + 34 * 32 = 1172 bytes <= 1200 (OK)
  const repAes34 = WireProtocol.createLatencyReport(tenantAes, makeLatencyBlocks(34));
  assert.strictEqual(repAes34.length, 1172, '34-block AES report should be 1172 bytes');

  // 35 blocks = 40 + 32 + 12 + 35 * 32 = 1204 bytes > 1200 (REJECT)
  assert.throws(
    () => WireProtocol.createLatencyReport(tenantAes, makeLatencyBlocks(35)),
    (err) => err instanceof RateLimitError && /exceeds maximum datagram size of 1200/i.test(err.message),
    '35-block AES report must throw RateLimitError'
  );

  console.log('✅ Oversized latency report rejection tests passed');
}

async function testClientRejection() {
  console.log('Testing RClient rejection for oversized payloads...');
  const client = new RClient(new RClientConfig(tenantNone));
  client.servers = [{ ip: '127.0.0.1', port: 29292, serverId: 1001 }];
  client.lastDnsRefresh = Date.now();

  // checkRateLimit Promise rejection
  await assert.rejects(
    client.checkRateLimit(makeResources(41), []),
    (err) => err instanceof RateLimitError && /exceeds maximum datagram size/i.test(err.message),
    'checkRateLimit with 41 resources must reject'
  );

  // checkRateLimit callback rejection
  await new Promise((resolve, reject) => {
    client.checkRateLimit(makeResources(41), [], (err) => {
      if (err instanceof RateLimitError && /exceeds maximum datagram size/i.test(err.message)) {
        resolve();
      } else {
        reject(new Error(`Expected RateLimitError, got: ${err}`));
      }
    });
  });

  // reportLatency Promise rejection
  await assert.rejects(
    client.reportLatency(makeLatencyBlocks(36)),
    (err) => err instanceof RateLimitError && /exceeds maximum datagram size/i.test(err.message),
    'reportLatency with 36 blocks must reject'
  );

  // reportLatency callback rejection
  await new Promise((resolve, reject) => {
    client.reportLatency(makeLatencyBlocks(36), (err) => {
      if (err instanceof RateLimitError && /exceeds maximum datagram size/i.test(err.message)) {
        resolve();
      } else {
        reject(new Error(`Expected RateLimitError, got: ${err}`));
      }
    });
  });

  console.log('✅ RClient rejection tests passed');
}

async function runAll() {
  testOversizedRateRequestRejection();
  testOversizedLatencyReportRejection();
  await testClientRejection();
  console.log('🎉 All oversized batch validation tests passed!');
}

runAll().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
