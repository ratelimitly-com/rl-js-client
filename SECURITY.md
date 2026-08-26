# Security Policy

## Reporting Security Issues

Please **do not** report security vulnerabilities through public GitHub issues.

If you believe you have found a security vulnerability in the RateLimitly JavaScript client, please report it via email to:

```text
wojciech@ratelimitly.com
```

Please include:
- Affected version or commit hash
- Operating system and Node.js runtime version
- Detailed description of the vulnerability
- Step-by-step reproduction instructions or proof-of-concept
- Any relevant logs or packet captures with sensitive secrets redacted

You will receive an acknowledgment within 48 hours and regular updates on remediation progress.

---

## Credential & Secret Handling

RateLimitly Bech32 API keys (`rl-cookie...`, `rl-aes...`) contain embedded authentication secrets:

- **Never log or print API keys or raw secrets**: Do not log `authSecret`, `authKey`, or `RATELIMITLY_AUTH_KEY` environment values.
- **Environment-based Delivery**: Prefer providing keys via environment variables (`RATELIMITLY_AUTH_KEY`) rather than command-line arguments, as `argv` may be visible in process tables (`ps`) and shell history.
- **Zero-Dependency Security**: `ratelimitly-client` has **zero external runtime dependencies**, minimizing supply-chain vulnerability attack surfaces.

---

## Authentication Modes & Threat Model

| Mode | Format Prefix | Confidentiality | Packet Integrity | Replay Protection | Recommended Deployment |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **AES-256-GCM** | `rl-aes1...` | Encrypted PDU | Yes (Authenticated Data) | Bound to GCM Tag | **Public & Multi-Tenant Networks** |
| **Cookie** | `rl-cookie1...` | Plaintext | No | Plaintext Match | **Private / VPC Networks Only** |
| **None** | `rl-none1...` | Plaintext | No | Plaintext Match | **Local / Testing Only** |

### AES-256-GCM Mode
- Encrypts the request protocol data unit (PDU) and authenticates the entire datagram by binding clear header fields (`keyId`, `requestId`, `timestamp`, `flags`) as Associated Authenticated Data (AAD).
- Uses Node.js native `crypto.randomBytes(12)` to generate a cryptographically secure, unpredictable 96-bit GCM nonce for every datagram.
- In accordance with NIST SP 800-38D guidelines for random-nonce GCM, keys should be rotated before approaching $2^{32}$ encryptions across all instances sharing a key.

### Cookie Mode
- Intended strictly for trusted, private networks where passive eavesdropping and on-path modification are outside the threat model.
- Transmits a 32-byte secret token in plaintext within the datagram header.

---

## Response Replay & Correlation Boundary

- Every request is tagged with a unique 64-bit random identifier (`requestId`).
- Responses are accepted **only** while a matching request is actively in flight. Once a request completes or times out, late-arriving packets for that `requestId` are discarded.
- In AES mode, the server's response binds the `requestId`, `serverId`, `timestamp`, and steering feedback to the GCM authentication tag, preventing on-path tampering or cross-request retargeting.
- Unauthenticated or corrupted packets fail verification silently or are blackholed by design, surfacing to the application as timeouts to prevent side-channel timing analysis.

---

## Supported Versions

| Version | Supported | Notes |
| :--- | :--- | :--- |
| `1.0.x` | ✅ Yes | Active release branch (Format v1 packed quotas & HA policy) |
| `< 1.0.0` | ❌ No | Pre-release |
