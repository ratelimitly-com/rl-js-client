"use strict";
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const { TrafficCounters, MAX_COUNTER } = require("./traffic");
const { createClient, ResourceRequest, ServiceLatencyBlock, RequestPolicy } = require("./client");
const { encodeApiKey } = require("./api_key_codec");

async function main() {
  const counters = new TrafficCounters();
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "0:0:0:0:0:ffff:7f00:1"]) counters.record("sent", 100, address);
  const before = counters.snapshot();
  assert.equal(before.sent.ipBytes, 400n + 28n + 48n + 28n + 28n);
  assert(Object.isFrozen(before.sent));
  counters.record("sent", MAX_COUNTER, "127.0.0.1");
  assert.equal(counters.snapshot().sent.ipBytes, MAX_COUNTER);
  assert.equal(counters.snapshot().incomplete, true);
  assert.equal(before.sent.datagrams, 4n);

  const key = encodeApiKey("none", 1n, new Uint8Array(), {
    rate_buckets_max: 65536, latency_services_max: 1024, metrics_labels_max: 4096,
    latency_buffer_size_max: 32, dedup_ttl_ms_max: 300, rate_window_size_ms_max: "unlimited",
  });
  const server = dgram.createSocket("udp4");
  await new Promise(resolve => server.bind(0, "127.0.0.1", resolve));
  const client = createClient(key, "example.test");
  client.config.requestPolicy = new RequestPolicy({ unitMs: 50, replayCount: 1, finalReceiveUnits: 0, completionDelivery: false });
  const id = 10 * 2 ** 23 + 1;
  client.servers = [{ ip: "127.0.0.1", port: server.address().port, serverId: id }];
  client.lastDnsRefresh = Date.now();
  const requests = [], replies = [], ports = [];
  let reportReceived;
  const reportDone = new Promise(resolve => { reportReceived = resolve; });
  server.on("message", (packet, remote) => {
    requests.push(packet);
    ports.push(remote.port);
    if (requests.length === 1) return; // require a real replay
    if (requests.length === 3) { reportReceived(); return; }
    assert.deepEqual(requests[0], packet);
    const reply = Buffer.from(packet);
    reply.writeBigUInt64LE(BigInt(id), 4);
    reply[36] = 0; // exercise source-port replacement without resetting totals
    reply.writeUInt16LE(0x3252, 44);
    reply.writeUInt16LE(0, 80);
    for (const response of [Buffer.alloc(4200), reply]) {
      replies.push(response);
      server.send(response, remote.port, remote.address);
    }
  });
  try {
    const result = await new Promise((resolve, reject) => client.checkRateLimit(
      [new ResourceRequest("traffic", 1000, 100, 1)], [],
      (err, result) => err ? reject(err) : resolve(result)));
    assert.equal(result.success, true);
    await new Promise((resolve, reject) => client.reportLatency(
      [new ServiceLatencyBlock({ latencyTrackerName: "traffic", observedLatency: 10, ttlMs: 1000, maxSamples: 10, minSampleThreshold: 5 })],
      err => err ? reject(err) : resolve()));
    await Promise.race([reportDone, new Promise((_, reject) => setTimeout(() => reject(Error("report not delivered")), 1000).unref())]);
    await new Promise(resolve => setImmediate(resolve));
    const stats = client.getTrafficStats();
    assert.equal(stats.sent.datagrams, 3n);
    assert.equal(stats.sent.payloadBytes, BigInt(requests.reduce((n, p) => n + p.length, 0)));
    assert.equal(stats.sent.ipBytes, stats.sent.payloadBytes + 3n * 28n);
    assert.equal(stats.received.datagrams, 2n);
    assert.equal(stats.received.ipBytes, BigInt(replies.reduce((n, p) => n + p.length + 28, 0)));
    assert.equal(stats.incomplete, false);
    assert.notEqual(ports[1], ports[2]);
    client.destroy();
    assert.deepEqual(client.getTrafficStats(), stats);
    assert.throws(() => client._sendDatagram({ send() { throw Error("closed"); } }, Buffer.alloc(5), { ip: "127.0.0.1", port: 9 }, () => {}));
    assert.equal(client.getTrafficStats().sendFailures, 1n);
    assert.equal(client.getTrafficStats().sent.datagrams, 3n);
    let finishSend;
    client._sendDatagram({ send(_p, _port, _ip, cb) { finishSend = cb; } }, Buffer.alloc(5), { ip: "127.0.0.1", port: 9 }, () => {});
    assert.equal(client.getTrafficStats().incomplete, true);
    finishSend(Error("asynchronous send failure"));
    assert.equal(client.getTrafficStats().incomplete, false);
    assert.equal(client.getTrafficStats().sendFailures, 2n);
    assert.equal(client.getTrafficStats().sent.datagrams, 3n);
  } finally {
    client.destroy();
    server.close();
  }
}
main().then(() => console.log("Physical traffic counters: passed"), error => { console.error(error); process.exitCode = 1; });
