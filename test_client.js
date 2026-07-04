#!/usr/bin/env node
/**
 * Test suite for RateLimitly JavaScript R-Client
 */

const {
    RClient, RClientConfig, TenantConfig, AuthMethod,
    ResourceRequest, LatencyGuard, ServiceLatencyBlock, WireProtocol, ServerTracker,
    RateLimitError, TimeoutError, createClient
} = require('./client.js');
const { encodeApiKey } = require('./api_key_codec.js');

const SAMPLE_COOKIE_KEY_TENANT_12345 =
    'rl-cookie18ycqqqqqqqqqq54l6t0q5tnfml69zagcty9vx2jxh4mxqmkz9gjclx2cffh8pt9zqqqqzqqqqsqqqqqsqqqyqqqqqqxw5ukq';
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
    
    // Test rate request creation
    const packet = WireProtocol.createRateRequest(tenantConfig, resources, guards);
    assert(packet.length > 0, 'Packet should not be empty');
    assert(packet.readUInt16LE(0) === 0x4C52, 'Should start with tenant TLV');
    
    // Test latency report creation
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
    assert(latencyPacket.length > 0, 'Latency packet should not be empty');
    
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
        dedup_ttl_ms_max: 300
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
    assert(pdu.readUInt16LE(0) === 0x5452, 'AES request should decrypt to rate request PDU');

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
    const config = new RClientConfig(tenantConfig, { timeoutMs: 500, retryAttempts: 1 });
    
    const client = new RClient(config);
    assert(client.config.timeoutMs === 500, 'Timeout should be configured');
    assert(client.config.tenant.keyId === 12345, 'Tenant ID should be configured');
    
    console.log('✅ Client configuration tests passed');
    callback();
}

function testRateLimitingIntegration(callback) {
    console.log('Testing rate limiting integration...');
    
    const client = createClient(getTargetHost(), 12345);
    const resources = [new ResourceRequest('test_api', 1000, 5, 1)];
    
    // Show discovered servers
    setTimeout(() => {
        const stats = client.getServerStats();
        if (stats.servers && stats.servers.length > 0) {
            console.log(`Discovered servers: ${stats.servers.map(s => `${s.ip || s}:${s.port || '8080'}`).join(', ')}`);
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
    
    const client = createClient(getTargetHost(), 12345);
    let results = [];
    let errors = [];
    let completed = 0;
    const totalRequests = 5;
    
    // Show discovered servers
    setTimeout(() => {
        const stats = client.getServerStats();
        if (stats.servers && stats.servers.length > 0) {
            console.log(`Using servers: ${stats.servers.map(s => `${s.ip || s}:${s.port || '8080'}`).join(', ')}`);
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
    const client = createClient('invalid.nonexistent.domain', 12345);
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
            console.log('1. Start a compatible server on UDP port 8080');
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
