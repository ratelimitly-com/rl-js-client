#!/usr/bin/env node
/**
 * Example usage of RateLimitly JavaScript R-Client
 * Demonstrates various integration patterns and use cases.
 */

const {
    createClient, RClient, RClientConfig, TenantConfig, AuthMethod,
    ResourceRequest, LatencyGuard, ServiceLatencyBlock
} = require('./client.js');

const DEFAULT_TARGET_HOST = process.env.RCLIENT_TARGET_HOST || 'ratelimitly.local';
const EXAMPLE_COOKIE_KEY = process.env.RCLIENT_EXAMPLE_COOKIE_KEY || '';

function createExampleClient(keyId = 12345) {
    return createClient(DEFAULT_TARGET_HOST, keyId);
}

function checkRateLimitAsync(client, resources, guards = [], metricsLabel = null) {
    return new Promise((resolve, reject) => {
        client.checkRateLimit(resources, guards, metricsLabel, (error, result) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(result);
        });
    });
}

function reportLatencyAsync(client, serviceLatencyBlocks) {
    return new Promise((resolve, reject) => {
        client.reportLatency(serviceLatencyBlocks, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

async function exampleBasicUsage() {
    console.log('🔹 Basic Rate Limiting Example');
    
    // Create client with minimal configuration
    const client = createExampleClient();
    
    // Define resources to check
    const resources = [
        new ResourceRequest('api_calls', 60000, 100, 1) // 100 requests per minute
    ];
    
    try {
        const result = await checkRateLimitAsync(client, resources);
        
        if (result.success) {
            console.log('✅ Rate limit check passed - proceeding with operation');
            await simulateApiCall();
        } else {
            console.log('❌ Rate limit exceeded - request rejected');
            for (const resourceResult of result.resourceResults) {
                if (resourceResult.tokensDeficit > 0) {
                    console.log(`   Resource '${resourceResult.bucketId}' deficit: ${resourceResult.tokensDeficit}`);
                }
            }
        }
    } catch (error) {
        console.error(`Rate limit check failed: ${error.message}`);
    }
}

async function exampleWithGuards() {
    console.log('\n🔹 Rate Limiting with Latency Guards');
    
    const client = createExampleClient();
    
    // Define resources and guards
    const resources = [
        new ResourceRequest('database_queries', 1000, 50, 1),  // 50 queries/second
        new ResourceRequest('cache_operations', 1000, 1000, 5) // 1000 cache ops/second, need 5
    ];
    
    const guards = [
        new LatencyGuard({
            serviceId: 'database',
            thresholdMs: 100.0,
            ttlMs: 10000,
            maxSamples: 100,
            bufferSize: 20,
            minSampleThreshold: 8
        }),
        new LatencyGuard({
            serviceId: 'cache_service',
            thresholdMs: 10.0,
            ttlMs: 10000,
            maxSamples: 100,
            bufferSize: 20,
            minSampleThreshold: 8
        })
    ];
    
    try {
        const result = await checkRateLimitAsync(client, resources, guards);
        
        console.log(`Overall success: ${result.success}`);
        
        // Check guard results
        for (const guardResult of result.guardResults) {
            const status = guardResult.passed ? '✅ PASS' : '❌ FAIL';
            console.log(`Guard '${guardResult.serviceId}': ${status} ` +
                       `(current: ${guardResult.currentLatencyMs}ms, ` +
                       `threshold: ${guardResult.thresholdMs}ms)`);
        }
        
        // Check resource results
        for (const resourceResult of result.resourceResults) {
            if (resourceResult.tokensDeficit === 0) {
                console.log(`Resource '${resourceResult.bucketId}': ✅ Granted`);
            } else {
                console.log(`Resource '${resourceResult.bucketId}': ❌ Deficit ${resourceResult.tokensDeficit}`);
            }
        }
        
        if (result.success) {
            // Simulate operations and report latencies
            const dbStart = Date.now();
            await simulateDatabaseOperation();
            const dbLatency = Date.now() - dbStart;
            
            const dbBlock = new ServiceLatencyBlock({
                serviceId: 'database',
                observedLatency: dbLatency,
                ttlMs: 10000,
                maxSamples: 100,
                bufferSize: 20,
                minSampleThreshold: 8
            });
            await reportLatencyAsync(client, [dbBlock]);
            
            const cacheStart = Date.now();
            await simulateCacheOperation();
            const cacheLatency = Date.now() - cacheStart;
            
            const cacheBlock = new ServiceLatencyBlock({
                serviceId: 'cache_service',
                observedLatency: cacheLatency,
                ttlMs: 10000,
                maxSamples: 100,
                bufferSize: 20,
                minSampleThreshold: 8
            });
            await reportLatencyAsync(client, [cacheBlock]);
            
            console.log(`Reported latencies: DB=${dbLatency}ms, Cache=${cacheLatency}ms`);
        }
    } catch (error) {
        console.error(`Request failed: ${error.message}`);
    }
}

async function exampleAuthentication() {
    console.log('\n🔹 Authentication Example');
    
    // Create client with cookie authentication
    if (!EXAMPLE_COOKIE_KEY) {
        console.log('Skipping auth example: set RCLIENT_EXAMPLE_COOKIE_KEY to a valid rl-cookie key.');
        return;
    }

    const tenantConfig = new TenantConfig(DEFAULT_TARGET_HOST, 12345, AuthMethod.COOKIE, EXAMPLE_COOKIE_KEY);
    const config = new RClientConfig(tenantConfig, {
        timeoutMs: 2000,
        retryAttempts: 3
    });
    
    const client = new RClient(config);
    
    const resources = [new ResourceRequest('authenticated_api', 60000, 1000, 1)];
    
    try {
        const result = await checkRateLimitAsync(client, resources);
        console.log(`Authenticated request: ${result.success ? '✅ Success' : '❌ Failed'}`);
        console.log(`Server ID: ${result.serverId}`);
    } catch (error) {
        console.error(`Authenticated request failed: ${error.message}`);
    }
}

async function rateLimitedOperation(client, bucketId, windowMs = 60000, limit = 100, operation) {
    const resources = [new ResourceRequest(bucketId, windowMs, limit, 1)];
    
    try {
        const result = await checkRateLimitAsync(client, resources);
        if (!result.success) {
            throw new Error(`Rate limit exceeded for ${bucketId}`);
        }
        
        const startTime = Date.now();
        await operation();
        
        // Report operation latency
        const latency = Date.now() - startTime;
        const block = new ServiceLatencyBlock({
            serviceId: bucketId,
            observedLatency: latency,
            ttlMs: 10000,
            maxSamples: 100,
            bufferSize: 20,
            minSampleThreshold: 8
        });
        await reportLatencyAsync(client, [block]);
        
    } catch (error) {
        console.error(`Rate limited operation failed: ${error.message}`);
        throw error;
    }
}

async function exampleContextPattern() {
    console.log('\n🔹 Context Pattern Example');
    
    const client = createExampleClient();
    
    try {
        await rateLimitedOperation(client, 'file_uploads', 60000, 10, async () => {
            console.log('Performing file upload operation...');
            await simulateFileUpload();
            console.log('✅ File upload completed');
        });
    } catch (error) {
        console.log(`❌ File upload failed: ${error.message}`);
    }
}

async function exampleHighAvailability() {
    console.log('\n🔹 High Availability Example');
    
    // Configure client for HA scenario
    const tenantConfig = new TenantConfig(DEFAULT_TARGET_HOST, 12345);
    const config = new RClientConfig(tenantConfig, {
        timeoutMs: 1000,
        serverStabilityThresholdMs: 5000,  // 5 second stability threshold
        dnsRefreshIntervalS: 60            // Refresh DNS every minute
    });
    
    const client = new RClient(config);
    
    // Make multiple requests to demonstrate HA
    for (let i = 0; i < 3; i++) {
        try {
            const resources = [new ResourceRequest(`ha_test_${i}`, 1000, 100, 1)];
            const result = await checkRateLimitAsync(client, resources);
            
            console.log(`Request ${i+1}: ${result.success ? '✅ Success' : '❌ Failed'} ` +
                       `(Server ID: ${result.serverId})`);
            
            await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
            
        } catch (error) {
            console.log(`Request ${i+1}: ❌ Error - ${error.message}`);
        }
    }
    
    // Show server statistics
    const stats = client.getServerStats();
    console.log(`Server stats: ${stats.servers.length} total, ${stats.stableServers.length} stable`);
}

async function exampleBulkOperations() {
    console.log('\n🔹 Bulk Operations Example');
    
    const client = createExampleClient();
    
    // Check multiple resources at once
    const resources = [
        new ResourceRequest('read_operations', 1000, 1000, 10),   // 10 read tokens
        new ResourceRequest('write_operations', 1000, 100, 2),    // 2 write tokens
        new ResourceRequest('admin_operations', 60000, 10, 1),    // 1 admin token per minute
    ];
    
    const guards = [
        new LatencyGuard({
            serviceId: 'primary_db',
            thresholdMs: 50.0,
            ttlMs: 10000,
            maxSamples: 100,
            bufferSize: 20,
            minSampleThreshold: 8
        }),
        new LatencyGuard({
            serviceId: 'replica_db',
            thresholdMs: 100.0,
            ttlMs: 10000,
            maxSamples: 100,
            bufferSize: 20,
            minSampleThreshold: 8
        }),
    ];
    
    try {
        const result = await checkRateLimitAsync(client, resources, guards);
        
        console.log(`Bulk operation result: ${result.success ? '✅ All passed' : '❌ Some failed'}`);
        
        // Detailed breakdown
        const grantedResources = result.resourceResults.filter(r => r.tokensDeficit === 0);
        const failedResources = result.resourceResults.filter(r => r.tokensDeficit > 0);
        
        console.log(`Resources granted: ${grantedResources.length}/${resources.length}`);
        
        if (failedResources.length > 0) {
            for (const resource of failedResources) {
                console.log(`  ❌ ${resource.bucketId}: deficit ${resource.tokensDeficit}`);
            }
        }
        
        if (result.success) {
            // Perform operations and report latencies
            await simulateBulkOperations();
            await reportLatencyAsync(client, [
                new ServiceLatencyBlock({
                    serviceId: 'primary_db',
                    observedLatency: 45.0,
                    ttlMs: 10000,
                    maxSamples: 100,
                    bufferSize: 20,
                    minSampleThreshold: 8
                }),
                new ServiceLatencyBlock({
                    serviceId: 'replica_db',
                    observedLatency: 85.0,
                    ttlMs: 10000,
                    maxSamples: 100,
                    bufferSize: 20,
                    minSampleThreshold: 8
                })
            ]);
        }
    } catch (error) {
        console.error(`Bulk operation failed: ${error.message}`);
    }
}

async function exampleAsyncAwaitPattern() {
    console.log('\n🔹 Async/Await Pattern Example');
    
    const client = createExampleClient();
    
    try {
        // Sequential operations
        console.log('Sequential operations:');
        for (let i = 0; i < 3; i++) {
            const resources = [new ResourceRequest(`sequential_${i}`, 1000, 100, 1)];
            const result = await checkRateLimitAsync(client, resources);
            console.log(`  Operation ${i+1}: ${result.success ? '✅' : '❌'}`);
        }
        
        // Parallel operations
        console.log('Parallel operations:');
        const parallelPromises = [];
        for (let i = 0; i < 3; i++) {
            const resources = [new ResourceRequest(`parallel_${i}`, 1000, 100, 1)];
            parallelPromises.push(checkRateLimitAsync(client, resources));
        }
        
        const parallelResults = await Promise.all(parallelPromises);
        parallelResults.forEach((result, i) => {
            console.log(`  Operation ${i+1}: ${result.success ? '✅' : '❌'}`);
        });
        
    } catch (error) {
        console.error(`Async operations failed: ${error.message}`);
    }
}

// Simulation functions
async function simulateApiCall() {
    return new Promise(resolve => setTimeout(resolve, 20)); // 20ms
}

async function simulateDatabaseOperation() {
    return new Promise(resolve => setTimeout(resolve, 80)); // 80ms
}

async function simulateCacheOperation() {
    return new Promise(resolve => setTimeout(resolve, 5)); // 5ms
}

async function simulateFileUpload() {
    return new Promise(resolve => setTimeout(resolve, 100)); // 100ms
}

async function simulateBulkOperations() {
    return new Promise(resolve => setTimeout(resolve, 50)); // 50ms
}

async function main() {
    console.log('🚀 RateLimitly JavaScript R-Client Examples');
    console.log('='.repeat(50));
    
    console.log('Note: These examples require a running RateLimitly server.');
    console.log('Start any compatible server on UDP port 8080 before running examples.');
    console.log(`Using target host: ${DEFAULT_TARGET_HOST}`);
    console.log('='.repeat(50));
    
    try {
        await exampleBasicUsage();
        await exampleWithGuards();
        await exampleAuthentication();
        await exampleContextPattern();
        await exampleHighAvailability();
        await exampleBulkOperations();
        await exampleAsyncAwaitPattern();
        
        console.log('\n🎉 All examples completed!');
        
    } catch (error) {
        console.error(`\nExamples failed: ${error.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('👋 Examples interrupted:', error.message);
        process.exit(1);
    });
}
