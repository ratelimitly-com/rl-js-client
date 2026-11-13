# Wide rate windows (source support, unreleased)

Set `wideRateRequests: true` in client options, or explicitly on `TenantConfig`,
only for a server with capability bit 5. A request with any >uint32 window uses
QW/RW; all-short requests keep RT/RR. CanonicalIds retains short v1 identities
inside mixed packets. Windows must be safe integral finite milliseconds, at most
31536000000; unlimited is a cap, not a request or timeout.

`decodeApiKey` retains its v1-only numeric result and rejects v2 with a reader hint.
Use additive `decodeApiKeyVersioned` to dispatch formats 1/2 truthfully. The
exported legacy `Quotas` interfaces remain numeric. Client `quotas` stays numeric
for v1 and is null for v2; `versionedQuotas` exposes full metadata to opt-in
consumers. V1 quota JSON is unchanged; v2 window caps
are `{kind:'finite', milliseconds:N}` or `{kind:'unlimited'}`. Inspect the format
before consuming the versioned cap. `encodeApiKey(..., quotas, 2)` explicitly
selects v2; omitted version remains 1. Tagged v2 data is never silently encoded
with the legacy writer. Type declarations include both cap shapes.

Guards, latency reports and dedup fields remain narrow. Retries preserve the
same PDU; no automatic fallback. No release, migration or server rollout claimed.
Run `npm test`; its existing external-server smoke cases may self-skip.
