# RateLimitly JavaScript R-Client

A comprehensive Node.js client library for RateLimitly centralized rate limiting and load shedding.

## Overview

The JavaScript R-Client provides a callback-based interface for applications to:
- **Gate resource access** through centralized rate limiting
- **Report latency metrics** for intelligent load shedding
- **Handle High Availability** scenarios with multiple servers
- **Integrate seamlessly** with Node.js applications

## Quick Start

### Installation

```bash
# Copy client files to your project
cp client.js your_project/
cp api_key_codec.js your_project/
cp package.json your_project/  # Optional for npm integration
```

### Basic Usage

```javascript
const { createClient, ResourceRequest, ServiceLatencyBlock } = require('./client.js');

// Create client
const client = createClient('ratelimitly.example.com', 12345);

// Check rate limit
const resources = [new ResourceRequest('api_calls', 60000, 1000, 1)];

client.checkRateLimit(resources, (error, result) => {
    if (error) {
        handleRateLimitError(error);
        return;
    }

    if (!result.success) {
        handleRateLimitExceeded();
        return;
    }

    performApiCall(() => {
        const block = new ServiceLatencyBlock({
            latencyTrackerName: 'api_service',
            observedLatency: 85.5,
            ttlMs: 10000,
            maxSamples: 100,
            bufferSize: 20,
            minSampleThreshold: 8
        });
        client.reportLatency([block], () => {});
    });
});
```

## Features

### ✅ **Complete Wire Protocol Support**
- Full MVP protocol implementation
- All authentication methods (None, Cookie, AES-256-GCM)
- Cookie/AES credentials provided as tenant Bech32 keys (`rl-cookie...`, `rl-aes...`) with embedded quotas
- Guards and resources with atomic processing
- Little-endian binary encoding with Buffer API

### ✅ **High Availability**
- DNS-based server discovery with async resolution
- Multi-server request distribution
- Server stability tracking with time-based validation
- Automatic failover logic with first valid response wins (auth/correlation/trust checks)

### ✅ **Modern JavaScript**
- ES6+ compatible implementation
- Optional Promise wrappers can be added by callers
- BigInt support for 64-bit integers
- Modern Node.js Buffer and dgram APIs

### ✅ **Production Ready**
- Comprehensive error handling with custom error types
- Configurable timeouts and retries
- Built-in logging and debugging
- Memory efficient with automatic cleanup
- Optional `RCLIENT_DNS_SERVER=127.0.0.1[:port]` override for local dnsmasq/SRV testing

## API Reference

### Core Classes

#### `RClient`
Main client class for rate limiting operations.

```javascript
class RClient {
    constructor(config)
    checkRateLimit(resources, guards = [], metricsLabel = null, callback)
    reportLatency(serviceLatencyBlocks, callback)
    getServerStats()
}
```

#### `ResourceRequest`
Defines a rate-limited resource.

```javascript
class ResourceRequest {
    constructor(bucketName, windowSizeMs, rateLimit, tokensRequested)
}
```

#### `LatencyGuard`
Defines a latency threshold guard.

```javascript
class LatencyGuard {
    constructor(config)
}

// Usage
const guard = new LatencyGuard({
    latencyTrackerName: 'database',
    thresholdMs: 100,
    ttlMs: 10000,
    maxSamples: 100,
    bufferSize: 20,
    minSampleThreshold: 8
});
```

#### `ServiceLatencyBlock`
Defines a latency reporting block.

```javascript
class ServiceLatencyBlock {
    constructor(config)
}

// Usage
const block = new ServiceLatencyBlock({
    latencyTrackerName: 'database',
    observedLatency: 85.5,
    ttlMs: 10000,
    maxSamples: 100,
    bufferSize: 20,
    minSampleThreshold: 8
});
```

#### Content-defined IDs

The public request objects accept names, not precomputed wire IDs. The client
derives each 16-byte identifier from the name and the complete definition of
the corresponding server-side state:

- bucket ID: `bucketName`, `windowSizeMs`, and `rateLimit`;
- latency-tracker ID: `latencyTrackerName`, `ttlMs`, `maxSamples`,
  `bufferSize`, and `minSampleThreshold`.

`thresholdMs` is a guard condition and `observedLatency` is a sample, so neither
participates in latency-tracker identity. A guard and a report with the same
tracker name and stored-state settings therefore use the same ID. Changing any
identity-defining setting creates a different bucket or tracker.

`CanonicalIds.bucketId(...)` and `CanonicalIds.latencyTrackerId(...)` expose
the same derivation for code that needs the exact 16-byte `Buffer`.

#### `RateLimitResult`
Result of a rate limit check.

```javascript
class RateLimitResult {
    constructor(success, guardResults, resourceResults, serverId)
}
```

### Configuration

#### `TenantConfig`
Tenant-specific configuration.

```javascript
class TenantConfig {
    constructor(dnsName, keyId, authMethod = AuthMethod.NONE, authSecret = null, servers = null, steeringFeedback = false)
}
```

