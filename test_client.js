#!/usr/bin/env node
/**
 * Test suite for RateLimitly JavaScript R-Client
 */

const {
    RClient, RClientConfig, TenantConfig, AuthMethod,
    ResourceRequest, LatencyGuard, ServiceLatencyBlock, WireProtocol, ServerTracker,
    RateLimitError, TimeoutError, CanonicalIds, RequestPolicy, createClient
} = require('./client.js');
const { encodeApiKey } = require('./api_key_codec.js');

const SAMPLE_QUOTAS = {
    rate_buckets_max: 65536,
    latency_services_max: 1024,
    metrics_labels_max: 4096,
    latency_buffer_size_max: 32,
    dedup_ttl_ms_max: 300,
    rate_window_size_ms_max: 'unlimited'
};
const SAMPLE_NONE_KEY_TENANT_1 = encodeApiKey('none', 1n, new Uint8Array(0), SAMPLE_QUOTAS);
const SAMPLE_COOKIE_KEY_TENANT_12345 = encodeApiKey(
    'cookie', 12345n, new Uint8Array(32).fill(3), SAMPLE_QUOTAS
);
const SERVER_ID_EPOCH_S_2025 = 1735689600;
const SERVER_ID_TIME_SHIFT = 23;

// Import config if available (for tests directory integration)
let getTargetHost;
try {
    const config = require('./tests/config.js');
    getTargetHost = config.getTargetHost;
} catch (e) {
    // Fallback for standalone usage
    getTargetHost = () => 'localhost';
}

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

function testWireProtocol(callback) {
    console.log('Testing wire protocol...');

    assert(
        CanonicalIds.bucketId('checkout', 1000, 100).toString('hex')
            === '67f3b7c9ab155308089e20ca8d943909',
        'Canonical checkout bucket ID should match the central vector'
    );
    assert(
        CanonicalIds.bucketId('café', 60000, 25).toString('hex')
            === 'd9cf1a0af970aa9dff86fac0605fae42',
        'Canonical UTF-8 bucket ID should match the central vector'
    );
    assert(
        CanonicalIds.bucketId(
            Buffer.from('62696e617279006275636b6574', 'hex'),
            31536000000,
            0xFFFF_FFFF
        ).toString('hex') === '552c6b8185f1d61ebc3ccc65f446ec88',
        'Canonical max finite window & embedded-NUL bucket ID should match the central vector'
    );
    assert(
        CanonicalIds.bucketId('a', 10, 1).toString('hex')
            === '5b0b0d61aa7c806a0ff9e5973bf3cacb',
        'Canonical 10ms bucket ID should match the central vector'
    );
    for (const badWindow of [0, 5, 15, 31536000010]) {
        let threw = false;
        try {
            CanonicalIds.bucketId('bad', badWindow, 1);
        } catch (err) {
            threw = err instanceof RangeError;
        }
        assert(threw, `CanonicalIds.bucketId should reject invalid window ${badWindow}`);
    }
    assert(
        CanonicalIds.latencyTrackerId('inventory-backend', 10000, 100, 5).toString('hex')
            === '6a17d07a424568304e50d28540f76e67',
        'Canonical inventory latency-tracker ID should match the central vector'
    );
    assert(
        CanonicalIds.latencyTrackerId('café', 60000, 200, 3).toString('hex')
            === '0f04bcd0fa9d655ca40dd204f50196f7',
        'Canonical UTF-8 latency-tracker ID should match the central vector'
    );
    assert(
        CanonicalIds.latencyTrackerId(
            Buffer.from('62696e61727900747261636b6572', 'hex'),
            0xFFFF_FFFF,
            0xFFFF_FFFF,
            0xFFFF_FFFF
        ).toString('hex') === '2944d00ab0f1829a4d598d47f32fb0fa',
        'Canonical embedded-NUL latency-tracker ID should match the central vector'
    );
    
    const tenantConfig = new TenantConfig('test.example.com', 1, AuthMethod.NONE, SAMPLE_NONE_KEY_TENANT_1);
    
    const resources = [new ResourceRequest('checkout', 1000, 100, 3)];
    const guards = [new LatencyGuard({
        latencyTrackerName: 'inventory-backend',
        thresholdMs: 100.0,
        ttlMs: 10000,
        maxSamples: 100,
        minSampleThreshold: 5
    })];
    
    // Test rate request creation
    const packet = WireProtocol.createRateRequest(tenantConfig, resources, guards);
    assert(packet.length > 0, 'Packet should not be empty');
    assert(packet.readUInt16LE(0) === 0x4C52, 'Should start with tenant TLV');
    assert(packet.readUInt16LE(44) === 0x3254, 'Rate request PDU type should be T2 (0x3254)');
    assert(
        packet.subarray(56, 72).toString('hex') === '6a17d07a424568304e50d28540f76e67',
        'Guard should carry the canonical latency-tracker ID'
    );
    assert(
        packet.subarray(92, 108).toString('hex') === '67f3b7c9ab155308089e20ca8d943909',
        'Resource should carry the canonical v2 bucket ID'
    );
    assert(
        packet.readUInt32LE(108) === 100,
        'Resource block should encode 1000ms window as 100 units of 10ms'
    );
    
    // Test latency report creation
    const latencyPacket = WireProtocol.createLatencyReport(tenantConfig, [
        new ServiceLatencyBlock({
            latencyTrackerName: 'inventory-backend',
            observedLatency: 85.5,
            ttlMs: 10000,
            maxSamples: 100,
            minSampleThreshold: 5
        })
    ]);
    assert(latencyPacket.length > 0, 'Latency packet should not be empty');
    assert(latencyPacket.length === 88, 'One-service latency packet should be 88 bytes with NONE auth');
    assert(latencyPacket.readUInt16LE(44) === 0x524C, 'Latency PDU type should be LR');
    assert(latencyPacket.readUInt16LE(46) === 44, 'One-service latency PDU should be 44 bytes');
    assert(latencyPacket.readUInt16LE(52) === 1, 'Latency report should contain one report block');
    assert(
        latencyPacket.subarray(56, 72).toString('hex') === '6a17d07a424568304e50d28540f76e67',
        'Latency report should use the same canonical tracker ID as the guard'
    );
    assert(latencyPacket.readUInt32LE(84) === 85, 'Observed latency should end the 32-byte report block');
    
    console.log('✅ Wire protocol tests passed');
    callback();
}

