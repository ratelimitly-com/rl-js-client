# Architecture, Wire Format & Conformance

`ratelimitly-client` is a zero-dependency pure Node.js implementation of the RateLimitly distributed admission control protocol. It is 100% wire-compatible with `rl-c-client`, `rl-rust-client`, and `rl-python-client`.

---

## High-Level Architecture

```text
+-------------------------------------------------------------+
|                      Node.js Application                    |
+-------------------------------------------------------------+
                              |
               checkRateLimit() / reportLatency()
                              v
+-------------------------------------------------------------+
|               RClient (ratelimitly-client)                  |
|  - Request Correlation by 16-byte random Request ID        |
|  - Lock-Free Unified HA Policy Engine                       |
|  - Monotonic Dynamic Source-Port Steering (49152..65535)   |
|  - AES-256-GCM Cryptographic Authenticator (AAD + CSPRNG)  |
+-------------------------------------------------------------+
                              |
                     UDP Datagrams (<= 1200 B)
                              v
        +---------------------------------------------+
        |   RateLimitly Anycast / Regional Cluster    |
        |      (s-<server-id>.p0.ratelimitly.com)     |
        +---------------------------------------------+
```

---

## Datagram Envelope Structure

All binary integers are little-endian. Datagram sizes are capped at 1,200 bytes to avoid MTU path fragmentation.

```text
+-------------------------------------------------------------+
| Tenant Header TLV (40 bytes)                                |
|   0x00..0x01: TLV Type = 0x4C52 (TLV_TENANT)                |
|   0x02..0x03: TLV Size = 40                                 |
|   0x04..0x0B: Tenant Key ID (req) / Server ID (resp) (u64)  |
|   0x0C..0x1B: Request ID (16 bytes random UUID-v4 shape)    |
|   0x1C..0x23: Unix Timestamp (milliseconds) (u64)          |
|   0x24:       Steering Feedback (u8: 0=rebind, 1=keep)      |
|   0x25:       Tenant Management Flag (u8)                   |
|   0x26..0x27: Alignment Padding (2 zero bytes)             |
+-------------------------------------------------------------+
| Authentication TLV                                          |
|   NONE:   Type=0x414E, Size=4                               |
|   COOKIE: Type=0x4143, Size=36 (4B header + 32B cookie)     |
|   AES:    Type=0x4541, Size=32 (4B header + 12B nonce + 16B)|
+-------------------------------------------------------------+
| Protocol Data Unit (PDU) [Plaintext or AES-GCM Ciphertext]  |
|   0x00..0x01: PDU Type (0x5452=Req, 0x5252=Resp, 0x524C=Rep)|
|   0x02..0x03: PDU Size (uint16)                             |
|   0x04..0x07: Dedup TTL / Horizon (uint32 ms)               |
|   0x08..0x09: Guard Count (uint16)                          |
|   0x0A..0x0B: Resource Count (uint16)                       |
|   ... Guard Blocks (36 bytes each)                          |
|   ... Resource Blocks (28 bytes each)                       |
|   ... Optional Metrics Label TLV (Type 0x4C4D)              |
+-------------------------------------------------------------+
```

---

## Cryptographic Authentication (AES-256-GCM)

1. **Nonce Generation**: Every outbound datagram generates a cryptographically secure 12-byte nonce using `crypto.randomBytes(12)`.
2. **Authenticated Associated Data (AAD)**: The entire 40-byte Tenant Header, 4-byte Auth Header, and 12-byte nonce are bound into the AAD:
   $$\text{AAD} = \text{TenantHeader} \mathbin{\Vert} \text{AuthHeader} \mathbin{\Vert} \text{Nonce}$$
3. **Payload Protection**: The inner PDU is encrypted with AES-256-GCM. The 16-byte authentication tag is written directly to the datagram header.
4. **Decryption Verification**: Inbound responses verify the 16-byte authentication tag before any PDU fields are read. Malformed or tampered packets fail immediately.

---

## Monotonic Source-Port Steering

When backend capacity rebalances, RateLimitly nodes return `steeringFeedback === false` in response datagrams.

The client adheres to deterministic source-port steering:
1. **IANA Dynamic Range**: Restricts binds to $49152 \dots 65535$ ($16,384$ ports).
2. **Monotonic Progression**: Computes candidate $P_{next} = \text{nextSteeringPort}(P_{current})$. Wraps $65535 \to 49152$.
3. **Candidate Scanning**: Skips occupied ports (`EADDRINUSE`, `EACCES`, Windows `10048`, `10013`) through the full range. **Never falls back to port 0**.
4. **Drain-before-Rebind**: In-flight requests on the active socket drain to zero before the replacement socket becomes active.
5. **Exclusive Binds**: Binds with `exclusive: true` to prevent Windows socket hijacking (`SO_EXCLUSIVEADDRUSE`).
