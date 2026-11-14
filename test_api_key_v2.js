"use strict";

const assert = require("assert");
const { decodeApiKey, encodeApiKey, NAMED_RATE_WINDOW_MS } = require("./api_key_codec");

const DEFAULT_NONE = "rl-none1qgyqwps9qspsyq2sk8e0shcgndc";
const MINIMUM_COOKIE = "rl-cookie1qgqsqqqqqqqqqqqpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqqqzqghe5qw8";
const FREE_AES = "rl-aes1qgpqqqqqqqqqqqqzqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqghjmu3sdl8zyx";
const PRO_COOKIE = "rl-cookie1qgpsqqqqqqqqqqqrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqdgtrunsagsm94";
const BUSINESS_AES = "rl-aes1qgzqqqqqqqqqqqqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqjfrnuagec9c0p";
const ENTERPRISE_COOKIE = "rl-cookie1qgzsqqqqqqqqqqq9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9qh2vrulcl725px";
const MAXIMUM_AES = "rl-aes1qtllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllluv073l7r6cv76";
const MAX_FINITE_WINDOW_COOKIE = "rl-cookie1qgrqqqqqqqqqqqqxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqegtruhsezeama";

assert.strictEqual(NAMED_RATE_WINDOW_MS.length, 30);

const defaults = decodeApiKey(DEFAULT_NONE);
assert.strictEqual(defaults.formatVersion, 2);
assert.strictEqual(defaults.keyId, 0x0102030405060708n);
assert.deepStrictEqual(defaults.quotas, {
  rate_buckets_max: 65536,
  latency_services_max: 1024,
  metrics_labels_max: 4096,
  latency_buffer_size_max: 32,
  dedup_ttl_ms_max: 300,
  rate_window_size_ms_max: "unlimited",
});
assert.strictEqual(
  encodeApiKey(defaults.authMethod, defaults.keyId, defaults.authSecret, defaults.quotas),
  DEFAULT_NONE
);

const minimum = decodeApiKey(MINIMUM_COOKIE);
assert.strictEqual(minimum.formatVersion, 2);
assert.deepStrictEqual(minimum.quotas, {
  rate_buckets_max: 1,
  latency_services_max: 1,
  metrics_labels_max: 1,
  latency_buffer_size_max: 1,
  dedup_ttl_ms_max: 10,
  rate_window_size_ms_max: 1000,
});
assert.strictEqual(
  encodeApiKey(minimum.authMethod, minimum.keyId, minimum.authSecret, minimum.quotas),
  MINIMUM_COOKIE
);

const finiteVectors = [
  [FREE_AES, 60_000],
  [PRO_COOKIE, 3_600_000],
  [BUSINESS_AES, 86_400_000],
  [ENTERPRISE_COOKIE, "unlimited"],
  [MAX_FINITE_WINDOW_COOKIE, 31_536_000_000],
];
for (const [token, expectedWindow] of finiteVectors) {
  const decoded = decodeApiKey(token);
  assert.strictEqual(decoded.formatVersion, 2);
  assert.strictEqual(decoded.quotas.rate_window_size_ms_max, expectedWindow);
  assert.strictEqual(
    encodeApiKey(decoded.authMethod, decoded.keyId, decoded.authSecret, decoded.quotas),
    token
  );
}

const maximum = decodeApiKey(MAXIMUM_AES);
assert.strictEqual(maximum.keyId, 0xffffffffffffffffn);
assert.deepStrictEqual(maximum.quotas, {
  rate_buckets_max: 16777216,
  latency_services_max: 16777216,
  metrics_labels_max: 2147483648,
  latency_buffer_size_max: 32768,
  dedup_ttl_ms_max: 2000,
  rate_window_size_ms_max: "unlimited",
});
assert.strictEqual(
  encodeApiKey(maximum.authMethod, maximum.keyId, maximum.authSecret, maximum.quotas),
  MAXIMUM_AES
);

for (const invalid of [
  // v1 keys must be rejected
  "rl-none1qyyqwps9qspsyq2sk8e0sfdp3ys",
  "rl-aes1qypqqqqqqqqqqqqzqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqghjmuhcc2h27q",
  // version 0 & 3
  "rl-aes1qqpqqqqqqqqqqqqzqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqghjmuhccp9vn9",
  "rl-aes1qvpqqqqqqqqqqqqzqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqghjmuhccu6xy2",
  // reserved rate/latency/dedup/window codes
  "rl-aes1qgysqqqqqqqqqqqfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyvsqzqgwu07su",
  "rl-aes1qgysqqqqqqqqqqqfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfp8sqxzqglcu0vh",
  "rl-aes1qgysqqqqqqqqqqqfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyqqqqqgz2lknf",
  "rl-aes1qgysqqqqqqqqqqqfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyqqqjqwngn9ns",
  "rl-aes1qgysqqqqqqqqqqqfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyqqqzqqc6fakd",
  // legacy unversioned length
  "rl-aes1qvqqqqqqqqqqqqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqemrljn",
]) {
  assert.throws(() => decodeApiKey(invalid), `expected decodeApiKey to reject ${invalid}`);
}

assert.throws(() => encodeApiKey("none", 1n, new Uint8Array(0), {
  rate_buckets_max: 1,
  latency_services_max: 1,
  metrics_labels_max: 1,
  latency_buffer_size_max: 1,
  dedup_ttl_ms_max: 10,
  rate_window_size_ms_max: 0xffffffff,
}));

console.log("API-key v2 conformance tests passed");
