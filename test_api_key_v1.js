"use strict";

const assert = require("assert");
const { decodeApiKey, encodeApiKey } = require("./api_key_codec");

const DEFAULT_NONE = "rl-none1qyyqwps9qspsyq2sk8e0sfdp3ys";
const MINIMUM_COOKIE = "rl-cookie1qyqsqqqqqqqqqqqpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqqqzqqfs0x84";
const MAXIMUM_AES = "rl-aes1q8llllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllluv073l7r88xf4";

const defaults = decodeApiKey(DEFAULT_NONE);
assert.strictEqual(defaults.formatVersion, 1);
assert.strictEqual(defaults.keyId, 0x0102030405060708n);
assert.deepStrictEqual(defaults.quotas, {
  rate_buckets_max: 65536,
  latency_services_max: 1024,
  metrics_labels_max: 4096,
  latency_buffer_size_max: 32,
  dedup_ttl_ms_max: 300,
  rate_window_size_ms_max: 0xffffffff,
});
assert.strictEqual(
  encodeApiKey(defaults.authMethod, defaults.keyId, defaults.authSecret, defaults.quotas),
  DEFAULT_NONE
);

const minimum = decodeApiKey(MINIMUM_COOKIE);
assert.strictEqual(minimum.formatVersion, 1);
assert.deepStrictEqual(minimum.quotas, {
  rate_buckets_max: 1,
  latency_services_max: 1,
  metrics_labels_max: 1,
  latency_buffer_size_max: 1,
  dedup_ttl_ms_max: 10,
  rate_window_size_ms_max: 1,
});

const maximum = decodeApiKey(MAXIMUM_AES);
assert.strictEqual(maximum.keyId, 0xffffffffffffffffn);
assert.deepStrictEqual(maximum.quotas, {
  rate_buckets_max: 16777216,
  latency_services_max: 16777216,
  metrics_labels_max: 2147483648,
  latency_buffer_size_max: 32768,
  dedup_ttl_ms_max: 2000,
  rate_window_size_ms_max: 0xffffffff,
});

for (const invalid of [
  "rl-aes1qqpqqqqqqqqqqqqzqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqghjmuhccp9vn9",
  "rl-aes1qgpqqqqqqqqqqqqzqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqghjmuhcchgqf0",
  "rl-aes1qyysqqqqqqqqqqqfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyqqqqqqurys6m",
  "rl-aes1qyysqqqqqqqqqqqfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyvsqzqqs45cew",
  "rl-aes1qvqqqqqqqqqqqqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqemrljn",
]) {
  assert.throws(() => decodeApiKey(invalid));
}

console.log("API-key v1 conformance tests passed");
