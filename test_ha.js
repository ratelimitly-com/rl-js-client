"use strict";

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

async function bindResponder(serverId, delayMs, deficit, resource) {
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  socket.on("message", (request, remote) => {
    setTimeout(() => {
      const response = responsePacket(request, serverId, resource, deficit);
      socket.send(response, remote.port, remote.address);
    }, delayMs);
  });
  return socket;
}

(async () => {
  const resource = new ResourceRequest("bucket", 1000, 100, 1);
  const olderId = 10 * (2 ** 23) + 1;
  const newerId = 20 * (2 ** 23) + 2;
  const older = await bindResponder(olderId, 15, 0, resource);
  const newer = await bindResponder(newerId, 0, 1, resource);
  const tenant = new TenantConfig("example.test", 1n, AuthMethod.NONE, key);
  const client = new RClient(new RClientConfig(tenant, {
    requestPolicy: new RequestPolicy({
      unitMs: 100,
      replayCount: 0,
      finalReceiveUnits: 0,
      completionDelivery: false,
    }),
  }));
  client.servers = [
    { ip: "127.0.0.1", port: older.address().port, serverId: olderId },
    { ip: "127.0.0.1", port: newer.address().port, serverId: newerId },
  ];
  client.lastDnsRefresh = Date.now();
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    client.checkRateLimit([resource], [], (error, decision) => error ? reject(error) : resolve(decision));
  });
  assert.strictEqual(result.serverId, olderId);
  assert.strictEqual(result.success, true);
  assert(Date.now() - started < 100, "oldest response should complete before the round deadline");
  older.close();
  newer.close();
  console.log("HA oldest-response integration test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
