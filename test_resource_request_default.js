#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  AuthMethod,
  ResourceRequest,
  TenantConfig,
  WireProtocol
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
const testKey = encodeApiKey('none', 1n, new Uint8Array(0), quotas);
const tenant = new TenantConfig('test.domain', 1n, AuthMethod.NONE, testKey);

function testOmittedTokensDefaultToOne() {
  console.log('Testing omitted tokensRequested defaults to 1...');

  // 1. Three-argument constructor defaults tokensRequested to 1
  const reqDefault = new ResourceRequest('bucket_default', 1000, 100);
  assert.strictEqual(
    reqDefault.tokensRequested,
    1,
    'ResourceRequest tokensRequested must default to 1 when omitted'
  );

  // 2. Explicit undefined also defaults to 1
  const reqExplicitUndefined = new ResourceRequest('bucket_def_undef', 1000, 100, undefined);
  assert.strictEqual(
    reqExplicitUndefined.tokensRequested,
    1,
    'ResourceRequest tokensRequested must default to 1 when passed undefined'
  );

  // 3. Check wire serialization of default tokensRequested
  const packet = WireProtocol.createRateRequest(tenant, [reqDefault], [], null, 1000);
  // Tenant header: 40 bytes, Auth NONE header: 4 bytes, PDU header: 8 bytes, counts: 4 bytes
  // Resource block at pos 56: bucketId (16 bytes) + windowSizeMs (4 bytes) + rateLimit (4 bytes) = pos 80
  // tokensRequested (2 bytes uint16LE) is at offset 80
  const encodedTokens = packet.readUInt16LE(80);
  assert.strictEqual(
    encodedTokens,
    1,
    `Serialized packet must contain 1 token requested, found ${encodedTokens}`
  );

  console.log('✅ Default tokensRequested verified');
}

function testExplicitTokensPreserved() {
  console.log('Testing explicit tokensRequested values...');

  // 1. Explicit positive value
  const req5 = new ResourceRequest('bucket_5', 1000, 100, 5);
  assert.strictEqual(req5.tokensRequested, 5);
  const packet5 = WireProtocol.createRateRequest(tenant, [req5], [], null, 1000);
  assert.strictEqual(packet5.readUInt16LE(80), 5);

  // 2. Explicit 0 tokens (e.g. check remaining quota without token consumption)
  const req0 = new ResourceRequest('bucket_0', 1000, 100, 0);
  assert.strictEqual(req0.tokensRequested, 0);
  const packet0 = WireProtocol.createRateRequest(tenant, [req0], [], null, 1000);
  assert.strictEqual(packet0.readUInt16LE(80), 0);

  // 3. Maximum uint16 token count (65535)
  const reqMax = new ResourceRequest('bucket_max', 1000, 100, 65535);
  assert.strictEqual(reqMax.tokensRequested, 65535);
  const packetMax = WireProtocol.createRateRequest(tenant, [reqMax], [], null, 1000);
  assert.strictEqual(packetMax.readUInt16LE(80), 65535);

  console.log('✅ Explicit tokensRequested verified');
}

function testInvalidTokensValidation() {
  console.log('Testing invalid tokensRequested rejection...');

  // Negative value
  assert.throws(
    () => new ResourceRequest('bucket_neg', 1000, 100, -1),
    /tokensRequested must be a non-negative integer <= 65535/i
  );

  // Overflow uint16
  assert.throws(
    () => new ResourceRequest('bucket_over', 1000, 100, 65536),
    /tokensRequested must be a non-negative integer <= 65535/i
  );

  // Non-integer float
  assert.throws(
    () => new ResourceRequest('bucket_float', 1000, 100, 2.5),
    /tokensRequested must be a non-negative integer/i
  );

  // Non-number type
  assert.throws(
    () => new ResourceRequest('bucket_str', 1000, 100, '5'),
    /tokensRequested must be a non-negative integer/i
  );

  for (const value of [null, NaN, Infinity, -Infinity, true, 1n, {}, []]) {
    assert.throws(() => new ResourceRequest('bucket_invalid', 1000, 100, value), RangeError);
  }

  // One-resource and multi-resource requests use the same constructor default.
  const batch = WireProtocol.createRateRequest(tenant, [
    new ResourceRequest('first', 1000, 100),
    new ResourceRequest('second', 1000, 100, undefined),
    new ResourceRequest('third', 1000, 100, 0),
  ], [], null, 1000);
  assert.deepStrictEqual([80, 108, 136].map((offset) => batch.readUInt16LE(offset)), [1, 1, 0]);

  console.log('✅ Invalid tokensRequested validation verified');
}

function runAll() {
  testOmittedTokensDefaultToOne();
  testExplicitTokensPreserved();
  testInvalidTokensValidation();
  console.log('🎉 All ResourceRequest token default and validation tests passed!');
}

runAll();