`authSecret` MUST be a tenant Bech32 key for `COOKIE` and `AES_GCM`.
`dnsName` MUST be an SRV hostname. Direct IP targets such as `127.0.0.1` are rejected.

#### `RClientConfig`
Client configuration options.

```javascript
class RClientConfig {
    constructor(tenant, options = {
        timeoutMs: 1000,
        retryAttempts: 2,
        serverStabilityThresholdMs: 30000,
        dnsRefreshIntervalS: 300
    })
}
```

### Authentication Methods

```javascript
const AuthMethod = {
    NONE: 'none',
    COOKIE: 'cookie',
    AES_GCM: 'aes_gcm'
};
```

## Usage Patterns

### 1. Basic Rate Limiting

```javascript
const client = createClient('ratelimitly.example.com', 12345);

const resources = [new ResourceRequest('api_calls', 60000, 1000, 1)];
client.checkRateLimit(resources, (error, result) => {
    if (error) throw error;
    if (result.success) {
        performOperation();
    }
});
```

### 2. With Latency Guards

```javascript
const resources = [new ResourceRequest('db_queries', 1000, 100, 1)];
const guards = [new LatencyGuard({
    latencyTrackerName: 'database',
    thresholdMs: 50.0,
    ttlMs: 10000,
    maxSamples: 100,
    bufferSize: 20,
    minSampleThreshold: 8
})];

client.checkRateLimit(resources, guards, (error, result) => {
    if (error) throw error;
    if (result.success) {
        const start = Date.now();
        queryDatabase(() => {
            const latency = Date.now() - start;
            
            const block = new ServiceLatencyBlock({
                latencyTrackerName: 'database',
                observedLatency: latency,
                ttlMs: 10000,
                maxSamples: 100,
                bufferSize: 20,
                minSampleThreshold: 8
            });
            client.reportLatency([block], () => {});
        });
    });
});
```

### 3. Authentication

```javascript
const tenantConfig = new TenantConfig(
    'ratelimitly.example.com',
    12345,
    AuthMethod.COOKIE,
    'rl-cookie1xgyszqqqqqqqqdhgpkk3494ftjv7qdvxhft7eaynq9funnhld00xxv2llt6gjrmjqqqqzqqqqsqqqqqsqqqyqqqqqqzu884g'
);

const config = new RClientConfig(tenantConfig);
const client = new RClient(config);
```

### 4. Promise Wrapper Pattern

```javascript
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

function reportLatencyAsync(client, blocks) {
    return new Promise((resolve, reject) => {
        client.reportLatency(blocks, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

const result = await checkRateLimitAsync(client, resources);
if (result.success) {
    await reportLatencyAsync(client, [block]);
}
```

### 5. Context Pattern

```javascript
async function rateLimitedOperation(client, bucketName, limit, operation) {
    const resources = [new ResourceRequest(bucketName, 60000, limit, 1)];
    const result = await checkRateLimitAsync(client, resources);
    
    if (!result.success) {
        throw new Error(`Rate limit exceeded for ${bucketName}`);
    }
    
    const start = Date.now();
    await operation();
    
    const latency = Date.now() - start;
    const block = new ServiceLatencyBlock({
        latencyTrackerName: bucketName,
        observedLatency: latency,
        ttlMs: 10000,
        maxSamples: 100,
        bufferSize: 20,
        minSampleThreshold: 8
    });
    await reportLatencyAsync(client, [block]);
}

// Usage
await rateLimitedOperation(client, 'file_uploads', 10, async () => {
    await uploadFile();
});
```

### 6. Bulk Operations

```javascript
const resources = [
    new ResourceRequest('read_ops', 1000, 1000, 10),
    new ResourceRequest('write_ops', 1000, 100, 2),
    new ResourceRequest('admin_ops', 60000, 10, 1)
];

const guards = [
    new LatencyGuard({
        latencyTrackerName: 'primary_db',
        thresholdMs: 50.0,
        ttlMs: 10000,
        maxSamples: 100,
        bufferSize: 20,
        minSampleThreshold: 8
    }),
    new LatencyGuard({
        latencyTrackerName: 'cache',
        thresholdMs: 10.0,
        ttlMs: 10000,
        maxSamples: 100,
        bufferSize: 20,
        minSampleThreshold: 8
    })
];

const result = await checkRateLimitAsync(client, resources, guards);
```

## Error Handling

```javascript
const { RateLimitError, TimeoutError, AuthenticationError } = require('./client.js');

try {
    const result = await checkRateLimitAsync(client, resources);
} catch (error) {
    if (error instanceof TimeoutError) {
        // Handle timeout
        console.warn('Rate limit check timed out');
    } else if (error instanceof AuthenticationError) {
        // Handle auth failure
        console.error('Authentication failed');
    } else if (error instanceof RateLimitError) {
        // Handle other rate limit errors
        console.error(`Rate limit error: ${error.message}`);
    }
}
```

## High Availability

