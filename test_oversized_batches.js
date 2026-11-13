#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  AuthMethod,
  RateLimitError,
  ResourceRequest,
  LatencyGuard,
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
  for (const [tenant, authSize] of [[tenantNone,4],[tenantCookie,36],[tenantAes,32]]) {
    const packet=WireProtocol.createRateRequest(tenant,makeResources(16),[],null,1000);
    assert.strictEqual(packet.length,40+authSize+12+16*28);
    assert.throws(()=>WireProtocol.createRateRequest(tenant,makeResources(17),[],null,1000), /maximum 16/);
    assert.throws(()=>WireProtocol.createRateRequest(tenant,makeResources(16),[],'x'.repeat(1200),1000), RateLimitError);
  }
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

function testExactBoundaryAndGuardBatches() {
  for (const [tenant, authSize, resourceCount] of [
    [tenantNone, 4, 16], [tenantCookie, 36, 16], [tenantAes, 32, 16]
  ]) {
    const resources = makeResources(resourceCount);
    const baseSize = 40 + authSize + 12 + resourceCount * 28;
    // Non-ASCII UTF-8: size validation must count bytes, not JS characters.
    const label = 'é'.repeat((1200 - baseSize - 6) / 2);
    const packet = WireProtocol.createRateRequest(tenant, resources, [], label, 1000);
    assert.strictEqual(packet.length, 1200, 'exactly 1200 bytes must be accepted');
    assert.strictEqual(packet.buffer.byteLength, 1200, 'envelope allocation must be exact');
    let pdu = packet.subarray(40 + authSize);
    if (tenant === tenantAes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesSecret, packet.subarray(44, 56));
      decipher.setAAD(packet.subarray(0, 56));
      decipher.setAuthTag(packet.subarray(56, 72));
      pdu = Buffer.concat([decipher.update(pdu), decipher.final()]);
    }
    assert.strictEqual(pdu.readUInt16LE(2), pdu.length, 'declared PDU must be complete');
    const labelOffset = 12 + resourceCount * 28;
    assert.strictEqual(pdu.readUInt16LE(labelOffset + 4), Buffer.byteLength(label));
    assert.strictEqual(pdu.subarray(labelOffset + 6).toString('utf8'), label);
    assert.throws(() => WireProtocol.createRateRequest(tenant, resources, [], label + 'a', 1000), RateLimitError);

    const guard = new LatencyGuard({
      latencyTrackerName: 'tracker', thresholdMs: 100, ttlMs: 5000,
      maxSamples: 100, minSampleThreshold: 10,
    });
    for (const resourceCount of [0, 2]) {
      const maxGuards = Math.min(16, Math.floor((1200 - 40 - authSize - 12 - resourceCount * 28) / 36));
      const guards = Array(maxGuards).fill(guard);
      const packet = WireProtocol.createRateRequest(tenant, makeResources(resourceCount), guards, null, 1000);
      assert.strictEqual(packet.length, 40 + authSize + 12 + resourceCount * 28 + maxGuards * 36);
      assert.throws(() => WireProtocol.createRateRequest(
        tenant, makeResources(resourceCount), [...guards, guard], null, 1000
      ), RateLimitError);
    }
  }
  console.log('✅ Exact 1200-byte, UTF-8, encrypted PDU, guard-only and mixed boundaries passed');
}

function testOversizedLabelRejectedBeforeCopy() {
  const label = 'x'.repeat(65536);
  const originalFrom = Buffer.from;
  let copied = false;
  Buffer.from = function (value, ...args) {
    if (value === label) copied = true;
    return originalFrom(value, ...args);
  };
  try {
    assert.throws(() => WireProtocol.createRateRequest(tenantNone, makeResources(1), [], label, 1000), RateLimitError);
    assert.strictEqual(copied, false, 'reject oversized labels before allocating their byte buffer');
  } finally { Buffer.from = originalFrom; }
}

async function testClientRejection() {
  console.log('Testing RClient rejection for oversized payloads...');
  const client = new RClient(new RClientConfig(tenantNone));
  client.servers = [{ ip: '127.0.0.1', port: 29292, serverId: 1001 }];
  client.lastDnsRefresh = Date.now();
  client._refreshServers = () => assert.fail('oversized input must not query DNS');
  client._getTransport = () => assert.fail('oversized input must not acquire a socket');

  // checkRateLimit Promise rejection
  await assert.rejects(
    client.checkRateLimit(makeResources(41), []),
    (err) => err instanceof RateLimitError && /exceeds maximum datagram size|maximum 16/i.test(err.message),
    'checkRateLimit with 41 resources must reject'
  );

  // checkRateLimit callback rejection
  await new Promise((resolve, reject) => {
    client.checkRateLimit(makeResources(41), [], (err) => {
      if (err instanceof RateLimitError && /exceeds maximum datagram size|maximum 16/i.test(err.message)) {
        resolve();
      } else {
        reject(new Error(`Expected RateLimitError, got: ${err}`));
      }
    });
  });

  // reportLatency Promise rejection
  await assert.rejects(
    client.reportLatency(makeLatencyBlocks(36)),
    (err) => err instanceof RateLimitError && /exceeds maximum datagram size|maximum 16/i.test(err.message),
    'reportLatency with 36 blocks must reject'
  );

  // reportLatency callback rejection
  await new Promise((resolve, reject) => {
    client.reportLatency(makeLatencyBlocks(36), (err) => {
      if (err instanceof RateLimitError && /exceeds maximum datagram size|maximum 16/i.test(err.message)) {
        resolve();
      } else {
        reject(new Error(`Expected RateLimitError, got: ${err}`));
      }
    });
  });

  console.log('✅ RClient rejection tests passed');
  client.destroy();
}

async function runAll() {
  testOversizedRateRequestRejection();
  testOversizedLatencyReportRejection();
  testExactBoundaryAndGuardBatches();
  testOversizedLabelRejectedBeforeCopy();
  await testClientRejection();
  console.log('🎉 All oversized batch validation tests passed!');
}

runAll().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