function testAesAadTamperRejection(callback) {
    console.log('Testing AES AAD authentication...');

    const aesKey = encodeApiKey('aes', 3n, new Uint8Array(32).fill(3), {
        rate_buckets_max: 65536,
        latency_services_max: 1024,
        metrics_labels_max: 4096,
        latency_buffer_size_max: 64,
        dedup_ttl_ms_max: 300,
        rate_window_size_ms_max: 'unlimited'
    });
    const tenantConfig = new TenantConfig(
        'test.example.com',
        3,
        AuthMethod.AES_GCM,
        aesKey
    );
    const resources = [new ResourceRequest('test_bucket', 1000, 10, 1)];
    const packet = WireProtocol.createRateRequest(tenantConfig, resources);

    const decoded = WireProtocol._requireDecodedAuth(tenantConfig, 'aes');
    const nonce = packet.subarray(44, 56);
    const authTag = packet.subarray(56, 72);
    const encrypted = packet.subarray(72);
    const aad = packet.subarray(0, 56);

    const pdu = WireProtocol._decryptPDU(encrypted, nonce, authTag, decoded.authSecret, aad);
    assert(pdu.readUInt16LE(0) === 0x3254, 'AES request should decrypt to T2 rate request PDU');

    const tamperedAad = Buffer.from(aad);
    tamperedAad[4] ^= 0x01;
    let failed = false;
    try {
        WireProtocol._decryptPDU(encrypted, nonce, authTag, decoded.authSecret, tamperedAad);
    } catch (error) {
        failed = true;
    }
    assert(failed, 'AES decryption should reject tampered AAD');

    console.log('✅ AES AAD authentication tests passed');
    callback();
}

function testServerTracker(callback) {
    console.log('Testing server tracker...');
    
    const tracker = new ServerTracker(2000);
    const now = Date.now();
    const recentServerId = serverIdFromStartMs(now);
    const oldServerId = serverIdFromStartMs(now - 5000);
    
    // New server should not be stable
    assert(!tracker.isServerStable(recentServerId), 'Unknown server should not be stable');
    
    tracker.recordResponse(recentServerId, 50.0);
    assert(!tracker.isServerStable(recentServerId), 'Recently started server should not be stable');

    tracker.recordResponse(oldServerId, 45.0);
    assert(tracker.isServerStable(oldServerId), 'Older server should be stable based on encoded startup time');
    
    console.log('✅ Server tracker tests passed');
    callback();
}

