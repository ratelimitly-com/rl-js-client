# Physical UDP traffic

`client.getTrafficStats()` returns a frozen lifetime snapshot. `sent` and
`received` contain `datagrams`, `payloadBytes`, `ipBytes`; `sendFailures` counts
failed sends. All numbers are `bigint`, so print them with `String(value)` rather
than JSON's default encoder. Snapshots survive source-port rotation and destroy.

Counts include successful physical UDP sends (replicas, retries, completion
delivery and reports) and all received UDP packets, even invalid/unmatched ones.
DNS is excluded. A failed send adds no sent bytes. `ipBytes` estimates payload
plus 28 bytes for IPv4/mapped IPv4, or 48 for IPv6 (UDP and minimal IP headers).
It excludes Ethernet, IP options and IPv6 extension headers, not a provider bill.

Unsigned 64-bit counters saturate rather than wrap. `incomplete` is true on
saturation, unavailable IP information, or while send callbacks remain pending.
Do not reconcile an incomplete snapshot. A client may stop listening before all
replica replies arrive: server TX can legitimately exceed client RX.
