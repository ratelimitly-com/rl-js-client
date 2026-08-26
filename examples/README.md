# RateLimitly JavaScript Client Examples

This directory contains standalone, runnable code examples demonstrating common usage patterns with `ratelimitly-client`.

---

## Examples Index

| Example | File | Description |
| :--- | :--- | :--- |
| **1. Basic Rate Limiting** | [`01_basic_rate_limiting.js`](01_basic_rate_limiting.js) | Standard single-resource rate check with callbacks |
| **2. Multi-Resource Atomic** | [`02_multi_resource_atomic.js`](02_multi_resource_atomic.js) | Atomic multi-tier limit checking (global + user + org) |
| **3. Latency Guards & Reporting** | [`03_latency_guards_and_reporting.js`](03_latency_guards_and_reporting.js) | Downstream load shedding and async latency metrics |
| **4. Promise & Async/Await** | [`04_promise_async_await.js`](04_promise_async_await.js) | Promise-based wrappers for async/await frameworks |
| **5. High Availability Policy** | [`05_high_availability_policy.js`](05_high_availability_policy.js) | Custom retry schedules and failure tolerance |
| **6. API Key Codec** | [`06_api_key_codec.js`](06_api_key_codec.js) | Decoding Bech32 API keys, quotas, and key IDs |

---

## Running the Examples

### With your API Key:
Set the `RATELIMITLY_AUTH_KEY` environment variable:

```bash
RATELIMITLY_AUTH_KEY="rl-aes1..." node examples/01_basic_rate_limiting.js
```

### Running the API Key Codec demo:
```bash
node examples/06_api_key_codec.js
```
