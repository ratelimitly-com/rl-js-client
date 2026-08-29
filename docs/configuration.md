# Configuration & High-Availability Policy

## Bech32 API Key Configuration

RateLimitly credentials encode version, key ID, auth secret, and six operational quotas into a single Bech32 string:

```javascript
const { createClient } = require('ratelimitly-client');

const client = createClient(process.env.RATELIMITLY_AUTH_KEY);
```

### Encoded Quotas

| Quota | Description |
| :--- | :--- |
| `rate_buckets_max` | Maximum active buckets permitted. |
| `latency_services_max` | Maximum latency trackers monitored. |
| `metrics_labels_max` | Maximum metrics labels accepted. |
| `latency_buffer_size_max` | Server-side inline point capacity allocated for every latency-tracker slot; it is not a guard or report field. |
| `dedup_ttl_ms_max` | Maximum deduplication TTL / horizon duration in ms. |
| `rate_window_size_ms_max` | Maximum sliding window duration in ms. |

---

## Unified High-Availability Policy

`ratelimitly-client` implements a single parameterized High Availability engine:

```javascript
const { RequestPolicy, HaSchedule } = require('ratelimitly-client');

const policy = new RequestPolicy({
  unitMs: 20,                          // Base time unit in milliseconds
  replayCount: 1,                      // Number of retry rounds
  replayGap: HaSchedule.fixed(1),      // Gap duration per round in units
  finalReceiveUnits: 1,                // Trailing receive-only quiet period
  completionDelivery: true             // Best-effort replication convergence
});
```

### Deduplication Horizon Formula

$$\text{dedup\_ttl\_ms} = \text{unitMs} \times \left( \sum_{k=0}^{\text{replayCount}} \text{replayGap}(k) + \text{finalReceiveUnits} \right)$$

For the default policy (`unitMs = 20`, `replayCount = 1`, `gap = 1`, `finalReceiveUnits = 1`):
$$\text{dedup\_ttl\_ms} = 20 \times (1 + 1 + 1) = 60\text{ ms}$$

### Predefined Schedules

1. **Fixed Schedule**:
   ```javascript
   const schedule = HaSchedule.fixed(1); // 1 unit every round
   ```
2. **Linear Schedule**:
   ```javascript
   const schedule = HaSchedule.linear(1, 1, 4); // Initial=1, Step=1, Max=4 units
   ```
3. **Exponential Schedule**:
   ```javascript
   const schedule = HaSchedule.exponential(1, 2, 8); // Initial=1, Factor=2, Max=8 units
   ```

---

## DNS Service Discovery

When no explicit DNS target is provided, discovery targets:
```text
_ratelimitly._udp.c-${keyId}.p0.ratelimitly.com
```

- SRV targets matching `s-<serverId>...` are resolved to IPv4 and IPv6 endpoints.
- Server startup timestamp is extracted from `serverId` to prioritize the oldest active server.
- Background refresh runs periodically according to `dnsRefreshIntervalS` (default: 300 seconds).
