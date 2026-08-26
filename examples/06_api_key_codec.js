#!/usr/bin/env node
'use strict';

/**
 * Example 6: Bech32 API Key Encoding & Decoding
 *
 * Demonstrates:
 * - Decoding Bech32 API keys (rl-none..., rl-cookie..., rl-aes...)
 * - Inspecting format version, keyId, authMethod, and embedded quota limits
 * - Encoding a fresh API key with custom packed quotas
 */

const {
  decodeApiKey,
  encodeApiKey,
  bytesToHex
} = require('../api_key_codec');

// Sample Format v1 AES key with packed quotas
const sampleKey =
  'rl-aes1qx2kkguvzcenzw7avvc4h7y5kks0z2swtzccyqh62jsg5dml3jkx3m8lpydukeujrdgtruhctlpgl7';

console.log('1. Decoding existing Bech32 API key:');
console.log('   Key:', sampleKey);

const decoded = decodeApiKey(sampleKey);
console.log('\n2. Decoded Metadata:');
console.log('   - HRP:', decoded.hrp);
console.log('   - Auth Method:', decoded.authMethod);
console.log('   - Format Version:', decoded.formatVersion);
console.log('   - Key ID:', decoded.keyId.toString());
console.log('   - Auth Secret (hex):', bytesToHex(decoded.authSecret));
console.log('   - Derived Domain:', `c-${decoded.keyId.toString()}.p0.ratelimitly.com`);

if (decoded.quotas) {
  console.log('\n3. Embedded Quota Limits:');
  console.log('   - rate_buckets_max:', decoded.quotas.rate_buckets_max);
  console.log('   - latency_services_max:', decoded.quotas.latency_services_max);
  console.log('   - metrics_labels_max:', decoded.quotas.metrics_labels_max);
  console.log('   - latency_buffer_size_max:', decoded.quotas.latency_buffer_size_max);
  console.log('   - dedup_ttl_ms_max:', decoded.quotas.dedup_ttl_ms_max, 'ms');
  console.log('   - rate_window_size_ms_max:', decoded.quotas.rate_window_size_ms_max, 'ms');
}

// 4. Encoding a new key
const newKeyId = 9876543210123456789n;
const newSecret = new Uint8Array(32).fill(0x42);
const customQuotas = {
  rate_buckets_max: 32768,
  latency_services_max: 512,
  metrics_labels_max: 2048,
  latency_buffer_size_max: 32,
  dedup_ttl_ms_max: 300,
  rate_window_size_ms_max: 0xffffffff
};

const newKey = encodeApiKey('aes', newKeyId, newSecret, customQuotas);
console.log('\n4. Generated New Key:');
console.log('   ', newKey);