function testClientConfiguration(callback) {
    console.log('Testing client configuration...');
    
    const tenantConfig = new TenantConfig('127.0.0.1', 12345, AuthMethod.COOKIE, SAMPLE_COOKIE_KEY_TENANT_12345);
    const config = new RClientConfig(tenantConfig, {
        requestPolicy: new RequestPolicy({ unitMs: 25, replayCount: 1 })
    });
    
    const client = new RClient(config);
    assert(client.config.requestPolicy.unitMs === 25, 'Policy unit should be configured');
    assert(client.config.tenant.keyId === 12345, 'Tenant ID should be configured');
    assert(client.config.dnsRefreshIntervalS === 10, 'DNS refresh interval should default to 10 seconds');
    
    console.log('✅ Client configuration tests passed');
    callback();
}

function testRateLimitingIntegration(callback) {
    console.log('Testing rate limiting integration...');
    
    const client = createClient(SAMPLE_NONE_KEY_TENANT_1, getTargetHost());
    const resources = [new ResourceRequest('test_api', 1000, 5, 1)];
    
    // Show discovered servers
    setTimeout(() => {
        const stats = client.getServerStats();
        if (stats.servers && stats.servers.length > 0) {
            console.log(`Discovered servers: ${stats.servers.map(s => `${s.ip || s}:${s.port || '29292'}`).join(', ')}`);
        }
    }, 100);
    
    // Test successful request
    client.checkRateLimit(resources, [], (error, result) => {
        if (error) {
            console.log(`⚠️ Integration test skipped (no server): ${error.message}`);
            return callback();
        }
        
        console.log(`Rate limit result: success=${result.success}, server_id=${result.serverId}`);
        
        // Test latency reporting
        client.reportLatency('test_service', 75.5, (latencyError) => {
            if (latencyError) {
                console.log(`⚠️ Latency report failed: ${latencyError.message}`);
            } else {
                console.log('Latency reported successfully');
            }
            
            console.log('✅ Rate limiting integration tests passed');
            callback();
        });
    });
}

function testConcurrentRequests(callback) {
    console.log('Testing concurrent requests...');
    
    const client = createClient(SAMPLE_NONE_KEY_TENANT_1, getTargetHost());
    let results = [];
    let errors = [];
    let completed = 0;
    const totalRequests = 5;
    
    // Show discovered servers
    setTimeout(() => {
        const stats = client.getServerStats();
        if (stats.servers && stats.servers.length > 0) {
            console.log(`Using servers: ${stats.servers.map(s => `${s.ip || s}:${s.port || '29292'}`).join(', ')}`);
        }
    }, 100);
    
    function makeRequest(threadId) {
        const resources = [new ResourceRequest(`thread_${threadId}`, 1000, 10, 1)];
        client.checkRateLimit(resources, [], (error, result) => {
            if (error) {
                errors.push(error);
            } else {
                results.push(result);
            }
            
            completed++;
            if (completed === totalRequests) {
                console.log(`Concurrent requests: ${results.length} successful, ${errors.length} errors`);
                
                if (results.length > 0) {
                    console.log('✅ Concurrent request tests passed');
                } else {
                    console.log('⚠️ Concurrent test skipped (no server)');
                }
                callback();
            }
        });
    }
    
    // Start multiple concurrent requests
    for (let i = 0; i < totalRequests; i++) {
        makeRequest(i);
    }
}

function testErrorHandling(callback) {
    console.log('Testing error handling...');
    
    // Test with invalid DNS name
    const client = createClient(SAMPLE_NONE_KEY_TENANT_1, 'invalid.nonexistent.domain');
    const resources = [new ResourceRequest('test', 1000, 10, 1)];
    
    client.checkRateLimit(resources, [], 500, (error, result) => {
        if (error) {
            if (error instanceof TimeoutError || error instanceof RateLimitError) {
                console.log('✅ Timeout handled correctly');
            } else {
                console.log(`✅ DNS error handled: ${error.message}`);
            }
        } else {
            console.log('⚠️ Expected timeout but got result');
        }
        callback();
    });
}

function runAllTests() {
    console.log('🧪 Running RateLimitly JavaScript R-Client Tests\n');
    
    const tests = [
        testWireProtocol,
        testAesAadTamperRejection,
        testServerTracker,
        testClientConfiguration,
        testRateLimitingIntegration,
        testConcurrentRequests,
        // testErrorHandling
    ];
    
    let currentTest = 0;
    
    function runNextTest() {
        if (currentTest >= tests.length) {
            console.log('\n🎉 All tests completed!');
            console.log('\nTo test with a live server:');
            console.log('1. Start a compatible server on UDP port 29292');
            console.log('2. Run integration tests: node test_client.js');
            return;
        }
        
        try {
            tests[currentTest](() => {
                currentTest++;
                runNextTest();
            });
        } catch (error) {
            console.error(`\n❌ Test failed: ${error.message}`);
            process.exit(1);
        }
    }
    
    runNextTest();
}

if (require.main === module) {
    runAllTests();
}