The client automatically handles HA scenarios:

- For mutating operations, commit safety MUST be preserved (single effective commit authority, or strongly consistent shared state).
- Response acceptance SHOULD require auth/tag validity, request correlation (`unique_id`), and trusted-server validation.

```javascript
// HA configuration
const config = new RClientConfig(tenantConfig, {
    serverStabilityThresholdMs: 30000,  // 30s stability requirement
    dnsRefreshIntervalS: 300            // 5min DNS refresh
});

const client = new RClient(config);

// Monitor server health
const stats = client.getServerStats();
console.log(`Servers: ${stats.servers}`);
console.log(`Stable: ${stats.stableServers}`);
```

## Testing

### Unit Tests

```bash
node test_client.js
```

### Integration Tests

```bash
# Start any compatible Ratelimitly server on UDP port 8080
# Ensure your SRV hostname resolves, for example:
#   export RCLIENT_TARGET_HOST=ratelimitly.local
#   export RCLIENT_DNS_SERVER=127.0.0.1

# Run client tests
node test_client.js

# Run examples
node example_usage.js
```

### Performance Testing

```javascript
const client = createClient('ratelimitly.example.com', 12345);
const resources = [new ResourceRequest('perf_test', 1000, 10000, 1)];

// Measure latency
const start = Date.now();
for (let i = 0; i < 1000; i++) {
    await checkRateLimitAsync(client, resources);
}
const end = Date.now();

const avgLatency = (end - start) / 1000;
console.log(`Average client latency: ${avgLatency}ms`);
```

## Dependencies

- **Node.js 14+**: Required for BigInt and modern JavaScript support
- **Standard Library Only**: No external dependencies
- **Built-in Modules**: `dgram`, `crypto`, `dns`

## Thread Safety

JavaScript is single-threaded, but the client handles concurrent operations:

```javascript
// Concurrent requests are handled properly
const promises = [];
for (let i = 0; i < 10; i++) {
    const resources = [new ResourceRequest(`concurrent_${i}`, 1000, 100, 1)];
    promises.push(checkRateLimitAsync(client, resources));
}

const results = await Promise.all(promises);
console.log(`Completed ${results.length} concurrent requests`);
```

## Monitoring and Metrics

### Built-in Statistics

```javascript
const stats = client.getServerStats();
// Returns:
// {
//   servers: ['10.0.1.1', '10.0.1.2'],
//   stableServers: [123, 456],
//   lastDnsRefresh: 1640995200000
// }
```

### Custom Metrics Integration

```javascript
class MetricsClient extends RClient {
    checkRateLimit(resources, guards, metricsLabel, callback) {
        const start = Date.now();
        super.checkRateLimit(resources, guards, metricsLabel, (error, result) => {
            const latency = Date.now() - start;
            this.recordMetric('rate_limit_latency', latency);
            this.recordMetric(error ? 'rate_limit_error' : 'rate_limit_success', 1);
            callback(error, result);
        });
    }
    
    recordMetric(name, value) {
        // Integrate with your metrics system
        console.log(`Metric ${name}: ${value}`);
    }
}
```

## Best Practices

1. **Reuse Client Instances**: Create once, use many times
2. **Handle Errors Gracefully**: Always handle callback errors, or wrap the API in promises consistently
3. **Report Latencies**: Help the system make better load shedding decisions
4. **Configure Timeouts**: Set appropriate timeouts for your use case
5. **Monitor Server Health**: Use `getServerStats()` for monitoring
6. **Use Guards Wisely**: Set realistic latency thresholds
7. **Batch Resources**: Check multiple resources in single request when possible
8. **Use Promise Wrappers Carefully**: If you prefer `async`/`await`, wrap the callback API explicitly

## Troubleshooting

### Common Issues

**DNS Resolution Fails**
```javascript
// The client requires SRV discovery rather than direct A records
const dns = require('dns');
dns.resolveSrv('_ratelimitly._udp.ratelimitly.example.com', (error, records) => {
    console.log(error || records);
});
```

**Timeouts**
```javascript
// Increase timeout
const config = new RClientConfig(tenantConfig, { timeoutMs: 5000 });
```

**Authentication Errors**
```javascript
// Verify tenant configuration
console.log(`Tenant ID: ${config.tenant.keyId}`);
console.log(`Auth method: ${config.tenant.authMethod}`);
```

**No Servers Available**
```javascript
// Check server discovery
const stats = client.getServerStats();
console.log(`Discovered servers: ${stats.servers}`);
```

For local development, point `RCLIENT_TARGET_HOST` at an SRV-enabled hostname such as `ratelimitly.local`
and optionally set `RCLIENT_DNS_SERVER=127.0.0.1[:port]` if you are running a local resolver.

## NPM Integration

```bash
# Install as dependency
npm install

# Run tests
npm test

# Run examples
npm run example
```

This JavaScript R-Client provides a **production-ready, modern interface** for integrating RateLimitly into Node.js applications with **async/await support** and **maximum performance**.
