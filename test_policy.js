"use strict";

const assert = require("assert");
const {
  AuthMethod,
  HaSchedule,
  LatencyGuard,
  RClient,
  RClientConfig,
  RequestPolicy,
  ResourceRequest,
  TenantConfig,
  WireProtocol,
} = require("./client");

const defaultPolicy = new RequestPolicy();
assert.strictEqual(defaultPolicy.horizonMs(300), 60);
assert.strictEqual(HaSchedule.linear(1, 2, 6).units(3), 6);
assert.strictEqual(HaSchedule.exponential(1, 2, 8).units(3), 8);
assert.strictEqual(new RequestPolicy({
  unitMs: 25,
  replayCount: 3,
  replayGap: HaSchedule.fixed(1),
  finalReceiveUnits: 0,
  completionDelivery: false,
}).horizonMs(300), 100);

const minimumKey = "rl-cookie1qyqsqqqqqqqqqqqpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqqqzqqfs0x84";
const tenant = new TenantConfig("example.test", 1n, AuthMethod.COOKIE, minimumKey);
const policy = new RequestPolicy({ unitMs: 3, replayCount: 1, finalReceiveUnits: 1 });
const client = new RClient(new RClientConfig(tenant, { requestPolicy: policy }));

assert.throws(
  () => WireProtocol.createRateRequest(
    tenant,
    [new ResourceRequest("bucket", 2, 1, 1)],
    [],
    null,
    9
  ),
  /rate_window_size_ms_max/
);
assert.throws(
  () => WireProtocol.createRateRequest(
    tenant,
    [],
    [new LatencyGuard({
      latencyTrackerName: "service",
      thresholdMs: 10,
      ttlMs: 100,
      maxSamples: 10,
      bufferSize: 2,
      minSampleThreshold: 1,
    })],
    null,
    9
  ),
  /latency_buffer_size_max/
);

let emptyResult = null;
client.checkRateLimit([], [], (error, result) => {
  assert.ifError(error);
  emptyResult = result;
});
assert(emptyResult && emptyResult.success && emptyResult.serverId === 0);

console.log("Unified HA policy and quota tests passed");
