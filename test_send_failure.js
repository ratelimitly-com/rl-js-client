"use strict";

// A dual-stack SRV target expands to one endpoint per address under a single
// server id, so an IPv6 address reaches an IPv4-only host. The rate-request
// socket is udp4, so an IPv6 literal fails the send with EINVAL - deterministic
// and without touching DNS.

const assert = require("assert");
const dgram = require("dgram");
const {
  AuthMethod,
  CanonicalIds,
  RClient,
  RClientConfig,
  RequestPolicy,
  ResourceRequest,
  TenantConfig,
} = require("./client");
const { encodeApiKey } = require("./api_key_codec");

const UNREACHABLE_IP = "100::1";

const quotas = {
  rate_buckets_max: 65536,
  latency_services_max: 1024,
  metrics_labels_max: 4096,
  latency_buffer_size_max: 32,
  dedup_ttl_ms_max: 300,
  rate_window_size_ms_max: 0xffffffff,
};
const key = encodeApiKey("none", 1n, new Uint8Array(0), quotas);

function responsePacket(request, serverId, resource, deficit) {
  const packet = Buffer.alloc(40 + 4 + 8 + 4 + 28);
  let pos = 0;
  packet.writeUInt16LE(0x4c52, pos); pos += 2;
  packet.writeUInt16LE(40, pos); pos += 2;
  packet.writeBigUInt64LE(BigInt(serverId), pos); pos += 8;
  request.subarray(12, 28).copy(packet, pos); pos += 16;
  packet.writeBigUInt64LE(BigInt(Date.now()), pos); pos += 8;
  packet.writeUInt8(1, pos++);
  packet.writeUInt8(0, pos++);
  packet.writeUInt16LE(0, pos); pos += 2;
  packet.writeUInt16LE(0x414e, pos); pos += 2;
  packet.writeUInt16LE(4, pos); pos += 2;
  packet.writeUInt16LE(0x5252, pos); pos += 2;
  packet.writeUInt16LE(40, pos); pos += 2;
  packet.writeUInt32LE(0, pos); pos += 4;
  packet.writeUInt16LE(0, pos); pos += 2;
  packet.writeUInt16LE(1, pos); pos += 2;
  CanonicalIds.bucketId(resource.bucketName, resource.windowSizeMs, resource.rateLimit).copy(packet, pos);
  pos += 16;
  packet.writeUInt32LE(resource.windowSizeMs, pos); pos += 4;
  packet.writeUInt32LE(100, pos); pos += 4;
  packet.writeUInt16LE(deficit, pos); pos += 2;
  packet.writeUInt16LE(0, pos);
  return packet;
}

async function bindResponder(serverId, resource) {
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  socket.on("message", (request, remote) => {
    socket.send(responsePacket(request, serverId, resource, 0), remote.port, remote.address);
  });
  return socket;
}

function makeClient(servers) {
  const tenant = new TenantConfig("example.test", 1n, AuthMethod.NONE, key);
  const client = new RClient(new RClientConfig(tenant, {
    requestPolicy: new RequestPolicy({
      unitMs: 100,
      replayCount: 0,
      finalReceiveUnits: 0,
      completionDelivery: false,
    }),
  }));
  client.servers = servers;
  client.lastDnsRefresh = Date.now();
  return client;
}

function checkRateLimit(client, resource) {
  return new Promise((resolve, reject) => {
    client.checkRateLimit([resource], [], (error, decision) => (
      error ? reject(error) : resolve(decision)
    ));
  });
}

(async () => {
  const resource = new ResourceRequest("bucket", 1000, 100, 1);
  const reachableId = 10 * (2 ** 23) + 1;
  const unreachableId = 20 * (2 ** 23) + 2;

  // The unreachable endpoint is listed first, so a successful request proves
  // the send loop continued past its failure instead of aborting there.
  const responder = await bindResponder(reachableId, resource);
  const survives = makeClient([
    { ip: UNREACHABLE_IP, port: 9, serverId: unreachableId },
    { ip: "127.0.0.1", port: responder.address().port, serverId: reachableId },
  ]);
  const decision = await checkRateLimit(survives, resource);
  assert.strictEqual(decision.serverId, reachableId);
  assert.strictEqual(decision.success, true);
  responder.close();
  console.log("unreachable endpoint does not abort the request: passed");

  // Every endpoint failing is still an error: nothing reached the network.
  const doomed = makeClient([
    { ip: UNREACHABLE_IP, port: 9, serverId: unreachableId },
  ]);
  await assert.rejects(
    () => checkRateLimit(doomed, resource),
    (error) => {
      assert(error instanceof Error, "expected the send error to surface");
      return true;
    }
  );
  console.log("request fails when every endpoint is unreachable: passed");

  console.log("Per-endpoint send-failure tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
