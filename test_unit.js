#!/usr/bin/env node

const {
    RClient, RClientConfig, TenantConfig, AuthMethod,
    ResourceRequest, LatencyGuard, ServiceLatencyBlock, WireProtocol, ServerTracker
} = require('./client.js');

const SAMPLE_COOKIE_KEY_TENANT_12345 =
    'rl-cookie18ycqqqqqqqqqq54l6t0q5tnfml69zagcty9vx2jxh4mxqmkz9gjclx2cffh8pt9zqqqqzqqqqsqqqqqsqqqyqqqqqqxw5ukq';
const SERVER_ID_EPOCH_S_2025 = 1735689600;
const SERVER_ID_TIME_SHIFT = 23;

function assert(condition, message) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

function serverIdFromStartMs(startMs) {
    const startSeconds = Math.floor(startMs / 1000);
    const deltaSeconds = Math.max(0, startSeconds - SERVER_ID_EPOCH_S_2025);
    return deltaSeconds * (2 ** SERVER_ID_TIME_SHIFT);
}

function testWireProtocol() {
    const tenantConfig = new TenantConfig('test.example.com', 12345, AuthMethod.NONE);
    const resources = [new ResourceRequest('test_bucket', 1000, 10, 3)];
    const guards = [new LatencyGuard({
        serviceId: 'test_service',
        thresholdMs: 100.0,
        ttlMs: 10000,
        maxSamples: 100,
        bufferSize: 20,
        minSampleThreshold: 8
    })];

    const packet = WireProtocol.createRateRequest(tenantConfig, resources, guards);
    assert(packet.length > 0, 'rate request packet should not be empty');
    assert(packet.readUInt16LE(0) === 0x4C52, 'rate request should start with tenant TLV');

    const latencyPacket = WireProtocol.createLatencyReport(tenantConfig, [
        new ServiceLatencyBlock({
            serviceId: 'test_service',
            observedLatency: 85.5,
            ttlMs: 10000,
            maxSamples: 100,
            bufferSize: 20,
            minSampleThreshold: 8
        })
    ]);
    assert(latencyPacket.length > 0, 'latency report packet should not be empty');
}

function testServerTracker() {
    const tracker = new ServerTracker(2000);
    const now = Date.now();
    const recentServerId = serverIdFromStartMs(now);
    const oldServerId = serverIdFromStartMs(now - 5000);

    assert(!tracker.isServerStable(recentServerId), 'unknown server should not be stable');
    tracker.recordResponse(recentServerId, 50.0);
    assert(!tracker.isServerStable(recentServerId), 'recently started server should not be stable');
    tracker.recordResponse(oldServerId, 45.0);
    assert(tracker.isServerStable(oldServerId), 'older server should be stable');
}

function testClientConfiguration() {
    const tenantConfig = new TenantConfig('127.0.0.1', 12345, AuthMethod.COOKIE, SAMPLE_COOKIE_KEY_TENANT_12345);
    const config = new RClientConfig(tenantConfig, { timeoutMs: 500, retryAttempts: 1 });
    const client = new RClient(config);

    assert(client.config.timeoutMs === 500, 'timeout should be configured');
    assert(client.config.tenant.keyId === 12345, 'tenant ID should be configured');
}

function run() {
    testWireProtocol();
    testServerTracker();
    testClientConfiguration();
    console.log('Unit tests passed');
}

if (require.main === module) {
    run();
}
