# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.1] - 2026-08-25

### Added
- Format Version 1 Bech32 API-key codec support (13-byte `none` and 45-byte `cookie`/`aes` payloads with 32-bit packed quotas).
- High Availability (`RequestPolicy` & `HaSchedule`) with fixed, linear, and exponential retry schedules.
- Canonical ID calculation utilities (`CanonicalIds.bucketId`, `CanonicalIds.latencyTrackerId`).
- Automated DNS SRV record resolution for `_ratelimitly._udp.<domain>` and `c-${keyId}.p0.ratelimitly.com`.
- Full TypeScript declaration files (`index.d.ts` and `api_key_codec.d.ts`).
- Comprehensive runnable examples in `examples/`.

### Changed
- Backward-compatible property aliases: `bucketId` for `bucketName`, and `serviceId` for `latencyTrackerName` on `ResourceRequest`, `ResourceResult`, `LatencyGuard`, `ServiceLatencyBlock`, and `GuardResult`.
- Safe null handling in `RClient` constructor when key quotas are omitted.

---

## [1.0.0] - 2026-06-01

### Added
- Initial release of RateLimitly JavaScript R-Client.
- UDP binary wire protocol implementation with Little-Endian Buffer encoding.
- AES-256-GCM and Cookie authentication modes.
- Multi-resource atomic rate checks and latency guard evaluation.
- Asynchronous latency reporting (`ServiceLatencyBlock`).
- Zero external runtime dependencies.
