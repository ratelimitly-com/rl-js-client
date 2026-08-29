# JavaScript / TypeScript API Reference

`ratelimitly-client` provides high-performance, zero-dependency Node.js bindings for RateLimitly distributed rate limiting and latency-based load shedding.

---

## Client Lifecycle

### `createClient(authKey, dnsName?, options?)`

Convenience factory initializing an `RClient` from a Bech32 API key string (`rl-none...`, `rl-cookie...`, `rl-aes...`).

```javascript
const { createClient } = require('ratelimitly-client');

const client = createClient(process.env.RATELIMITLY_AUTH_KEY, null, {
  dnsRefreshIntervalS: 300,
  steeringFeedback: true,
});
```

- **`authKey`** (`string`, required): Bech32 API key. The client decodes format version, key ID, authentication secret, and quotas at startup.
- **`dnsName`** (`string | null`, optional): Explicit discovery domain. Defaults to `c-${keyId}.p0.ratelimitly.com`.
- **`options`** (`object`, optional):
  - `requestPolicy` (`RequestPolicy`): High-availability retry policy (defaults to unit=20ms, replay=1).
  - `dnsRefreshIntervalS` (`number`): DNS SRV background refresh interval in seconds (default: 300).
  - `steeringFeedback` (`boolean`): Whether to honor source-port steering advisories (default: `true`).

### `client.destroy()`

Closes persistent UDP sockets and cancels background discovery timers.

```javascript
client.destroy();
```

---

## Rate Limiting & Admission Control

### `client.checkRateLimit(resources, guards?, metricsLabel?, callback?)`

Evaluates rate limit buckets and latency guards in a single atomic UDP datagram. Returns a `Promise<RateLimitResult>` when `callback` is omitted, or invokes `callback(err, result)`.

```javascript
// Native Promise / Async-Await
const result = await client.checkRateLimit(resources, guards, 'checkout_service');

// Node.js Error-First Callback
client.checkRateLimit(resources, guards, 'checkout_service', (err, result) => {
  if (err) handleTransportError(err);
  else handleDecision(result);
});
```

#### Matrix of Operations

| Resources | Guards | Behavior |
| :--- | :--- | :--- |
| **0** | **0** | Local successful no-op; returns `{ success: true }` without network I/O. |
| **1+** | **0** | Rate-bucket consumption check. |
| **0** | **1+** | Pure latency-guard load shedding check. |
| **1+** | **1+** | Atomic composite decision (all buckets granted AND all guards passed). |

---

## Data Models

### `ResourceRequest`

```javascript
new ResourceRequest(bucketName, windowSizeMs, rateLimit, tokensRequested = 1)
```

- **`bucketName`** (`string`): Logical identifier (e.g. `'api_v1'`, `'user:1234'`, `'tenant:cust-42'`).
- **`windowSizeMs`** (`number`): Sliding window duration in milliseconds (bounded by credential quota `rate_window_size_ms_max`).
- **`rateLimit`** (`number`): Maximum tokens allowed across the sliding window.
- **`tokensRequested`** (`number`, optional): Tokens requested (default: `1`).

### `LatencyGuard`

```javascript
new LatencyGuard({
  latencyTrackerName: 'postgres_primary',
  thresholdMs: 50,
  ttlMs: 60000,
  maxSamples: 100,
  minSampleThreshold: 5
})
```

- **`latencyTrackerName`** (`string`): Service or dependency identifier.
- **`thresholdMs`** (`number`): SLA threshold in ms (guard passes when `currentLatency < thresholdMs`).
- **`ttlMs`** (`number`): Rolling window duration in ms.
- **`maxSamples`** (`number`): Sample ceiling.
- **`minSampleThreshold`** (`number`): Minimum samples required before shedding traffic.

### `ServiceLatencyBlock` & `client.reportLatency(blocks, callback?)`

Publishes observed downstream latency samples asynchronously to all r-servers:

```javascript
const block = new ServiceLatencyBlock({
  latencyTrackerName: 'postgres_primary',
  observedLatency: 42, // milliseconds
  ttlMs: 60000,
  maxSamples: 100,
  minSampleThreshold: 5
});

await client.reportLatency([block]);
```

---

## Result Types

### `RateLimitResult`

- **`result.success`** (`boolean`): `true` only if **every** guard passed (`currentLatency < thresholdMs`) **and** **every** resource was admitted (`tokensDeficit === 0`).
- **`result.resourceResults`** (`ResourceResult[]`): Individual resource decisions.
- **`result.guardResults`** (`GuardResult[]`): Individual latency guard outcomes.
- **`result.serverId`** (`number | bigint`): Authenticated server ID that issued the decision.
- **`result.steeringFeedback`** (`boolean`): `true` = keep current source port; `false` = advisory to rotate port.

### `ResourceResult`

- **`resource.bucketName`** (`string`): Bucket name.
- **`resource.tokensDeficit`** (`number`): Shortfall below quota (`0` = granted).
- **`resource.actualRate`** (`number`): Current admitted tokens across the window.

### `GuardResult`

- **`guard.latencyTrackerName`** (`string`): Tracker name.
- **`guard.thresholdMs`** (`number`): Configured threshold.
- **`guard.currentLatencyMs`** (`number`): Current observed latency.
- **`guard.passed`** (`boolean`): `true` if `currentLatencyMs < thresholdMs`.

---

## Canonical Content-Defined Identifiers

To guarantee byte-for-byte cross-language compatibility with C and Rust implementations, canonical 16-byte IDs are generated using BLAKE2s:

```javascript
const { CanonicalIds } = require('ratelimitly-client');

// 16-byte Buffer bucket ID
const bucketId = CanonicalIds.bucketId('login_endpoint', 60000, 100);

// 16-byte Buffer latency tracker ID
const trackerId = CanonicalIds.latencyTrackerId('db_read_replica', 30000, 100, 16, 5);
```

---

## Error Handling

All client errors extend `RateLimitError`:

```javascript
const {
  RateLimitError,
  TimeoutError,
  AuthenticationError,
  ProtocolError
} = require('ratelimitly-client');

try {
  const result = await client.checkRateLimit(resources);
} catch (err) {
  if (err instanceof TimeoutError) {
    // HA policy horizon expired without quorum response
  } else if (err instanceof AuthenticationError) {
    // AES tag verification, credential version, or key mismatch
  } else if (err instanceof ProtocolError) {
    // Quota violation or malformed server response
  }
}
```
